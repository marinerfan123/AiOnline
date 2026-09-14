'use strict';
const crypto = require('crypto');
const lease = require('./lease.cjs');
const retryPolicy = require('./retry-policy.cjs');
const { withLeaseHeartbeat } = require('./lease-heartbeat.cjs');

async function defaultRecordAttempt(pg, row) {
  await pg.query(
    `INSERT INTO generation_item_attempts_v2
      (item_id,attempt_no,lease_version,provider_id,key_id,provider_request_id,status,http_status,error_code,error_message,started_at,finished_at,latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (item_id,attempt_no) DO UPDATE SET
       provider_id=EXCLUDED.provider_id,key_id=EXCLUDED.key_id,
       provider_request_id=EXCLUDED.provider_request_id,status=EXCLUDED.status,
       http_status=EXCLUDED.http_status,error_code=EXCLUDED.error_code,
       error_message=EXCLUDED.error_message,finished_at=EXCLUDED.finished_at,
       latency_ms=EXCLUDED.latency_ms`,
    [row.itemId,row.attemptNo,row.leaseVersion,row.providerId||null,row.keyId||null,row.providerRequestId||null,row.status,row.httpStatus||null,row.errorCode||null,row.errorMessage||null,new Date(row.startedAt),new Date(row.finishedAt),row.finishedAt-row.startedAt],
  );
}

async function processItem(pg, item, injected = {}) {
  const deps = {
    transitionItem: lease.transitionItem,
    decideRetry: retryPolicy.decideRetry,
    recordAttempt: defaultRecordAttempt,
    providerGenerate: null,
    withLeaseHeartbeat,
    workerId: injected.workerId || item.lease_owner,
    leaseSeconds: injected.leaseSeconds || 120,
    ...injected,
  };
  if (typeof deps.providerGenerate !== 'function') throw new TypeError('providerGenerate is required');
  const base = { itemId:item.item_id, leaseVersion:Number(item.lease_version), workerId:deps.workerId };
  const started = await deps.transitionItem(pg, { ...base, from:'leased', to:'generating', patch:{ started_at:new Date() } });
  if (!started) return { status:'stale_lease' };

  const startedAt = Date.now();
  const clientRequestId = `v2-${item.item_id}-${Number(item.attempt_count)||1}-${crypto.randomUUID()}`;
  if (typeof pg.query === 'function') {
    await pg.query(`INSERT INTO generation_item_attempts_v2(item_id,attempt_no,lease_version,client_request_id,status,started_at) VALUES($1,$2,$3,$4,'submitting',NOW()) ON CONFLICT(item_id,attempt_no) DO NOTHING`,[item.item_id,Number(item.attempt_count)||1,Number(item.lease_version),clientRequestId]);
  }
  item.client_request_id = clientRequestId;
  let result;
  try {
    if (deps.workerId) {
      result = await deps.withLeaseHeartbeat(pg, {
        itemId:item.item_id, leaseVersion:Number(item.lease_version), workerId:deps.workerId,
        leaseSeconds:deps.leaseSeconds, states:['generating'],
      }, deps, (signal) => deps.providerGenerate(item, signal));
    } else {
      // 单元/纯函数调用兼容；生产 runWorkerTick 必须注入 workerId 并走 heartbeat。
      result = await deps.providerGenerate(item);
    }
  } catch (e) {
    result = { status:'error', errorCode:e.code||'EXCEPTION', errorMessage:e.message };
  }
  const finishedAt = Date.now();
  await deps.recordAttempt(pg, {
    itemId:item.item_id, attemptNo:Number(item.attempt_count)||1, leaseVersion:Number(item.lease_version),
    providerId:result.providerId, keyId:result.keyId, providerRequestId:result.providerRequestId,
    status:result.status==='success'?'success':'error', httpStatus:result.httpStatus,
    errorCode:result.errorCode, errorMessage:result.errorMessage, startedAt, finishedAt,
  });

  if (result.status === 'success' && result.providerUrl) {
    const row = await deps.transitionItem(pg, { ...base, from:'generating', to:'generated', patch:{
      provider_id:result.providerId||null, key_id:result.keyId||null,
      provider_request_id:result.providerRequestId||null, provider_url:result.providerUrl,
      generated_at:new Date(), lease_expires_at:null,
    }});
    return row ? { status:'generated' } : { status:'stale_lease' };
  }

  const decision = deps.decideRetry({
    attempt:Number(item.attempt_count)||1, httpStatus:result.httpStatus, errorCode:result.errorCode,
    providerRequestId:result.providerRequestId, retryAfter:result.retryAfter,
  });
  const patch = {
    provider_id:result.providerId||null, key_id:result.keyId||null,
    provider_request_id:result.providerRequestId||null,
    last_error_code:result.errorCode||null, last_error:result.errorMessage||null,
    lease_expires_at:null,
  };
  if (decision.nextAttemptAt != null) patch.next_attempt_at = new Date(decision.nextAttemptAt);
  const row = await deps.transitionItem(pg, { ...base, from:'generating', to:decision.status, patch });
  return row ? { status:decision.status, allowRelease:decision.allowRelease } : { status:'stale_lease' };
}

async function runWorkerTick(pg, options = {}, injected = {}) {
  const deps = { claimItems:lease.claimItems, ...injected };
  const workerId = options.workerId;
  if (!workerId) throw new TypeError('workerId is required');
  // P1-06: stop claiming new work when shutting down; let in-flight complete
  if (options.shuttingDown) return { claimed: 0, shuttingDown: true };
  const concurrency = Math.max(1,Math.min(50,Number(options.concurrency)||5));
  const items = await deps.claimItems(pg,{workerId,limit:options.limit||concurrency*2,leaseSeconds:options.leaseSeconds||120});
  const runtimeDeps = {
    ...deps, workerId, leaseSeconds:options.leaseSeconds||120,
    providerGenerate: async (item, signal) => {
      const full = deps.loadItemContext ? await deps.loadItemContext(pg, item.item_id) : item;
      return deps.providerGenerate({ ...full, lease_version:item.lease_version, attempt_count:item.attempt_count, client_request_id:item.client_request_id }, signal);
    },
  };
  for (let offset=0;offset<items.length;offset+=concurrency) {
    await Promise.all(items.slice(offset,offset+concurrency).map(item=>processItem(pg,item,runtimeDeps)));
  }
  return { claimed:items.length };
}

// ---- Activity runner mount (§138 渐进上线) ----
// 默认 OFF：不设置 env / options.enabled 时 runActivityTick 直接返回 no-op。
// 显式开启（任一）：env GENERATION_V2_ACTIVITY_RUNNER=1，或 options.enabled=true。
// 真库待 0060 迁移合入后再容器验证；此处仅挂载点，不改动现有 tick 装配。
async function runActivityTick(pg, options = {}, injected = {}) {
  const enabled = options.enabled === true || process.env.GENERATION_V2_ACTIVITY_RUNNER === '1';
  if (!enabled) return { claimed: 0, enabled: false, note: 'activity runner disabled (§138 default off)' };
  const { createActivityRunner, createPgActivityStore } = require('./activity-runner.cjs');
  const workerId = options.workerId || injected.workerId;
  if (!workerId) throw new TypeError('workerId is required');
  const store = injected.store || createPgActivityStore(pg);
  const worker = injected.activityWorker;
  if (typeof worker !== 'function') throw new TypeError('activityWorker is required when enabled');
  const runner = injected.runner || createActivityRunner({
    store, worker, workerId,
    maxAttempts: options.maxAttempts,
    timeoutMs: options.timeoutMs,
    backoffMs: options.backoffMs,
    leaseSeconds: options.leaseSeconds || 120,
    concurrency: options.concurrency || 1,
    onError: options.onError,
  });
  return runner.runOnce({ limit: options.limit });
}

// ---- Generation Group runner (§112/§113 渐进上线, L45) ----
// 默认 OFF：与 runActivityTick 同旗标（options.enabled / GENERATION_V2_ACTIVITY_RUNNER=1），
// 另加独立 env GENERATION_V2_GROUP_RUNNER=1 单独开启。组调度只读 generation_groups /
// generation_group_items(0070) + generation_items_v2 归一化列，不触碰 runWorkerTick 装配。
//
// 组调度语义（§112/§113）：
//   组内并发上限  policy.concurrency —— 组内「在途」item（非 queued/retry_wait/终态）达上限即
//     本 tick 不再领取该组新 item。
//   按序推进      generation_group_items.position ASC（created_at/item_id tie-break）——
//     claimGroupItems 的 ORDER BY 保证组内顺序领取，不跳序。
//   失败策略      fail_fast：任一 item 终态 failed → 整组 failed + 剩余 queued/retry_wait 项 cancel；
//                 continue：单 item 失败不阻塞，其余继续推进，全组终态后再定 succeeded/failed。
//   组终态        done+failed+canceled == 组内 total 时收尾：failed>0 → failed；全 canceled →
//                 canceled；否则 succeeded。

function normalizeGroupPolicy(policy) {
  const p = (policy && typeof policy === 'object' && !Array.isArray(policy)) ? policy : {};
  const rawConcurrency = Number(p.concurrency);
  const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0
    ? Math.min(50, Math.floor(rawConcurrency)) : 1;
  const failurePolicy = p.failurePolicy === 'continue' ? 'continue' : 'fail_fast';
  return { concurrency, failurePolicy };
}

// 把组调度的 SQL 函数绑定到一个 pg pool，作为 runGroupTick 的 store。
function createPgGroupStore(pg) {
  if (!pg || typeof pg.query !== 'function') throw new TypeError('pg.query is required');
  return {
    listActiveGroups: async ({ limit = 20 } = {}) => {
      const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
      const r = await pg.query(
        `SELECT id, project_id, name, media_type, status, policy, created_at, finished_at
           FROM generation_groups
          WHERE status IN ('queued','running')
          ORDER BY created_at ASC, id ASC
          LIMIT $1`, [safeLimit]);
      return r.rows || [];
    },
    countInFlight: async ({ groupId }) => {
      if (!groupId) throw new TypeError('groupId is required');
      const r = await pg.query(
        `SELECT count(*)::int AS n
           FROM generation_group_items gi
           JOIN generation_items_v2 i ON i.item_id = gi.item_id
          WHERE gi.group_id = $1
            AND i.status NOT IN ('queued','retry_wait','done','failed','canceled')`, [groupId]);
      return (r.rows && r.rows[0]) ? r.rows[0].n : 0;
    },
    hasFailedItem: async ({ groupId }) => {
      if (!groupId) throw new TypeError('groupId is required');
      const r = await pg.query(
        `SELECT EXISTS (
           SELECT 1
             FROM generation_group_items gi
             JOIN generation_items_v2 i ON i.item_id = gi.item_id
            WHERE gi.group_id = $1 AND i.status = 'failed'
         ) AS failed`, [groupId]);
      return !!(r.rows && r.rows[0] && r.rows[0].failed);
    },
    claimGroupItems: async ({ groupId, workerId, limit = 1, leaseSeconds = 120 } = {}) => {
      if (!groupId || !workerId) throw new TypeError('groupId and workerId are required');
      const safeLimit = Math.max(1, Math.min(100, Number(limit) || 1));
      const safeLease = Math.max(10, Math.min(900, Number(leaseSeconds) || 120));
      const r = await pg.query(
        `WITH picked AS (
           SELECT gi.item_id
             FROM generation_group_items gi
             JOIN generation_items_v2 i ON i.item_id = gi.item_id
            WHERE gi.group_id = $1
              AND i.status IN ('queued','retry_wait')
              AND i.mode = 'real'
              AND i.next_attempt_at <= NOW()
            ORDER BY gi.position ASC, gi.created_at ASC, gi.item_id ASC
            FOR UPDATE OF i SKIP LOCKED
            LIMIT $2
         )
         UPDATE generation_items_v2 i
            SET status='leased', lease_owner=$3,
                lease_expires_at=NOW()+($4 * INTERVAL '1 second'),
                lease_version=i.lease_version+1,
                attempt_count=i.attempt_count+1
           FROM picked p
          WHERE i.item_id = p.item_id
          RETURNING i.*`,
        [groupId, safeLimit, workerId, safeLease]);
      return r.rows || [];
    },
    markRunning: async ({ groupId }) => {
      if (!groupId) throw new TypeError('groupId is required');
      await pg.query(
        `UPDATE generation_groups SET status='running' WHERE id=$1 AND status='queued'`, [groupId]);
    },
    failGroup: async ({ groupId }) => {
      if (!groupId) throw new TypeError('groupId is required');
      await pg.query(
        `UPDATE generation_groups SET status='failed', finished_at=NOW() WHERE id=$1`, [groupId]);
      await pg.query(
        `UPDATE generation_items_v2 i
            SET status='canceled', lease_owner=NULL, lease_expires_at=NULL
           FROM generation_group_items gi
          WHERE gi.group_id=$1 AND i.item_id=gi.item_id
            AND i.status IN ('queued','retry_wait')`, [groupId]);
    },
    groupItemCounts: async ({ groupId }) => {
      if (!groupId) throw new TypeError('groupId is required');
      const r = await pg.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE i.status='done')::int AS done,
                count(*) FILTER (WHERE i.status='failed')::int AS failed,
                count(*) FILTER (WHERE i.status='canceled')::int AS canceled
           FROM generation_group_items gi
           JOIN generation_items_v2 i ON i.item_id = gi.item_id
          WHERE gi.group_id = $1`, [groupId]);
      const row = (r.rows && r.rows[0]) || {};
      return { total: row.total || 0, done: row.done || 0, failed: row.failed || 0, canceled: row.canceled || 0 };
    },
    finalizeGroup: async ({ groupId, status }) => {
      if (!groupId || !status) throw new TypeError('groupId and status are required');
      await pg.query(
        `UPDATE generation_groups SET status=$2, finished_at=NOW() WHERE id=$1`, [groupId, status]);
    },
  };
}

async function finalizeGroupIfTerminal(store, groupId, summary) {
  const counts = await store.groupItemCounts({ groupId });
  const terminal = counts.done + counts.failed + counts.canceled;
  if (counts.total > 0 && terminal >= counts.total) {
    let status = 'succeeded';
    if (counts.failed > 0) status = 'failed';
    else if (counts.canceled >= counts.total) status = 'canceled';
    await store.finalizeGroup({ groupId, status });
    summary.finalized++;
  }
}

async function runGroupTick(pg, options = {}, injected = {}) {
  const enabled = options.enabled === true
    || process.env.GENERATION_V2_GROUP_RUNNER === '1'
    || process.env.GENERATION_V2_ACTIVITY_RUNNER === '1';
  if (!enabled) {
    return { groups: 0, claimed: 0, dispatched: 0, finalized: 0, failFastStopped: 0, enabled: false, note: 'group runner disabled (§113 default off)' };
  }
  const workerId = options.workerId || injected.workerId;
  if (!workerId) throw new TypeError('workerId is required');
  const store = injected.store || createPgGroupStore(pg);
  const processOne = injected.processItem || processItem;

  const groups = await store.listActiveGroups({ limit: options.limit });
  const summary = { groups: groups.length, claimed: 0, dispatched: 0, finalized: 0, failFastStopped: 0, enabled: true };

  for (const group of groups) {
    const policy = normalizeGroupPolicy(group.policy);
    // fail_fast：任一 item 已 failed → 整组 fail + cancel 剩余（§113 Group 主动生成 N，失败策略控制）。
    if (policy.failurePolicy === 'fail_fast') {
      if (await store.hasFailedItem({ groupId: group.id })) {
        await store.failGroup({ groupId: group.id });
        summary.failFastStopped++;
        continue;
      }
    }
    const inFlight = await store.countInFlight({ groupId: group.id });
    const slots = Math.max(0, policy.concurrency - inFlight);
    if (slots <= 0) {
      await finalizeGroupIfTerminal(store, group.id, summary);
      continue;
    }
    const claimed = await store.claimGroupItems({
      groupId: group.id, workerId, limit: slots,
      leaseSeconds: options.leaseSeconds || 120,
    });
    if (claimed.length) {
      await store.markRunning({ groupId: group.id });
      summary.claimed += claimed.length;
      const runtimeDeps = { ...injected, workerId, leaseSeconds: options.leaseSeconds || 120 };
      // 组内并发上限由 claim 的 slots 保证；dispatch 按组内顺序（position）推进。
      for (let offset = 0; offset < claimed.length; offset += policy.concurrency) {
        await Promise.all(claimed.slice(offset, offset + policy.concurrency).map((item) => processOne(pg, item, runtimeDeps)));
      }
      summary.dispatched += claimed.length;
    }
    await finalizeGroupIfTerminal(store, group.id, summary);
  }
  return summary;
}

module.exports = {
  defaultRecordAttempt, processItem, runWorkerTick, runActivityTick,
  normalizeGroupPolicy, createPgGroupStore, runGroupTick,
};
