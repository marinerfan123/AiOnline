'use strict';
/**
 * L53 — 流量切换 shadow mode 对照工具（PREP，默认 off 零行为变更）。
 *
 * 目的：在 FF_VIDEO_DURABLE_EVENTS 从「inline fire-and-forget 直驱」翻转到
 * 「outbox relay 权威提交」之前，先以 shadow 模式双路都跑，并落 shadow_compare
 * 对照行取证（outbox 结果 vs legacy 结果终态一致性），供父线证据充分后翻转。
 *
 * 本模块只做三件事，全部纯函数/可注入，无生产副作用：
 *   1. classifyDurableEventsMode —— 把 FF_VIDEO_DURABLE_EVENTS 三态化
 *      (off | on | shadow)。「flag 置 2 / 字面量 shadow」= shadow 模式。
 *   2. compareOutcome —— 两路终态一致性判定（一致 / 不一致 / 终态未齐 pending 不判）。
 *   3. writeShadowCompare / recordRelayOutcome —— 落 shadow_compare 对照行。
 *
 * ── 落点裁决（父线 2026-09-05）──────────────────────────────────────────────
 * 写 generation_events（append-only，§132），type='shadow_compare'，
 * source='traffic_switch'，零新表。job_id=taskId、provider_event_id=providerTaskId
 * 供跨表取证关联；两路终态 + task id 以 payload 形式经 eventLog.appendEvent
 * 哈希为 payload_hash 落库（本表无 payload 列，仅 payload_hash——§132 设计如此，
 * 与 reconciler.cjs L23-27「generation_events 无 payload 列，仅 payload_hash」
 * 的先例一致）。明文对照另由调用方（server.js relay 包装层）console 落日志。
 */
const { appendEvent } = require('./eventLog.cjs');

// ─── 1. shadow 模式标记（纯函数）────────────────────────────────────────────
// FF_VIDEO_DURABLE_EVENTS 三态：
//   'shadow' / '2'  → 'shadow'（双路都跑 + 写对照行）
//   '1'/'true'/'on'/'yes' → 'on'（与 flags.cjs parseBool 语义一致）
//   其它（含 '0'/'false'/'off'/缺省/未知）→ 'off'（fail-closed 保持现状）
function classifyDurableEventsMode(env = process.env) {
  const raw = env && env.FF_VIDEO_DURABLE_EVENTS;
  if (typeof raw === 'number') {
    if (raw === 2) return 'shadow';
    if (raw === 1) return 'on';
    return 'off';
  }
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === 'shadow' || s === '2') return 'shadow';
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return 'on';
  return 'off';
}

// ─── 2. 终态归一（纯函数）───────────────────────────────────────────────────
// legacy 路径用 generation_tasks.status 词表（running/done/failed/canceled/waiting），
// outbox 路径可能用 dispatched/skipped:<reason> 等 dispatch 决策词表。这里只归一
// 明确的终态同义词；非终态（pending/running/waiting/queued/dispatched/skipped:…）
// 原样透传，由 isTerminalStatus / compareOutcome 判定「终态未齐」。
const SUCCESS = new Set(['done', 'success', 'succeeded', 'completed', 'complete', 'finished', 'ok']);
const FAILED = new Set(['failed', 'failure', 'error', 'exception']);
const CANCELED = new Set(['canceled', 'cancelled', 'cancel']);

function normalizeStatus(status) {
  if (status === undefined || status === null) return null;
  const s = String(status).trim().toLowerCase();
  if (s === '') return null;
  if (SUCCESS.has(s)) return 'success';
  if (FAILED.has(s)) return 'failed';
  if (CANCELED.has(s)) return 'canceled';
  return s; // 非终态透传
}

const TERMINAL = new Set(['success', 'failed', 'canceled']);
function isTerminalStatus(status) {
  const n = normalizeStatus(status);
  return n !== null && TERMINAL.has(n);
}

// ─── 3. compareOutcome（纯函数）─────────────────────────────────────────────
// 判定两路终态一致性：
//   · 两路均终态且一致        → { aligned: true }
//   · 两路均终态但不一致      → { aligned: false, diff: { reason:'MISMATCH', … } }
//   · 任一路非终态（终态未齐）→ { aligned: false, diff: { reason:'PENDING', … } }（不判）
function compareOutcome({ legacyStatus, outboxStatus, providerTaskId } = {}) {
  const l = normalizeStatus(legacyStatus);
  const o = normalizeStatus(outboxStatus);
  const ctx = {
    legacyStatus: legacyStatus === undefined || legacyStatus === null ? null : legacyStatus,
    outboxStatus: outboxStatus === undefined || outboxStatus === null ? null : outboxStatus,
  };
  if (providerTaskId !== undefined && providerTaskId !== null && providerTaskId !== '') {
    ctx.providerTaskId = providerTaskId;
  }

  const bothTerminal = l !== null && o !== null && TERMINAL.has(l) && TERMINAL.has(o);
  if (!bothTerminal) {
    return { aligned: false, diff: { reason: 'PENDING', note: '终态未齐，不判', ...ctx } };
  }
  if (l === o) return { aligned: true };
  return { aligned: false, diff: { reason: 'MISMATCH', ...ctx, normalized: { legacy: l, outbox: o } } };
}

// ─── 4. 落点 writer：写 shadow_compare 对照行到 generation_events ─────────────
// 隔离：任何失败都返回 { ok:false, error }，绝不 throw（与 V2 shadow 双写同隔离口径）。
async function writeShadowCompare(pg, { taskId, providerTaskId, legacyStatus, outboxStatus } = {}) {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    return { ok: false, error: { code: 'INVALID_TASK_ID', message: 'taskId (non-empty string) required' } };
  }
  const verdict = compareOutcome({ legacyStatus, outboxStatus, providerTaskId });
  const payload = {
    taskId,
    providerTaskId: providerTaskId || null,
    legacyStatus: legacyStatus === undefined || legacyStatus === null ? null : legacyStatus,
    outboxStatus: outboxStatus === undefined || outboxStatus === null ? null : outboxStatus,
    aligned: verdict.aligned,
    diff: verdict.diff || null,
  };
  try {
    const res = await appendEvent({
      pg,
      row: {
        eventId: `shadow_compare:${taskId}`,
        jobId: taskId,
        type: 'shadow_compare',
        source: 'traffic_switch',
        providerEventId: providerTaskId || undefined,
        payload,
      },
    });
    if (res && res.ok) {
      return {
        ok: true,
        aligned: verdict.aligned,
        diff: verdict.diff || null,
        eventId: res.eventId,
        payloadHash: res.payloadHash,
        idempotent: res.idempotent,
      };
    }
    return { ok: false, error: (res && res.error) || { code: 'APPEND_FAILED', message: 'appendEvent failed' } };
  } catch (e) {
    return { ok: false, error: { code: 'SHADOW_COMPARE_FAILED', message: (e && e.message) || String(e) } };
  }
}

// ─── 5. relay 消费面包装（server.js 经 runGenerationRelayTick 的 injected.publish 接入）──
// 不改 dispatcher/reconciler：server.js 在 shadow 模式下用本函数包一层 dispatchFromOutbox，
// 捕获 relay 的真实 dispatch 决策并落对照行。dispatch 行为与默认完全一致（零行为切换）。
async function recordRelayOutcome(pg, ev, dispatchResult) {
  let payload = (ev && ev.payload) || {};
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = {}; } }
  const taskId = payload.task_id || payload.taskId || (ev && ev.aggregate_id) || (dispatchResult && dispatchResult.taskId) || '';
  if (!taskId) return { ok: false, error: { code: 'MISSING_TASK_ID', message: 'no task_id to correlate' } };

  let taskRow = null;
  try {
    const r = await pg.query('SELECT status, provider_task_id FROM generation_tasks WHERE task_id=$1', [taskId]);
    taskRow = (r && r.rows && r.rows[0]) || null;
  } catch (e) {
    return { ok: false, error: { code: 'TASK_LOOKUP_FAILED', message: (e && e.message) || String(e) } };
  }

  const legacyStatus = taskRow ? taskRow.status : null;
  const providerTaskId = (taskRow && taskRow.provider_task_id) || (dispatchResult && dispatchResult.providerTaskId) || null;
  // outbox 侧结果：relay 亲自驱动（dispatched）→ 终态即 task 行当前状态；
  // relay 幂等跳过（skipped）→ 记 'skipped:<reason>'（去重安全证据，非终态 → pending 不判）。
  const outboxStatus = dispatchResult && dispatchResult.dispatched
    ? legacyStatus
    : `skipped:${(dispatchResult && dispatchResult.reason) || 'unknown'}`;

  return writeShadowCompare(pg, { taskId, providerTaskId, legacyStatus, outboxStatus });
}

module.exports = {
  classifyDurableEventsMode,
  normalizeStatus,
  isTerminalStatus,
  compareOutcome,
  writeShadowCompare,
  recordRelayOutcome,
};
