'use strict';
const lease = require('./lease.cjs');

// ─── §62: 状态单调推进守卫 + provider_event_anomaly 记录 ───
// Provider normalized status rank: terminal (success/failed) must never regress
// to a non-terminal state (RUNNING→SUCCEEDED→RUNNING 的最后 RUNNING 被拒绝).
// (L20; 并入 reconciler 单写者, 不改其它文件)
const PROVIDER_STATUS_RANK = Object.freeze({
  unknown: 0,
  not_found: 0,
  pending: 1,
  running: 2,
  success: 3,
  failed: 3,
});

function isTerminalRegression(currentStatus, incomingStatus) {
  const cur = PROVIDER_STATUS_RANK[currentStatus] ?? 0;
  const inc = PROVIDER_STATUS_RANK[incomingStatus] ?? 0;
  return cur >= 3 && inc < cur;
}

// Append-only anomaly row。裁决(父线修正 2026-09-05): anomaly 是内部审计事件,
// 需要保留 payload(detail/from/to), 故仍落 generation_outbox_v2 作 append-only 存储;
// publishOutbox 消费端按 event_type='provider_event_anomaly' 显式跳过(见下), 永不被
// 对外发布或重试——队列职责分离由消费端过滤保证。generation_events(L13) 无 payload
// 列(仅 payload_hash), 不适合承载 anomaly detail。
async function recordProviderEventAnomaly(pg, anomaly) {
  if (!pg || typeof pg.query !== 'function') throw new TypeError('pg.query required');
  const {
    itemId, jobId = null, attemptId = null,
    providerId = null, providerRequestId = null,
    fromStatus = null, toStatus = null, reason = null, detail = null,
  } = anomaly || {};
  if (!itemId) throw new TypeError('anomaly.itemId required');
  const r = await pg.query(
    `INSERT INTO generation_outbox_v2 (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, 'provider_event_anomaly', $3::jsonb)
     RETURNING event_id`,
    ['generation_item', itemId, JSON.stringify({
      item_id: itemId, job_id: jobId, attempt_id: attemptId,
      provider_id: providerId, provider_request_id: providerRequestId,
      from_status: fromStatus, to_status: toStatus, reason, detail,
    })],
  );
  return r.rows && r.rows[0] ? r.rows[0] : null;
}

// ─── §52-54, §152: SUBMIT_UNKNOWN 六步恢复序 ───
// submit 响应丢失后禁止立即重提; 仅在「确认未创建」且等待窗口已过后才允许
// 以同一 client_request_id 再次 submit。六步:
//   1 查 clientRequestToken 支持  2 查 request/tag/payload  3 搜 provider task
//   4 等待可判定窗口              5 reconcile               6 确认未创建才重提
async function recoverSubmitUnknown(pg, item, injected = {}) {
  const deps = {
    transitionItem: lease.transitionItem,
    checkClientRequestTokenSupport: null,
    lookupSubmitPayload: null,
    searchProviderTask: null,
    withinDecidableWindow: null,
    resubmit: null,
    now: () => Date.now(),
    ...injected,
  };
  for (const k of ['checkClientRequestTokenSupport', 'lookupSubmitPayload', 'searchProviderTask', 'withinDecidableWindow', 'resubmit']) {
    if (typeof deps[k] !== 'function') throw new TypeError(`${k} required`);
  }
  const base = { itemId: item.item_id, leaseVersion: Number(item.lease_version) };

  // 1. clientRequestToken / idempotency-key 透传支持
  let tokenSupported = false;
  try { tokenSupported = !!await deps.checkClientRequestTokenSupport(item); } catch (_) { tokenSupported = false; }

  // 2. 原始 submit payload / tag
  let payload = null;
  try { payload = await deps.lookupSubmitPayload(item); } catch (_) { payload = null; }

  // 3. 搜 provider task（按 tag / client_request_id）
  let search = { found: false };
  try { search = await deps.searchProviderTask(item, payload); } catch (e) { search = { found: false, error: e.message }; }

  // 4. 可判定窗口（§152: 禁 timeout 后立即重提; 窗口内仅等待不重提）
  let windowPassed = false;
  try { windowPassed = !!await deps.withinDecidableWindow(item); } catch (_) { windowPassed = false; }

  if (search.found) {
    // 已存在 task → 采纳并交还正常 reconcile, 绝不重提 (§43/§54)
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'reconcile_wait',
      patch: {
        provider_request_id: search.providerRequestId || item.provider_request_id,
        last_error_code: 'SUBMIT_UNKNOWN_ADOPTED',
        last_error: 'provider task found via search; adopted for reconciliation (no resubmit)',
        next_attempt_at: new Date(deps.now() + 15000),
        lease_expires_at: null,
      },
    });
    return row ? { status: 'adopted' } : { status: 'stale_lease' };
  }

  // 未搜到 task。仅当「窗口已过 + 支持 token」才允许重提（§54 步 6）。
  if (windowPassed && tokenSupported) {
    let newRequestId = null;
    try { newRequestId = await deps.resubmit(item, payload); } catch (_) { newRequestId = null; }
    if (newRequestId) {
      const row = await deps.transitionItem(pg, {
        ...base, from: 'reconciling', to: 'generating',
        patch: {
          provider_request_id: newRequestId,
          last_error_code: 'SUBMIT_UNKNOWN_RESUBMIT',
          last_error: 'confirmed not created; resubmitted with same client_request_id',
          lease_expires_at: null,
        },
      });
      return row ? { status: 'resubmitted' } : { status: 'stale_lease' };
    }
    // 重提失败 → 人工复核, 不盲目继续
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'review_required',
      patch: { last_error_code: 'SUBMIT_UNKNOWN', last_error: 'resubmit failed after confirmed not-created', lease_expires_at: null },
    });
    return row ? { status: 'review_required' } : { status: 'stale_lease' };
  }

  // 窗口未过 → 仅等待, 不重提 (§152 禁 timeout 后立即重提)
  if (!windowPassed) {
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'reconcile_wait',
      patch: {
        last_error_code: 'SUBMIT_UNKNOWN',
        last_error: 'within decidable window; waiting before resubmit decision',
        next_attempt_at: new Date(deps.now() + 15000),
        lease_expires_at: null,
      },
    });
    return row ? { status: 'reconcile_wait' } : { status: 'stale_lease' };
  }

  // 窗口已过但 provider 不支持 token → 无法安全重提（可能是 false-negative 搜不到）
  // → 保守转人工复核, 禁止盲目重提 (§52-53)
  const row = await deps.transitionItem(pg, {
    ...base, from: 'reconciling', to: 'review_required',
    patch: {
      last_error_code: 'SUBMIT_UNKNOWN',
      last_error: 'task not confirmed created and no clientRequestToken support; manual review required',
      lease_expires_at: null,
    },
  });
  return row ? { status: 'review_required' } : { status: 'stale_lease' };
}

async function claimReconciling(pg, { workerId, limit = 10, leaseSeconds = 300 } = {}) {
  if (!workerId) throw new TypeError('workerId required');
  const n = Math.max(1, Math.min(100, Number(limit) || 10));
  const s = Math.max(30, Math.min(3600, Number(leaseSeconds) || 300));
  const r = await pg.query(
    `WITH picked AS (
       SELECT item_id FROM generation_items_v2
        WHERE status IN ('reconciling','reconcile_wait')
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
          AND (status='reconciling' OR next_attempt_at <= NOW())
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE generation_items_v2 i
        SET lease_owner=$2, lease_expires_at=NOW()+($3*INTERVAL '1 second'),
            lease_version=i.lease_version+1
       FROM picked WHERE i.item_id=picked.item_id
     RETURNING i.*`,
    [n, workerId, s]);
  return r.rows || [];
}

async function resolveReconcilingItem(pg, item, injected = {}) {
  const deps = { transitionItem: lease.transitionItem, queryProviderStatus: null, recordAnomaly: recordProviderEventAnomaly, ...injected };
  if (typeof deps.queryProviderStatus !== 'function') throw new TypeError('queryProviderStatus required');
  const base = { itemId: item.item_id, leaseVersion: Number(item.lease_version) };
  let providerResult;
  try {
    providerResult = await deps.queryProviderStatus(item.provider_request_id, item);
  } catch (e) {
    providerResult = { status: 'unknown', error: e.message };
  }
  // §62 单调推进守卫: 曾达终态(success/failed)再回到 running/pending/unknown 属回退 → 拒绝并记 anomaly。
  if (isTerminalRegression(item.last_provider_status, providerResult.status)) {
    await deps.recordAnomaly(pg, {
      itemId: item.item_id, jobId: item.job_id, attemptId: item.attempt_id,
      providerId: item.provider_id, providerRequestId: item.provider_request_id,
      fromStatus: item.last_provider_status, toStatus: providerResult.status,
      reason: 'TERMINAL_REGRESSION',
      detail: 'rejected provider event regression on a terminal state (§62)',
    });
    return { status: 'rejected_terminal_regression' };
  }
  // poll 同汇（L19 接线，§138 默认 OFF）：flag on 时 poll 结果经 applyProviderEvent 唯一入口归口；
  // 由 production（entry.cjs reconcileDeps）在 FF_VIDEO_DURABLE_EVENTS=1 时注入
  // { applyProviderEvent, eventStore }（eventStore 用 createEventReducerStore(pg) 构建）。
  // 未注入（默认）→ 走下方旧路径，行为不变。
  if (typeof deps.applyProviderEvent === 'function' && deps.eventStore) {
    const outcome = await deps.applyProviderEvent({
      store: deps.eventStore,
      inbox: null,      // poll 路径无 webhook inbox 行
      event: null,
      normalizedStatus: providerResult,
      providerRequestId: item.provider_request_id,
    });
    if (outcome.outcome === 'reduced') return { status: outcome.to || 'reconcile_wait' };
    return { status: outcome.outcome };
  }
  if (providerResult.status === 'success' && providerResult.providerUrl) {
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'generated',
      patch: { provider_url: providerResult.providerUrl, provider_request_id: item.provider_request_id, lease_expires_at: null },
    });
    return row ? { status: 'generated' } : { status: 'stale_lease' };
  }
  if (providerResult.status === 'failed') {
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'retry_wait',
      patch: { last_error_code: 'PROVIDER_FAILED', last_error: providerResult.error || 'provider reported failure', next_attempt_at: new Date(Date.now() + 30000), lease_expires_at: null },
    });
    return row ? { status: 'retry_wait' } : { status: 'stale_lease' };
  }
  if (providerResult.status === 'pending') {
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'reconcile_wait',
      patch: { last_error_code: 'PROVIDER_PENDING', last_error: 'still processing; reconciliation only', next_attempt_at: new Date(Date.now() + 15000), lease_expires_at: null },
    });
    return row ? { status: 'reconcile_wait' } : { status: 'stale_lease' };
  }
  if (providerResult.status === 'not_found') {
    // Provider 明确无此 task。禁止盲目重提（§52/§54 步 6 需先确认未创建才允许）→ 转人工复核。
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'review_required',
      patch: { last_error_code: 'PROVIDER_TASK_NOT_FOUND', last_error: 'provider reports task not found; manual review before any resubmit', lease_expires_at: null },
    });
    return row ? { status: 'review_required' } : { status: 'stale_lease' };
  }
  // unknown/ambiguous: freeze for human review, do NOT release funds
  const row = await deps.transitionItem(pg, {
    ...base, from: 'reconciling', to: 'review_required',
    patch: { last_error_code: 'RECONCILE_UNKNOWN', last_error: providerResult.error || 'provider status unknown', lease_expires_at: null },
  });
  return row ? { status: 'review_required' } : { status: 'stale_lease' };
}

// ─── poll 同汇 store 适配（L19 接线，§138 默认 OFF）───
// 把 applyProviderEvent 需要的 store 契约（transitionItem + findItemByProviderRequestId）
// 绑定到本模块的 lease.transitionItem 与 generation_items_v2 查询。production（entry.cjs）
// 在 FF_VIDEO_DURABLE_EVENTS=1 时用它构建 eventStore，再注入 resolveReconcilingItem，
// 使 poll 结果经 applyProviderEvent 唯一入口归口；未接线则旧路径不变。
function createEventReducerStore(pg) {
  if (!pg || typeof pg.query !== 'function') throw new TypeError('pg.query is required');
  return {
    transitionItem: (args) => lease.transitionItem(pg, { ...args, workerId: args.workerId || null }),
    findItemByProviderRequestId: async (providerId, providerRequestId) => {
      if (!providerRequestId) return null;
      const r = await pg.query(
        `SELECT * FROM generation_items_v2
          WHERE provider_request_id = $1
            AND ($2::text IS NULL OR provider_id = $2)
          ORDER BY created_at ASC LIMIT 1`,
        [String(providerRequestId), providerId || null],
      );
      return (r.rows && r.rows[0]) || null;
    },
  };
}

async function publishOutbox(pg, { limit = 100, workerId = `outbox-${process.pid}`, leaseSeconds = 60 } = {}, injected = {}) {
  const deps = { publish: null, ...injected };
  if (typeof deps.publish !== 'function') throw new TypeError('publish function required');
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const r = await pg.query(
    `WITH picked AS (
       SELECT event_id FROM generation_outbox_v2
        WHERE published_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
          -- anomaly 审计事件永不对外发布/重试(§62 内部事件; 消费端过滤职责分离)
          AND (event_type IS DISTINCT FROM 'provider_event_anomaly')
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE generation_outbox_v2 o
        SET lease_owner=$2,lease_expires_at=NOW()+($3*INTERVAL '1 second')
       FROM picked WHERE o.event_id=picked.event_id
     RETURNING o.event_id,o.aggregate_id,o.aggregate_type,o.event_type,o.payload,o.created_at`,
    [n,workerId,Math.max(10,Math.min(600,Number(leaseSeconds)||60))]);
  const events = r.rows || [];
  if (!events.length) return { published: 0 };
  let published = 0;
  const delivered = [];
  for (const ev of events) {
    try {
      let payload = ev.payload;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) {} }
      await deps.publish({ ...ev, payload });
      delivered.push(ev.event_id);
      published++;
    } catch (_) { /* leave undelivered; will retry next tick */ }
  }
  if (delivered.length) await markOutboxDelivered(pg, delivered);
  return { published };
}

async function markOutboxDelivered(pg, ids) {
  if (!ids || !ids.length) return { count: 0 };
  const r = await pg.query(
    `UPDATE generation_outbox_v2 SET published_at=NOW(), attempts=attempts+1,lease_owner=NULL,lease_expires_at=NULL
      WHERE event_id=ANY($1::bigint[]) AND published_at IS NULL
      RETURNING event_id`, [ids]);
  return { count: (r.rows || []).length };
}

module.exports = {
  claimReconciling, resolveReconcilingItem, publishOutbox, markOutboxDelivered,
  recoverSubmitUnknown, recordProviderEventAnomaly, isTerminalRegression, PROVIDER_STATUS_RANK,
  createEventReducerStore,
};
