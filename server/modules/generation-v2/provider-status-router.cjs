'use strict';
/**
 * Provider Status Router — normalized reconciliation dispatcher.
 *
 * Maps:
 *   Reconciler (item context)
 *     -> ProviderStatusRouter
 *       -> provider-specific one-shot HTTP query
 *         -> NormalizedResult { status, providerUrl?, errorCode?, errorMessage? }
 *
 * Normalized statuses: pending | success | failed | not_found | unknown
 *
 * Safety:
 * - UNKNOWN is never treated as FAILED
 * - NOT_FOUND never triggers blind resubmission
 * - Secrets never logged
 * - Bounded HTTP timeout (30s per query)
 * - provider endpoint comes from trusted DB config, not user input
 * - one-shot HTTP call (no pollLoop blocking)
 */

const { fetchJson, getByPath, normalizeVideoStatus, resolveEndpoint } = require('../../providers/video/shared.cjs');
const videoRouter = require('../../providers/video/index.cjs');

const HTTP_TIMEOUT_MS = 30_000;

// ─── Poll Policy (§63-65, L21) ─────────────────────────────────────────
// Provider-specific poll policy：每 provider 可配 poll_interval / deadline 类型 /
// deadline 时长 / max_polls / retry_after 上限。表 0063（provider_poll_policies）。
//
// 4 类 deadline（§64 Poll ≠ Job Deadline 的落地命名）：
//   no_deadline    — 无 deadline，无限轮询（默认）
//   fixed_window   — 从「本次轮询窗口」开始计时，窗口耗时 ≥ deadline_ms 停
//   attempt_ttl    — 单次 attempt（本次一 shot 查询）耗时 ≥ deadline_ms 停
//   job_ttl        — 从 job 提交起（job 年龄）≥ deadline_ms 停
//
// 等待≠取消（§65）：deadline 到期只「停止 poll」，绝不 cancel provider task；
// 状态转 reconcile_wait 待 watchdog（reconciler 后台对账到真实终态）。
const VALID_DEADLINE_KINDS = new Set(['no_deadline', 'fixed_window', 'attempt_ttl', 'job_ttl']);

const DEFAULT_POLL_POLICY = Object.freeze({
  poll_interval_ms: 15000,
  deadline_kind: 'no_deadline',
  deadline_ms: null,
  max_polls: null,
  retry_after_cap_ms: 30000,
});

// 停 poll 后（deadline/max_polls 到期）把 next_attempt_at 推到远端，使 reconciler 的
// `next_attempt_at <= NOW()` 谓词不再命中 → 暂停轮询；但 status 仍是 reconcile_wait
// （非终态、非 cancel），watchdog/管理面可随时复位恢复对账。
const POLL_STOPPED_DEFER_MS = 7 * 24 * 60 * 60 * 1000; // 7 天兜底重查窗口

function toNumOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 把 DB 行/入参归一化为完整 policy（缺字段回退默认常量）。入参可能是 pg 行（字符串/数字）。
// 归一化结果与 DEFAULT_POLL_POLICY 同形：retry_after_cap_ms 缺省回退 30000（= 基础退避，
// 即无额外封顶）；deadline_ms/max_polls 缺省回退 null（= 无 deadline / 不限次数）。
function normalizePolicy(policy) {
  const p = (policy && typeof policy === 'object') ? policy : {};
  const interval = toNumOrNull(p.poll_interval_ms);
  const cap = toNumOrNull(p.retry_after_cap_ms);
  return {
    poll_interval_ms: interval == null ? DEFAULT_POLL_POLICY.poll_interval_ms : interval,
    deadline_kind: (typeof p.deadline_kind === 'string' && VALID_DEADLINE_KINDS.has(p.deadline_kind))
      ? p.deadline_kind : DEFAULT_POLL_POLICY.deadline_kind,
    deadline_ms: toNumOrNull(p.deadline_ms),
    max_polls: toNumOrNull(p.max_polls),
    retry_after_cap_ms: cap == null ? DEFAULT_POLL_POLICY.retry_after_cap_ms : cap,
  };
}

// 轮询判定（纯函数，无 I/O）：给定 policy + timing，返回是否继续 poll 及下次间隔。
// timing: { attemptCount, windowElapsedMs, attemptElapsedMs, jobElapsedMs }
//   返回 { continue:boolean, reason:string|null, nextInMs:number }
function evaluatePollDeadline(policy, timing) {
  const p = normalizePolicy(policy);
  const t = (timing && typeof timing === 'object') ? timing : {};

  // max_polls：已完成/含本次的轮询次数达到上限 → 停（等待≠取消）。
  if (p.max_polls != null) {
    const count = toNumOrNull(t.attemptCount);
    if (count != null && count >= p.max_polls) {
      return { continue: false, reason: 'max_polls_reached', nextInMs: p.poll_interval_ms };
    }
  }

  let elapsed = null;
  let reason = null;
  switch (p.deadline_kind) {
    case 'fixed_window':
      elapsed = toNumOrNull(t.windowElapsedMs);
      reason = 'fixed_window_exceeded';
      break;
    case 'attempt_ttl':
      elapsed = toNumOrNull(t.attemptElapsedMs);
      reason = 'attempt_ttl_exceeded';
      break;
    case 'job_ttl':
      elapsed = toNumOrNull(t.jobElapsedMs);
      reason = 'job_ttl_exceeded';
      break;
    case 'no_deadline':
    default:
      // no_deadline 或未知 kind（未知视为 no_deadline，安全：继续 poll，不误停/不误取消）
      break;
  }

  if (elapsed != null && p.deadline_ms != null && elapsed >= p.deadline_ms) {
    return { continue: false, reason, nextInMs: p.poll_interval_ms };
  }
  return { continue: true, reason: null, nextInMs: p.poll_interval_ms };
}

// 读 0063 provider_poll_policies；无行/未建表/无 pg → 回退默认常量（缺省配置）。
async function pollPolicyFor(pg, providerId) {
  if (!providerId || !pg || typeof pg.query !== 'function') return { ...DEFAULT_POLL_POLICY };
  try {
    const r = await pg.query(
      `SELECT poll_interval_ms, deadline_kind, deadline_ms, max_polls, retry_after_cap_ms
         FROM provider_poll_policies WHERE provider_id = $1`,
      [providerId],
    );
    if (!r.rows || !r.rows.length) return { ...DEFAULT_POLL_POLICY };
    return normalizePolicy(r.rows[0]);
  } catch (_) {
    // 表未建（迁移未跑/旧库）→ 回退默认，不抛错，轮询继续用默认策略。
    return { ...DEFAULT_POLL_POLICY };
  }
}

// ─── Load provider config from DB ───
async function loadProviderById(pg, providerId) {
  if (!providerId) return null;
  const r = await pg.query(
    `SELECT id, name, base_url, protocol, default_endpoint, api_key, enabled, created_at
     FROM providers WHERE id = $1`,
    [providerId]
  );
  if (!r.rows || !r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    protocol: row.protocol,
    default_endpoint: parseJson(row.default_endpoint),
    api_key: row.api_key,
    enabled: row.enabled,
    created_at: row.created_at,
  };
}

// ─── Load model config from DB ───
async function loadModelById(pg, modelId) {
  if (!modelId) return null;
  const r = await pg.query(
    `SELECT model_id, provider_id, mapping_name, endpoint, display_name, enabled, type
     FROM models WHERE model_id = $1 AND (enabled=true OR enabled IS NULL)`,
    [modelId]
  );
  if (!r.rows || !r.rows.length) return null;
  const row = r.rows[0];
  return {
    model_id: row.model_id,
    provider_id: row.provider_id,
    upstream_model_name: row.mapping_name,
    endpoint: parseJson(row.endpoint),
    name: row.display_name,
    enabled: row.enabled,
    type: row.type,
  };
}

// ─── Resolve provider type ───
function resolveProviderType(provider) {
  if (!provider || !provider.base_url) return 'unknown';
  const base = (provider.base_url || '').toLowerCase();
  const me = parseJson(provider.default_endpoint);
  if (me.videoAdapter) return `video-${me.videoAdapter}`;
  if (/agnes-ai\.cn/i.test(base)) return 'video-agnes';
  if (/minimax/i.test(base)) return 'video-minimax';
  if (/volces|ark\.cn-beijing|volcano/i.test(base)) return 'video-volcano';
  if (me.async) return 'video-custom';
  return 'image-sync';
}

// ─── Main entry: queryProviderStatus ───
async function queryProviderStatus(pg, { providerId, modelId, providerRequestId, clientRequestId, content_type }) {
  const startMs = Date.now();

  // 1. providerRequestId is mandatory for reconciliation
  if (!providerRequestId || !String(providerRequestId).trim()) {
    // clientRequestId is NOT a valid substitute — providers don't expose it for lookup
    return {
      status: 'unknown',
      errorCode: 'MISSING_PROVIDER_REQUEST_ID',
      errorMessage: 'No provider task ID available for reconciliation',
    };
  }

  // 2. Load provider config
  const provider = await loadProviderById(pg, providerId);
  if (!provider) {
    return {
      status: 'unknown',
      errorCode: 'PROVIDER_CONFIG_MISSING',
      errorMessage: 'Provider config not found in DB',
    };
  }

  // 3. Check provider is enabled
  if (!provider.enabled) {
    return {
      status: 'unknown',
      errorCode: 'PROVIDER_DISABLED',
      errorMessage: 'Provider is disabled',
    };
  }

  // 4. Load model config for endpoint resolution
  const model = await loadModelById(pg, modelId);

  // 5. Resolve provider type
  const pType = resolveProviderType(provider);

  // 6. Image providers (sync) — no reconciliation query available
  if (pType === 'image-sync') {
    return {
      status: 'unknown',
      errorCode: 'SYNC_PROVIDER_NO_QUERY',
      errorMessage: 'Synchronous image provider does not expose status query API',
    };
  }

  // 7. Video providers — one-shot HTTP query
  try {
    const result = await queryVideoProviderOnce(provider, model, String(providerRequestId).trim());
    const latency = Date.now() - startMs;
    if (latency > 5000) {
      console.warn(`[reconciler] provider query slow: provider=${providerId} latency=${latency}ms taskId=${providerRequestId}`);
    }
    return result;
  } catch (e) {
    // Network error, timeout, parse failure → unknown (never assume failed)
    const latency = Date.now() - startMs;
    console.warn(`[reconciler] provider query error: provider=${providerId} latency=${latency}ms error=${e.code || 'UNKNOWN'}`);
    return {
      status: 'unknown',
      errorCode: e.code || 'NETWORK_ERROR',
      errorMessage: sanitizeErrorMessage(e.message || String(e)),
    };
  }
}

// ─── One-shot video provider query (single HTTP request, no loop) ───
async function queryVideoProviderOnce(provider, model, taskId) {
  const pType = resolveProviderType(provider);

  // Map to video adapter key
  let adapterKey = 'generic';
  if (pType === 'video-agnes') adapterKey = 'agnes';
  else if (pType === 'video-minimax') adapterKey = 'minimax';
  else if (pType === 'video-volcano') adapterKey = 'video-volcano';

  const handlers = {
    agnes: queryAgnesStatus,
    minimax: queryMiniMaxStatus,
    volcano: queryVolcanoStatus,
  };

  const handler = handlers[adapterKey];
  if (!handler) {
    // Custom/unsupported — still try generic
    return queryGenericVideoStatus(provider, model, taskId);
  }

  return handler(provider, model, taskId);
}

// ─── Agnes: GET {origin}/agnesapi?video_id={taskId} ───
async function queryAgnesStatus(provider, model, taskId) {
  const { resolveAgnesEndpoint } = require('../../providers/video/agnes.cjs');
  const { pollEp } = resolveAgnesEndpoint(provider, model);
  const pollQueryParam = pollEp.taskQueryParam || 'video_id';

  let url = `${pollEp.baseUrl.replace(/\/+$/, '')}${pollEp.path.startsWith('/') ? pollEp.path : '/' + pollEp.path}`;
  url += `?${encodeURIComponent(pollQueryParam)}=${encodeURIComponent(taskId)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { Authorization: `Bearer ${provider.api_key}` };
    const r = await fetchJson(url, { method: 'GET', headers });
    if (r.status === 404) {
      return { status: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'Provider task not found' };
    }
    if (r.status >= 400) {
      return {
        status: 'unknown',
        errorCode: `HTTP_${r.status}`,
        errorMessage: sanitizeErrorMessage(JSON.stringify(r.body).slice(0, 160)),
      };
    }
    // Parse response
    const body = r.body || {};
    const st = String(getByPath(body, pollEp.taskStatusPath || 'status') || '').toLowerCase();
    if (['completed', 'succeeded', 'success', 'done'].includes(st)) {
      let urlVal = getByPath(body, pollEp.taskResultPath || 'metadata.url');
      if (!urlVal) urlVal = getByPath(body, 'metadata.url');
      if (!urlVal) urlVal = getByPath(body, 'url');
      return { status: 'success', providerUrl: String(urlVal || '') };
    }
    if (['failed', 'error', 'canceled', 'cancelled'].includes(st)) {
      return {
        status: 'failed',
        errorCode: 'PROVIDER_FAILED',
        errorMessage: sanitizeErrorMessage(JSON.stringify(body).slice(0, 160)),
      };
    }
    return { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: `Agnes status: ${st}` };
  } finally {
    clearTimeout(timer);
  }
}

// ─── MiniMax: GET {base}/v2/query/video_generation/{taskId} ───
async function queryMiniMaxStatus(provider, model, taskId) {
  const base = (provider.base_url || 'https://api.minimaxi.com/v2').replace(/\/+$/, '');
  const url = `${base}/query/video_generation/${encodeURIComponent(taskId)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { Authorization: `Bearer ${provider.api_key}` };
    const r = await fetchJson(url, { method: 'GET', headers });
    if (r.status === 404) {
      return { status: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'MiniMax task not found' };
    }
    if (r.status >= 400) {
      return {
        status: 'unknown',
        errorCode: `HTTP_${r.status}`,
        errorMessage: sanitizeErrorMessage(JSON.stringify(r.body).slice(0, 160)),
      };
    }
    const root = r.body || {};
    const task = root.task || root;
    const st = normalizeVideoStatus(task.status, 'minimax');
    if (st === 'success') {
      const urlVal = String((task.content && task.content.url) || root.video_url || '');
      return { status: 'success', providerUrl: urlVal };
    }
    if (st === 'failed') {
      return { status: 'failed', errorCode: 'PROVIDER_FAILED', errorMessage: sanitizeErrorMessage(JSON.stringify(task).slice(0, 160)) };
    }
    return { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'MiniMax task still processing' };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Volcano: GET {base}/contents/generations/tasks/{taskId} ───
async function queryVolcanoStatus(provider, model, taskId) {
  const base = (provider.base_url || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const url = `${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { Authorization: `Bearer ${provider.api_key}` };
    const r = await fetchJson(url, { method: 'GET', headers });
    if (r.status === 404) {
      return { status: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'Volcano task not found' };
    }
    if (r.status >= 400) {
      return {
        status: 'unknown',
        errorCode: `HTTP_${r.status}`,
        errorMessage: sanitizeErrorMessage(JSON.stringify(r.body).slice(0, 160)),
      };
    }
    const root = r.body || {};
    const obj = (root.data && typeof root.data === 'object') ? root.data : root;
    const st = normalizeVideoStatus(obj.status || root.status, 'volcano');
    if (st === 'success') {
      const urlVal = String(obj.video_url || root.video_url || '');
      return { status: 'success', providerUrl: urlVal };
    }
    if (st === 'failed') {
      return { status: 'failed', errorCode: 'PROVIDER_FAILED', errorMessage: sanitizeErrorMessage(JSON.stringify(obj).slice(0, 160)) };
    }
    return { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'Volcano task still processing' };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Generic video provider (custom endpoint with async flag) ───
async function queryGenericVideoStatus(provider, model, taskId) {
  const { protocol, endpoint } = resolveEndpoint(provider, model, 'generate');
  if (!endpoint) {
    return {
      status: 'unknown',
      errorCode: 'RECONCILIATION_NOT_SUPPORTED',
      errorMessage: 'No endpoint configured for generic provider reconciliation',
    };
  }

  // Try to construct poll URL from endpoint config
  const pollBaseUrl = endpoint.baseUrl || provider.base_url;
  const pollPath = endpoint.path || '';

  // Generic fallback: not supported without explicit poll endpoint
  return {
    status: 'unknown',
    errorCode: 'RECONCILIATION_NOT_SUPPORTED',
    errorMessage: `Generic video provider reconciliation requires explicit poll endpoint`,
  };
}

// ─── Event Reducer: applyProviderEvent — 唯一状态入口（webhook + poll 同汇）──────
// §57-60：poll 路径（queryProviderStatus 的一 shot HTTP 结果）与 webhook 路径
// （webhook_inbox 异步队列）都必须经 applyProviderEvent 这一个入口落到
// generation_items_v2，禁止两处各自直接 UPDATE（防双 reduce / 乱序回归）。
// 归一化状态 normalizedStatus 与 queryProviderStatus 返回值同形：
//   { status: 'success'|'failed'|'pending'|'unknown', providerUrl?, errorCode?, errorMessage? }

const TERMINAL_ITEM_STATUSES = new Set(['done', 'failed', 'canceled']);
const REDUCIBLE_FROM = new Set(['reconciling', 'generating']);

// 归一化状态 → 单调状态机决策（纯函数，无 I/O）。from 收敛于 reconciling；
// 仅「早期 webhook」落在 generating 时允许 generating>generated 直边。
// pollPolicy/pollTiming（L21）：pending 分支用 provider-specific poll 策略驱动下次
// poll 间隔与 deadline 判定；未传时回退 DEFAULT_POLL_POLICY（no_deadline）。
function reduceDecision(item, normalizedStatus, pollPolicy, pollTiming) {
  const from = item.status || 'reconciling';
  const st = (normalizedStatus && normalizedStatus.status) || 'unknown';
  const now = Date.now();
  const policy = normalizePolicy(pollPolicy);
  if (st === 'success' && normalizedStatus.providerUrl) {
    return {
      from, to: 'generated',
      patch: {
        provider_url: normalizedStatus.providerUrl,
        provider_request_id: item.provider_request_id,
        lease_expires_at: null,
      },
    };
  }
  if (st === 'failed') {
    // retry_after_cap_ms：封顶 failed 后的重试退避（Retry-After cap）。
    const backoffMs = 30000;
    const cap = policy.retry_after_cap_ms;
    const waitMs = (cap != null && cap >= 0) ? Math.min(backoffMs, cap) : backoffMs;
    return {
      from, to: 'retry_wait',
      patch: {
        last_error_code: 'PROVIDER_FAILED',
        last_error: normalizedStatus.errorMessage || 'provider reported failure',
        next_attempt_at: new Date(now + waitMs),
        lease_expires_at: null,
      },
    };
  }
  if (st === 'pending') {
    const poll = evaluatePollDeadline(policy, pollTiming);
    // 早期 webhook 落在 generating：状态机无 generating>reconcile_wait 边，收敛到
    // generating>reconciling 交 poll 权威对账（下一 reconcile tick 再据 pending 判
    // reconcile_wait / 终态）。from 取实际源状态，否则下方 CAS（WHERE status=$3）
    // 对 generating 项必失败 → 事件被静默吞掉（concurrent_noop）→ item 卡 generating。
    const to = from === 'generating' ? 'reconciling' : 'reconcile_wait';
    if (!poll.continue) {
      // 等待≠取消（§65）：deadline / max_polls 到期 → 只停 poll，绝不 cancel
      // provider task；转 reconcile_wait 待 watchdog 后台对账到真实终态。
      // next_attempt_at 推到远端（POLL_STOPPED_DEFER_MS）使 poll 谓词不再命中。
      return {
        from, to,
        patch: {
          last_error_code: 'POLL_STOPPED',
          last_error: `poll stopped (${poll.reason}); provider task NOT cancelled — awaiting watchdog reconcile`,
          next_attempt_at: new Date(now + POLL_STOPPED_DEFER_MS),
          lease_expires_at: null,
        },
      };
    }
    return {
      from, to,
      patch: {
        last_error_code: 'PROVIDER_PENDING',
        last_error: 'still processing; reconciliation only',
        next_attempt_at: new Date(now + poll.nextInMs),
        lease_expires_at: null,
      },
    };
  }
  return {
    from, to: 'review_required',
    patch: {
      last_error_code: 'RECONCILE_UNKNOWN',
      last_error: normalizedStatus.errorMessage || 'provider status unknown',
      lease_expires_at: null,
    },
  };
}

/**
 * 唯一状态入口：把一个 provider 事件（webhook inbox 行或 poll 归一化结果）reduce 到 item 状态。
 *
 * @param {object} opts
 * @param {{transitionItem: Function, findItemByProviderRequestId: Function}} opts.store
 *   transitionItem({itemId,leaseVersion,from,to,patch}) → row|null（CAS 单写，null=被并发/陈旧）
 *   findItemByProviderRequestId(providerId, providerRequestId) → item|null
 * @param {{complete: Function, fail: Function}|null} opts.inbox  webhook 路径传 {complete,fail}（已绑定 pg）；poll 路径 null
 * @param {object} opts.event            inbox 行（含 id/signature_state/status/provider_id/payload）；poll 路径为虚拟事件
 * @param {object} opts.normalizedStatus 与 queryProviderStatus 返回值同形
 * @param {string} [opts.providerRequestId] 提供方任务 ID（未传时回退 event.payload.provider_request_id）
 * @param {object} [opts.pollPolicy]     provider-specific poll 策略（pollPolicyFor 的返回值；未传回退 DEFAULT_POLL_POLICY）
 * @param {object} [opts.pollTiming]     轮询计时 { attemptCount, windowElapsedMs, attemptElapsedMs, jobElapsedMs }
 *   （L21：pending 分支用它做 4 类 deadline 判定；等待≠取消，deadline 过只停 poll 不 cancel）
 * @returns {{outcome:string, to?:string, reason?:string, itemStatus?:string}}
 *   outcome ∈ reduced | duplicate | out_of_order | rejected | concurrent_noop
 */
async function applyProviderEvent({ store, inbox, event, normalizedStatus, providerRequestId, pollPolicy, pollTiming } = {}) {
  if (!store || typeof store.transitionItem !== 'function' || typeof store.findItemByProviderRequestId !== 'function') {
    throw new TypeError('applyProviderEvent: store.transitionItem and store.findItemByProviderRequestId required');
  }
  const status = (normalizedStatus && normalizedStatus.status) || 'unknown';

  // Guard 1 — 验签失败：绝不 reduce（§57 verify 先行）。
  if (event && event.signature_state === 'failed') {
    if (inbox && event.id) await inbox.fail({ id: event.id, errorCode: 'SIGNATURE_FAILED' });
    return { outcome: 'rejected', reason: 'signature_failed' };
  }

  // Guard 2 — 重复/已处理：幂等 no-op（同事件二次投递只 reduce 一次）。
  if (event && (event.status === 'reduced' || event.status === 'failed')) {
    return { outcome: 'duplicate', reason: `already_${event.status}` };
  }

  // 定位 item（provider_request_id 唯一键，见 uq_generation_items_v2_provider_request）。
  const reqId = providerRequestId || (event && event.payload && event.payload.provider_request_id) || null;
  const item = await store.findItemByProviderRequestId(event ? event.provider_id : null, reqId);
  if (!item) {
    if (inbox && event.id) await inbox.fail({ id: event.id, errorCode: 'ITEM_NOT_FOUND' });
    return { outcome: 'rejected', reason: 'item_not_found' };
  }

  // Guard 3 — 终态回归：拒（done/failed/canceled 不再回退）。
  if (TERMINAL_ITEM_STATUSES.has(item.status)) {
    if (inbox && event.id) await inbox.complete({ id: event.id });
    return { outcome: 'rejected', reason: 'terminal_regression', itemStatus: item.status };
  }

  // Guard 4 — 乱序（stale）：item 已 generated（provider_url 已就绪）又来 pending/failed/unknown
  //           或同形陈旧回执 → 不回归，降级为 reconcile_wait 语义（poll 权威对账，§59 单调）。
  if (item.status === 'generated' || (item.provider_url && status !== 'success')) {
    if (inbox && event.id) await inbox.complete({ id: event.id });
    return { outcome: 'out_of_order', reason: 'reconcile_wait', itemStatus: item.status };
  }

  // Guard 5 — 源状态不在收敛态（非 reconciling/generating，如 reconcile_wait/uploading/queued）→
  //           早期/错位 webhook，降级 reconcile_wait 语义（交 poll 路径，禁直改）。
  if (item.status && !REDUCIBLE_FROM.has(item.status)) {
    if (inbox && event.id) await inbox.complete({ id: event.id });
    return { outcome: 'out_of_order', reason: 'reconcile_wait', itemStatus: item.status };
  }

  // 唯一 reduce：CAS 单写（store.transitionItem 内部 status+lease_version 双 CAS）。
  const decision = reduceDecision(item, normalizedStatus, pollPolicy, pollTiming);
  const row = await store.transitionItem({
    itemId: item.item_id,
    leaseVersion: Number(item.lease_version),
    from: decision.from,
    to: decision.to,
    patch: decision.patch,
  });
  if (!row) {
    // 并发 delivery / 双 reduce 被 CAS 拦截：吞掉，标记消费，避免重放。
    if (inbox && event.id) await inbox.complete({ id: event.id });
    return { outcome: 'concurrent_noop', reason: 'stale_lease', itemStatus: item.status };
  }
  if (inbox && event.id) await inbox.complete({ id: event.id });
  return { outcome: 'reduced', to: decision.to, itemStatus: item.status };
}

// ─── Sanitize error messages (prevent secret leakage) ───
function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string') return String(msg);
  return msg
    .replace(/Bearer\s+[A-Za-z0-9_\-./+=]+/g, 'Bearer [REDACTED]')
    .replace(/api_key[=:]\s*['"]?[A-Za-z0-9_\-./+=]+['"]?/gi, 'api_key=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_\-]+/g, 'sk-[REDACTED]')
    .replace(/Authorization[=:]\s*['"][^'"]*['"]/gi, 'Authorization=[REDACTED]')
    .slice(0, 200);
}

// ─── Parse JSON field with fallback ───
function parseJson(val) {
  if (typeof val === 'object' && val !== null) return val;
  if (typeof val !== 'string') return {};
  try { return JSON.parse(val); } catch { return {}; }
}

module.exports = {
  queryProviderStatus,
  applyProviderEvent,
  reduceDecision,
  loadProviderById,
  loadModelById,
  resolveProviderType,
  queryVideoProviderOnce,
  queryAgnesStatus,
  queryMiniMaxStatus,
  queryVolcanoStatus,
  queryGenericVideoStatus,
  sanitizeErrorMessage,
  // L21 — Poll Policy (§63-65)
  pollPolicyFor,
  evaluatePollDeadline,
  normalizePolicy,
  DEFAULT_POLL_POLICY,
  VALID_DEADLINE_KINDS,
  POLL_STOPPED_DEFER_MS,
};
