'use strict';
/**
 * M05-D1 — Studio Run API (/api/v2/projects/:id/studio/runs).
 *
 *  - POST   /api/v2/projects/:projectId/studio/runs               create Run (ALL/SELECTED/FROM_NODE)
 *  - GET    /api/v2/projects/:projectId/studio/runs               list runs (paginated)
 *  - GET    /api/v2/projects/:projectId/studio/runs/:runId        run detail (nodes + counts)
 *  - POST   /api/v2/projects/:projectId/studio/runs/:runId/cancel request durable cancellation (D1 foundation)
 *  - GET    /api/v2/projects/:projectId/studio/runs/:runId/events  run event stream (G21 SSE read side)
 *
 * Authorization reuses M01 project permissions (workspace membership).
 * Run id is never a scope bypass: every read re-joins project+workspace.
 *
 * G21 — run events SSE read side:
 *   handleRunEventsSse(req, res, { runId, user }) lives on the API instance and
 *   is exported for direct mounting (the mount point itself is server.js's job).
 *   Ownership is verified INSIDE the SSE handler (404/403) because a streaming
 *   endpoint has no dispatcher role gate — see createRunEventsSse below.
 */
const { LIMITS: GRAPH_LIMITS, compileStudioGraph } = require('./studioRunGraph.cjs');
const { createRunEventStore } = require('./runEventStore.cjs');
// V2.0 must#2 — 预算前置门（纯估算核心 + project_budgets 读模型）。
const { estimateRun, creditsToUnits } = require('../budget/budgetEstimate.cjs');
const { getBudgetSpent } = require('./budgetSpentStore.cjs');
// 价格真源必须与 L5 计费同链（accounting.getModelPrice：model_pricing → history →
// models → 0），否则门读错库行（只读 models.credit_cost）会系统性低估、放行超预算。
const accounting = require('../../accounting.cjs');

const RUNS_RE = /^\/api\/v2\/projects\/([^/]+)\/studio\/runs(?:\/([^/]+)(?:\/([^/]+))?)?$/;

const FORMAT_RUN = (row) => ({
  id: row.id,
  projectId: row.project_id,
  workspaceId: row.workspace_id,
  canvasId: row.canvas_id,
  canvasRevision: row.canvas_revision,
  canvasSchemaVersion: row.canvas_schema_version,
  status: row.status,
  runMode: row.run_mode,
  requestedBy: row.requested_by,
  idempotencyKey: row.idempotency_key,
  nodeCount: row.nodes_total,
  nodeStatusCounts: row.node_status_counts || {},
  executorUnavailable: row.executor_unavailable,
  failureCode: row.failure_code || null,
  failureMessage: row.failure_message || null,
  createdAt: toIso(row.created_at),
  startedAt: toIso(row.started_at),
  completedAt: toIso(row.completed_at),
  cancelRequestedAt: toIso(row.cancel_requested_at),
  updatedAt: toIso(row.updated_at),
});

function toIso(v) { return v ? new Date(v).toISOString() : null; }

// ─────────────────────────────────────────────────────────────────────────────
// V2.0 must#2 — run 预算前置门 / 估算（估算侧与引擎共用同一纯编译函数）。
//
// 策略注（诚实边界）：
//  - 价格真源：accounting.getModelPrice（model_pricing → model_price_history →
//    models.credit_cost → 0），与 server.js L5 计费同链。金额语义与 L5 一致：
//    image 节点按件（画布 image-generation 节点无 count 字段 → 每节点 1 件）、
//    video 节点固定 1 任务（duration 不放大价格，server.js billingCount = 1）。
//    故 unitPrices 注入纯数字（每任务价 = creditPrice），不做 per-second/
//    per-image 加权 —— budgetEstimate 支持该形状。
//  - 全链无价（getModelPrice source==='none'）的模型 → 0 credit 计（不计入
//    totalUnits，但标 unpriced，前端可见）。与 L5 一致（L5 对 source 'none' 也
//    按 0 计），故不存在「门放行、L5 实扣」的偏离面。
//  - 预算不存在（无 project_budgets 行）→ 放行（NO_BUDGET 策略，不设门）。
//  - 本 API 只读估算 + 门；预算的持久扣减仍归 budgetSpentStore.recordSpend
//    （带守卫的 UPDATE，真正的并发防线）。门是保守的事前拦截，非结算。
//  - 引擎不暴露 compile-only 入口；但 compileStudioGraph（studioRunGraph.cjs
//    导出的纯函数，引擎 createRunFromCanvas 内部调用的是同一函数）可被本模块
//    只读复用：先编译闭包再估算，闭包语义（ALL/SELECTED/FROM_NODE）与引擎
//    一致。真正的 create 仍走引擎锁定事务，估算与 create 之间 revision 前进时
//    引擎照旧抛 CANVAS_REVISION_STALE（不建 run），估算永不越权建 run。
//  - 快照不可解析（canvas 不存在/revision 不一致/编译失败）→ 门 DEFER 给引擎
//    （引擎的 404/409/400 错误照旧，且不建 run），门本身不臆造 4xx。
// ─────────────────────────────────────────────────────────────────────────────

const UNITS_PER_CREDIT = 10000; // budgetEstimate 单位语义：1 credit = 10000 units（N(14,4)）
const GENERATION_IMAGE_TYPES = new Set(['image-generation']);
const GENERATION_VIDEO_TYPES = new Set(['image-to-video', 'text-to-video']);

const CANVAS_BY_PROJECT_SQL = 'SELECT id, revision, schema_version FROM studio_canvases WHERE project_id=$1 AND is_primary=TRUE AND archived_at IS NULL LIMIT 1';
const CANVAS_NODES_SQL = 'SELECT node_id, node_type, node_schema_version, data_json FROM studio_canvas_nodes WHERE canvas_id=$1';
const CANVAS_EDGES_SQL = 'SELECT edge_id, source_node_id, source_handle, target_node_id, target_handle, edge_type FROM studio_canvas_edges WHERE canvas_id=$1';
const RUN_BY_CANVAS_KEY_SQL = 'SELECT id FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2';

/**
 * 编译图 → 计费 shots（纯函数）。只把 GENERATION 节点视为可计费任务：
 *   image-generation       → { kind:'image', count:1 }（无 count 字段 → 1 件）
 *   image-to-video/text-to-video → { kind:'video', seconds:duration }
 *                              （duration 缺省取 registry 默认 5；平坦任务价下
 *                                seconds 不参与计价，仅作诚实语义保留）
 * 未来未知 GENERATION 节点类型 → 不计 shot（unmappedGenerationNodes 上报）。
 */
function deriveGenerationShots(graph) {
  const shots = [];
  let generationNodeCount = 0;
  let unmappedGenerationNodes = 0;
  const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  for (const n of nodes) {
    if (!n || n.executionKind !== 'GENERATION') continue;
    generationNodeCount += 1;
    const params = (n.input && n.input.parameters && typeof n.input.parameters === 'object') ? n.input.parameters : {};
    const model = params.logicalModelId != null ? String(params.logicalModelId).trim() : '';
    if (GENERATION_IMAGE_TYPES.has(n.nodeType)) {
      shots.push({ shotId: n.nodeId, kind: 'image', model, count: 1 });
    } else if (GENERATION_VIDEO_TYPES.has(n.nodeType)) {
      const d = params.duration;
      const seconds = (Number.isInteger(d) && d > 0) ? d : 5; // registry UI 默认 5s
      shots.push({ shotId: n.nodeId, kind: 'video', model, seconds });
    } else {
      unmappedGenerationNodes += 1;
    }
  }
  return { shots, generationNodeCount, unmappedGenerationNodes };
}

/**
 * modelIds → modelId → 每任务价（creditPrice），走 accounting 三读链
 * （model_pricing → model_price_history → models.credit_cost → 0），与 L5 计费
 * 同源。source==='none'（全链无价）→ 不注入 → 估算标 unpriced（0 units）。
 */
async function buildUnitPrices(pg, modelIds) {
  const prices = {};
  for (const mid of modelIds) {
    const p = await accounting.getModelPrice(pg, mid);
    if (p && p.source !== 'none') prices[mid] = p.creditPrice;
  }
  return prices;
}

// ─────────────────────────────────────────────────────────────────────────────
// G21 — run events SSE read side.
//
// EventSource (drill semantics): client opens GET /runs/:id/events, receives the
// full `run_events` replay (each event one SSE message, `id: <seq>` so the
// browser records Last-Event-ID), then the server polls the store every pollMs
// for a monotonically growing per-run `seq` watermark and streams the delta.
// The window is capped at maxWindowMs; the server then closes with HTTP 200 and
// the CLIENT is responsible for re-subscribing (EventSource auto-reconnects with
// Last-Event-ID, which the server honours as afterSeq).
//
// Wire format per SSE message (default `message` event — generic onmessage):
//   id: <seq>
//   data: {"seq":<seq>,"type":"...","payload":{...},"ts":"<ISO>"}
//
// Guarding: this read path deliberately runs its own ownership check instead of
// relying on the request dispatcher — a long-lived streaming response bypasses
// the normal JSON dispatch/role chain, so 404/403 must be answered here, before
// the first SSE byte. Semantics mirror the run GET handler: admin/system role
// bypasses workspace membership; any workspace_members row grants read; missing
// run → 404, missing membership → 403.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SSE_POLL_MS = 2000;
const DEFAULT_SSE_MAX_WINDOW_MS = 60000;
const DEFAULT_SSE_BATCH_LIMIT = 500;

const SSE_EVENTS_SQL = `
SELECT seq, type, payload_json, created_at
  FROM run_events
 WHERE run_id = $1 AND seq > $2
 ORDER BY seq ASC
 LIMIT $3`;

const SSE_RUN_OWNER_SQL = `
SELECT r.id AS run_id, r.project_id, p.workspace_id, w.owner_id AS workspace_owner_id
  FROM studio_runs r
  JOIN projects p ON p.id = r.project_id
  JOIN workspaces w ON w.id = p.workspace_id
 WHERE r.id = $1`;

const SSE_MEMBERSHIP_SQL = `
SELECT workspace_id, user_id, role
  FROM workspace_members
 WHERE workspace_id = $1 AND user_id = $2`;

function isAdminUser(user) {
  return Boolean(user && (user.role === 'admin' || user.role === 'system'));
}

function parsePayloadJsonValue(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
  return v === undefined || v === null ? {} : v;
}

/**
 * Run-scoped ownership guard for the SSE reader (404 unknown run, 403 run that
 * belongs to a workspace the user is not a member of; admin/system bypass).
 */
async function authorizeRunSse(pg, { runId, user }) {
  if (!user || !user.id) return { allowed: false, status: 401, error: '未登录' };
  if (typeof runId !== 'string' || !runId.trim()) return { allowed: false, status: 404, error: 'RUN_NOT_FOUND' };
  const r = await pg.query(SSE_RUN_OWNER_SQL, [runId]);
  const row = r && r.rows && r.rows[0];
  if (!row) return { allowed: false, status: 404, error: 'RUN_NOT_FOUND' };
  if (isAdminUser(user)) return { allowed: true, run: row };
  const m = await pg.query(SSE_MEMBERSHIP_SQL, [row.workspace_id, user.id]);
  if (!m || !m.rows || !m.rows.length) return { allowed: false, status: 403, error: '无项目权限' };
  return { allowed: true, run: row };
}

function writeGuardError(res, status, error) {
  if (!res || res.writableEnded) return;
  try {
    const body = JSON.stringify({ ok: false, error });
    if (!res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (typeof res.end === 'function') res.end(body);
  } catch (_) { /* client already gone — nothing to answer */ }
}

/**
 * Standalone SSE read-side factory (mount point lives in server.js / the API
 * dispatcher — see handleRunEventsSse on the API instance).
 *
 * @param {{pg: {query: Function}, store?: object}} deps
 *   `pg` is required (pool/query mock). `store` is an optional pre-built
 *   runEventStore (test seam); production builds it from pg internally.
 * @returns {{ streamRunEvents: Function }}
 *   streamRunEvents({ req, res, runId, user, opts }) → { stop, done, closed, ... }
 *   - Guarded inside (401/403/404 before any SSE byte).
 *   - Headers: text/event-stream + no-cache (same shape as monitor.cjs).
 *   - First flush = full replay of listRunEvents-equivalent rows, or resumption
 *     at afterSeq when req Last-Event-ID carries a non-negative integer.
 *   - Then polls lastSequence every pollMs (default 2s), streaming new events.
 *   - Window capped at maxWindowMs (default 60s) → 200 close; client resubscribes.
 *   - Cleanup on: explicit stop(), client disconnect (req/res close), window end.
 *   - done resolves with { reason, status } once the stream is fully torn down.
 */
function createRunEventsSse({ pg, store } = {}) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createRunEventsSse: { pg } with query() required');
  }
  const eventStore = store || createRunEventStore({ pg });
  const { lastSequence } = eventStore;

  function rowToEvent(row) {
    return {
      seq: Number(row.seq),
      type: row.type,
      payload: parsePayloadJsonValue(row.payload_json),
      ts: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    };
  }

  async function fetchEvents({ runId, afterSeq, limit }) {
    const r = await pg.query(SSE_EVENTS_SQL, [runId, afterSeq, limit]);
    return ((r && r.rows) || []).map(rowToEvent);
  }

  async function streamRunEvents({ req, res, runId, user, opts = {} } = {}) {
    const pollMs = opts && Number.isFinite(opts.pollMs) && opts.pollMs >= 5 ? opts.pollMs : DEFAULT_SSE_POLL_MS;
    const maxWindowMs = opts && Number.isFinite(opts.maxWindowMs) && opts.maxWindowMs > 0 ? opts.maxWindowMs : DEFAULT_SSE_MAX_WINDOW_MS;
    const batchLimit = opts && Number.isInteger(opts.batchLimit) && opts.batchLimit > 0
      ? Math.min(opts.batchLimit, 1000)
      : DEFAULT_SSE_BATCH_LIMIT;

    const state = { closed: false, reason: null, status: 200 };
    let resolveDone = null;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    let schedulerTimer = null;
    let headersStarted = false;

    const finish = (reason, status = 200) => {
      if (state.closed) return;
      state.closed = true;
      state.reason = reason;
      state.status = status;
      if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
      try {
        if (headersStarted && res && !res.writableEnded && typeof res.end === 'function') res.end();
      } catch (_) { /* socket already gone */ }
      if (resolveDone) resolveDone({ reason, status });
    };

    // Ownership guard FIRST — no dispatcher role gate exists for SSE, so this is
    // the only authorization surface for the stream.
    let auth;
    try {
      auth = await authorizeRunSse(pg, { runId, user });
    } catch (_) {
      auth = { allowed: false, status: 500, error: '服务内部错误' };
    }
    if (!auth.allowed) {
      state.closed = true;
      state.reason = 'guard';
      state.status = auth.status;
      writeGuardError(res, auth.status, auth.error);
      if (resolveDone) resolveDone({ reason: 'guard', status: auth.status });
      return { stop: () => {}, done, closed: () => true, reason: 'guard', status: auth.status };
    }

    // ── SSE open (house shape — see monitor.cjs). ──
    if (res && !res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    headersStarted = true;
    if (res && typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch (_) {} }

    // Client-disconnect/error listeners attach BEFORE the first replay write, so
    // an async EPIPE (socket died during replay) is never an unhandled 'error'.
    const startedAt = Date.now();
    const stop = (reason = 'stopped') => finish(reason);
    const onClientClose = () => finish('client-closed');
    if (req && typeof req.on === 'function') {
      req.on('close', onClientClose);
      req.on('error', onClientClose);
    }
    if (res && typeof res.on === 'function') {
      res.on('error', () => {}); // swallow EPIPE — cleanup already ran
      res.on('close', onClientClose);
    }

    const send = (chunk) => {
      if (state.closed || !res || res.writableEnded) return false;
      try { res.write(chunk); return true; } catch (_) { state.closed = true; return false; }
    };

    // Drain-aware write: when the transport signals backpressure (write()
    // returns false), wait for 'drain' (or close/error) before the next chunk,
    // so a full replay of a large run cannot buffer unboundedly in memory.
    const write = (chunk) => new Promise((resolve) => {
      if (state.closed || !res || res.writableEnded) { resolve(false); return; }
      let ok;
      try { ok = res.write(chunk); } catch (_) { state.closed = true; resolve(false); return; }
      if (ok === false && typeof res.once === 'function') {
        const stop = () => resolve(false);
        res.once('drain', () => resolve(true));
        res.once('close', stop);
        res.once('error', stop);
      } else {
        resolve(true);
      }
    });

    const writeEventLine = async (ev) => {
      const data = JSON.stringify({ seq: ev.seq, type: ev.type, payload: ev.payload, ts: ev.ts });
      return write(`id: ${ev.seq}\ndata: ${data}\n\n`);
    };
    const writeHeartbeat = () => send(': hb\n\n');

    // Resume cursor from Last-Event-ID; anything else → full replay from seq 1.
    const leiRaw = req && req.headers ? req.headers['last-event-id'] : undefined;
    const lei = Array.isArray(leiRaw) ? leiRaw[0] : leiRaw;
    let cursor = 0;
    if (lei !== undefined && lei !== null && String(lei).trim() !== '') {
      const n = Number(String(lei).trim());
      // isSafeInteger (not isInteger) rejects values beyond 2^53-1 and any
      // non-integral / NaN / infinite token — a huge Last-Event-ID would
      // otherwise overflow BIGINT in `seq > $2` and 500 the stream, instead of
      // degrading to a full replay.
      if (Number.isSafeInteger(n) && n >= 0) cursor = n;
    }

    const sendUpTo = async (after) => {
      let pages = 0;
      while (!state.closed && pages < 10000) {
        const rows = await fetchEvents({ runId, afterSeq: after, limit: batchLimit });
        if (!rows.length) break;
        for (const ev of rows) {
          if (!(await writeEventLine(ev))) return after; // socket gone mid-replay
          after = ev.seq;
        }
        if (rows.length < batchLimit) break;
        pages += 1;
      }
      return after;
    };

    try {
      cursor = await sendUpTo(cursor);
    } catch (_) {
      // Replay read failed — close the stream (client re-subscribes via drill).
      state.closed = true;
      state.reason = 'replay-failed';
      state.status = 500;
      try { if (res && !res.writableEnded && typeof res.end === 'function') res.end(); } catch (_) {}
      if (resolveDone) resolveDone({ reason: 'replay-failed', status: 500 });
      return { stop: () => {}, done, closed: () => true, reason: 'replay-failed', status: 500 };
    }

    send('retry: 2000\n\n'); // EventSource reconnect hint for the next drill

    const poll = async () => {
      if (state.closed) return;
      try {
        const last = await lastSequence({ runId });
        const lastSeq = last && Number(last.seq) || 0;
        if (lastSeq > cursor) cursor = await sendUpTo(cursor);
      } catch (_) {
        // transient DB error — keep the stream alive, retry next cycle
      }
      writeHeartbeat();
    };

    const scheduleNext = () => {
      if (state.closed) return;
      schedulerTimer = setTimeout(async () => {
        schedulerTimer = null;
        if (state.closed) return;
        if (Date.now() - startedAt >= maxWindowMs) { finish('max-window'); return; }
        await poll();
        scheduleNext();
      }, pollMs);
    };
    scheduleNext();

    return {
      stop,
      done,
      closed: () => state.closed,
      reason: () => state.reason,
      status: state.status,
      afterSeq: () => cursor,
    };
  }

  return { streamRunEvents };
}

function formatRunNode(r) {
  const out = {
    id: r.id,
    studioNodeId: r.studio_node_id,
    nodeType: r.node_type,
    executionKind: r.execution_kind,
    status: r.status,
    dependencyCount: r.dependency_count,
    remainingDependencyCount: r.remaining_dependency_count,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    errorCode: r.error_code || null,
    errorMessage: r.error_message || null,
    startedAt: toIso(r.started_at),
    completedAt: toIso(r.completed_at),
  };
  if (r.result_json) {
    // Safe by construction (deterministic test/source/asset results);
    // strip any accidental URL authority defensively.
    out.result = sanitizeResult(r.result_json);
  }
  return out;
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return result;
  try {
    return JSON.parse(String(JSON.stringify(result)).replace(/https?:\/\/[^\s"'<>]+/gi, '[URL_REDACTED]'));
  } catch (_) { return result; }
}

function sendErr(sendJSON, res, status, error, extra = {}) {
  return sendJSON(res, status, { ok: false, error, ...extra });
}

function createStudioRunApi(deps) {
  const { pg, sessionUser, sendJSON, parseBody, engine, logEvent } = deps;
  const runLimits = {
    maxNodes: Number(process.env.STUDIO_RUN_API_MAX_NODES || GRAPH_LIMITS.maxNodes),
    maxSelectedIds: Number(process.env.STUDIO_RUN_MAX_SELECTED_IDS || 500),
  };

  function requireUser(req, res) {
    const user = sessionUser(req);
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    return user;
  }
  function isAdmin(user) { return user && (user.role === 'admin' || user.role === 'system'); }
  async function getMembership(client, userId, workspaceId) {
    const r = await client.query('SELECT workspace_id,user_id,role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
    return r.rows[0] || null;
  }
  async function requireProject(client, res, user, projectId) {
    const r = await client.query('SELECT p.*, w.owner_id AS workspace_owner_id FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1', [projectId]);
    if (!r.rows.length) return sendErr(sendJSON, res, 404, '项目不存在'), null;
    const project = r.rows[0];
    const membership = isAdmin(user) ? { role: 'owner' } : await getMembership(client, user.id, project.workspace_id);
    if (!membership) return sendErr(sendJSON, res, 403, '无项目权限'), null;
    const owner = membership.role === 'owner' || isAdmin(user);
    return { project, membership, permissions: { role: membership.role, canRead: true, canUpdate: owner && project.status !== 'archived', canCancel: owner && project.status !== 'archived' } };
  }
  async function emit(eventType, payload) {
    if (!logEvent) return;
    try { await logEvent(pg, { aggregate: 'studio_run', eventType, payload }); } catch (_) {}
  }

  // ── V2.0 must#2 — run 闭包估算 + 预算门 ──────────────────────────────

  /**
   * 只读解析项目主 canvas 的指定 revision，编译 run 闭包并估算计费 units。
   * 与引擎 createRunFromCanvas 共用 compileStudioGraph 纯函数（引擎不暴露
   * compile-only），闭包语义（ALL/SELECTED/FROM_NODE）逐字节一致。本函数
   * 只读、不加锁 —— 真正的 create 仍在引擎锁定事务内，revision 竞态由引擎
   * 的 CANVAS_REVISION_STALE 兜底（不建 run）。
   *
   * @returns {Promise<{ok:true, canvas, runMode, selectedNodeIds, nodeCount,
   *   generationNodeCount, unmappedGenerationNodes, shotCount, estimate, shots}
   *   | {ok:false, error:{code, ...}}>}
   *   estimate 为 estimateRun 的返回（totalUnits 单位 = budgetEstimate units，
   *   1 credit = 10000 units）。
   */
  async function estimateProjectRunClosure({ projectId, requestedCanvasRevision, runMode = 'ALL', selectedNodeIds = [] }) {
    const cr = await pg.query(CANVAS_BY_PROJECT_SQL, [projectId]);
    const canvas = cr && cr.rows && cr.rows[0];
    if (!canvas) return { ok: false, error: { code: 'CANVAS_NOT_FOUND' } };
    const canvasRevision = Number(canvas.revision);
    if (requestedCanvasRevision != null && requestedCanvasRevision !== canvasRevision) {
      return { ok: false, error: { code: 'CANVAS_REVISION_STALE', canvasId: canvas.id, currentRevision: canvasRevision } };
    }
    const [nr, er] = await Promise.all([
      pg.query(CANVAS_NODES_SQL, [canvas.id]),
      pg.query(CANVAS_EDGES_SQL, [canvas.id]),
    ]);
    const nodes = ((nr && nr.rows) || []).map((r) => ({
      nodeId: r.node_id, nodeType: r.node_type, nodeSchemaVersion: r.node_schema_version,
      data: (r.data_json && typeof r.data_json === 'object') ? r.data_json : {},
    }));
    const edges = ((er && er.rows) || []).map((r) => ({
      edgeId: r.edge_id, sourceNodeId: r.source_node_id, sourceHandle: r.source_handle,
      targetNodeId: r.target_node_id, targetHandle: r.target_handle, edgeType: r.edge_type,
    }));
    const compiled = compileStudioGraph({
      canvasId: canvas.id, canvasRevision, canvasSchemaVersion: Number(canvas.schema_version) || 1,
      runMode, selectedNodeIds, nodes, edges, maxAttempts: 3,
    });
    if (!compiled.ok) return { ok: false, error: { code: compiled.error.code, nodeIds: compiled.error.nodeIds || [] } };
    const { shots, generationNodeCount, unmappedGenerationNodes } = deriveGenerationShots(compiled.graph);
    const modelIds = Array.from(new Set(shots.map((s) => s.model).filter(Boolean)));
    const unitPrices = await buildUnitPrices(pg, modelIds);
    const estimate = estimateRun({ shots, unitPrices, unitsPerCredit: UNITS_PER_CREDIT });
    return {
      ok: true,
      canvas: { id: canvas.id, revision: canvasRevision },
      runMode,
      selectedNodeIds,
      nodeCount: compiled.graph.nodeCount,
      generationNodeCount,
      unmappedGenerationNodes,
      shotCount: shots.length,
      estimate,
      shots,
    };
  }

  /**
   * POST create 预算门。返回：
   *   { policy:'NO_BUDGET' }                         无 project_budgets 行 → 放行
   *   { policy:'BUDGETED', reason:'IDEMPOTENT_REPLAY' } 同 (canvas,key) 已有 run → 放行（引擎回放）
   *   { policy:'BUDGETED', reason:'DEFER_ENGINE', deferCode }  快照不可解析/编译失败 → 放行给引擎报错
   *   { policy:'BUDGETED', blocked:false, estimateUnits, remainingUnits }
   *   { policy:'BUDGETED', blocked:true,  estimateUnits, remainingUnits }  → 409
   */
  async function runBudgetGate({ projectId, canvasId, idempotencyKey, requestedCanvasRevision, runMode, selectedNodeIds }) {
    const budget = await getBudgetSpent(pg, projectId);
    if (!budget) return { policy: 'NO_BUDGET' }; // 策略：无预算行 → 不设预算门
    // 幂等重放：同 (canvas, key) 已建 run 时引擎回放旧 run（不新执行），不拦。
    const prior = await pg.query(RUN_BY_CANVAS_KEY_SQL, [canvasId, idempotencyKey]);
    if (prior && prior.rows && prior.rows.length) return { policy: 'BUDGETED', reason: 'IDEMPOTENT_REPLAY' };
    const est = await estimateProjectRunClosure({ projectId, requestedCanvasRevision, runMode, selectedNodeIds });
    if (!est.ok) return { policy: 'BUDGETED', reason: 'DEFER_ENGINE', deferCode: est.error.code }; // 引擎 404/409/400，不建 run
    const remainingUnits = creditsToUnits(budget.remaining, UNITS_PER_CREDIT);
    const estimateUnits = est.estimate.totalUnits;
    if (estimateUnits > remainingUnits) return { policy: 'BUDGETED', blocked: true, estimateUnits, remainingUnits };
    return { policy: 'BUDGETED', blocked: false, estimateUnits, remainingUnits };
  }

  async function handleCreate(req, res, user, projectId) {
    const body = (await parseBody(req)) || {};
    const idempotencyKey = String(body.idempotencyKey || '').trim();
    const runMode = String(body.runMode || 'ALL');
    const requestedCanvasRevision = Number(body.canvasRevision);
    if (!idempotencyKey || idempotencyKey.length > 128) return sendErr(sendJSON, res, 400, 'INVALID_IDEMPOTENCY_KEY');
    if (!['ALL', 'SELECTED', 'FROM_NODE'].includes(runMode)) return sendErr(sendJSON, res, 400, 'INVALID_RUN_MODE');
    if (!Number.isInteger(requestedCanvasRevision) || requestedCanvasRevision < 1) return sendErr(sendJSON, res, 400, 'INVALID_CANVAS_REVISION');
    const selectedNodeIds = Array.isArray(body.selectedNodeIds) ? body.selectedNodeIds.map((s) => String(s).trim()).filter(Boolean).slice(0, runLimits.maxSelectedIds) : undefined;
    if (runMode !== 'ALL' && (!selectedNodeIds || !selectedNodeIds.length)) return sendErr(sendJSON, res, 400, 'INVALID_SELECTION');

    // Authorization (read-only): project scope + primary canvas id.
    // The AUTHORITATIVE revision trust boundary is in the engine
    // (createRunFromCanvas): it locks the canvas row (FOR UPDATE), verifies
    // the requested revision against the authoritative row, loads the exact
    // nodes/edges of that locked revision, compiles, and persists the Run in
    // ONE transaction. The API never supplies nodes/edges or a verified
    // revision to the engine — it only requests.
    const client = await pg.connect();
    let access = null;
    let canvasId = null;
    try {
      access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');
      const cr = await client.query('SELECT id FROM studio_canvases WHERE project_id=$1 AND is_primary=TRUE AND archived_at IS NULL LIMIT 1', [projectId]);
      canvasId = cr.rows[0] ? cr.rows[0].id : null;
    } finally { client.release(); }
    if (!canvasId) return sendErr(sendJSON, res, 404, 'CANVAS_NOT_FOUND');

    // ── V2.0 must#2 预算前置门 ─────────────────────────────────────────
    // 项目有 project_budgets 行时：依 run 闭包 GENERATION 节点估算（models
    // credit_cost 每任务价，单位换算见预算区块头注）→ 估算 > 剩余则 409 且不建
    // run。无预算行 → NO_BUDGET 放行；快照不可解析/编译失败 → DEFER 引擎报错
    // （引擎 404/409/400 且不建 run）。预算读取自身故障 → fail-open 放行并告警：
    // 门是叠加护栏，持久扣减防线仍在 budgetSpentStore.recordSpend，绝不让预算
    // 读故障把 studio 运行整体打挂。
    let gate = null;
    try {
      gate = await runBudgetGate({
        projectId, canvasId, idempotencyKey, requestedCanvasRevision,
        runMode, selectedNodeIds: runMode !== 'ALL' ? selectedNodeIds : [],
      });
    } catch (e) {
      console.error('[studio-runs] budget gate read failed — fail-open create:', e && e.stack);
      // 结构化告警：fail-open 是无声的预算绕过面（recordSpend 尚未接入生产 create
      // 路径，门是当前唯一拦截），必须落一条可观测事件，不能只 console.error。
      await emit('studio.run.budget_gate_fail_open', {
        project_id: projectId, canvas_id: canvasId, actor_id: user.id,
        error: e && e.message, timestamp: new Date().toISOString(),
      });
    }
    if (gate && gate.blocked) {
      return sendErr(sendJSON, res, 409, 'BUDGET_INSUFFICIENT', {
        estimateUnits: gate.estimateUnits,
        remainingUnits: gate.remainingUnits,
      });
    }

    let created;
    try {
      created = await engine.createRunFromCanvas({
        project: access.project,
        canvasId,
        requestedCanvasRevision,
        runMode,
        selectedNodeIds,
        idempotencyKey,
        requestedBy: user.id,
      });
    } catch (e) {
      const code = e && e.code;
      if (code === 'CANVAS_NOT_FOUND') return sendErr(sendJSON, res, 404, 'CANVAS_NOT_FOUND');
      if (code === 'CANVAS_REVISION_STALE') return sendErr(sendJSON, res, 409, 'CANVAS_REVISION_STALE', { canvasId, serverRevision: e.currentRevision, requestedRevision: e.requestedRevision });
      if (code && ['INVALID_SELECTION', 'INVALID_RUN_MODE', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_CANVAS_REVISION', 'INVALID_RUN_INPUT', 'INVALID_CANVAS_ID'].includes(code)) return sendErr(sendJSON, res, 400, code);
      if (code && ['DAG_CYCLE_DETECTED', 'UNKNOWN_NODE_TYPE', 'UNKNOWN_NODE_ID', 'UNKNOWN_PORT', 'SCHEMA_VERSION_MISMATCH', 'DUPLICATE_NODE_ID', 'DUPLICATE_EDGE_ID', 'DANGLING_EDGE', 'EDGE_TYPE_INCOMPATIBLE', 'REQUIRED_PORT_MISSING', 'OUTPUT_INPUT_MISSING', 'GRAPH_TOO_LARGE', 'INVALID_COMPILE_INPUT', 'COMPILE_FAILED'].includes(code)) {
        return sendErr(sendJSON, res, 400, code, { nodeIds: (e.structured && e.structured.nodeIds) || [] });
      }
      if (e.code === '23503') return sendErr(sendJSON, res, 400, 'INTEGRITY_ERROR');
      throw e;
    }

    const status = created.idempotent ? 200 : (created.status === 'COMPLETED' ? 201 : 202);
    await emit('studio.run.created', { canvas_id: canvasId, project_id: projectId, workspace_id: access.project.workspace_id, run_id: created.runId, revision: created.canvasRevision, actor_id: user.id, timestamp: new Date().toISOString() });
    const snapshot = created.idempotent ? null : await engine.getRunSnapshot(created.runId);
    return sendJSON(res, status, {
      ok: true,
      run: snapshot ? FORMAT_RUN(snapshot.run) : { id: created.runId, status: created.status, canvasId, canvasRevision: created.canvasRevision, idempotencyKey, runMode },
      idempotent: created.idempotent,
      nodes: snapshot ? snapshot.nodes.map(formatRunNode) : undefined,
    });
  }

  async function handleList(req, res, user, projectId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      const q = req.query || {};
      const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
      const offset = Math.max(Number(q.offset) || 0, 0);
      const statusFilter = q.status ? String(q.status).toUpperCase() : null;
      const params = [projectId];
      let where = 'WHERE project_id=$1';
      if (statusFilter) { params.push(statusFilter); where += ` AND status=$${params.length}`; }
      const cr = await client.query(`SELECT COUNT(*)::int AS total FROM studio_runs ${where}`, params);
      const r = await client.query(`SELECT * FROM studio_runs ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
      return sendJSON(res, 200, { runs: r.rows.map(FORMAT_RUN), pagination: { limit, offset, total: cr.rows[0].total, hasMore: offset + r.rows.length < cr.rows[0].total } });
    } finally { client.release(); }
  }

  async function handleGet(req, res, user, projectId, runId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      const snapshot = await engine.getRunSnapshot(runId);
      if (!snapshot || snapshot.run.project_id !== access.project.id || snapshot.run.workspace_id !== access.project.workspace_id) {
        return sendErr(sendJSON, res, 404, 'RUN_NOT_FOUND');
      }
      const counts = {};
      for (const n of snapshot.nodes) counts[n.status] = (counts[n.status] || 0) + 1;
      return sendJSON(res, 200, {
        ok: true,
        run: { ...FORMAT_RUN(snapshot.run), nodeStatusCounts: counts },
        nodes: snapshot.nodes.map(formatRunNode),
        permissions: access.permissions,
      });
    } finally { client.release(); }
  }

  async function handleCancel(req, res, user, projectId, runId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canCancel) return sendErr(sendJSON, res, 403, '无权取消该 Run');
      const r0 = await client.query('SELECT id FROM studio_runs WHERE id=$1 AND project_id=$2', [runId, projectId]);
      if (!r0.rows.length) return sendErr(sendJSON, res, 404, 'RUN_NOT_FOUND');
      const result = await engine.requestRunCancellation(runId);
      if (!result.ok) return sendErr(sendJSON, res, 404, 'RUN_NOT_FOUND');
      await emit('studio.run.cancel_requested', { project_id: projectId, workspace_id: access.project.workspace_id, run_id: runId, actor_id: user.id, timestamp: new Date().toISOString() });
      return sendJSON(res, 200, { ok: true, status: result.status, cancelledNodes: result.cancelledNodes });
    } finally { client.release(); }
  }

  /**
   * V2.0 must#2 — GET /api/v2/projects/:projectId/studio/runs/estimate
   * （估算端点，与 create 同鉴权但只读：requireProject 通过即可，无需 owner）。
   *
   * 入参（GET，body 或 query 均可，body 优先）：{ runMode?, canvasRevision?,
   * selectedNodeIds? }。缺省 runMode='ALL'；canvasRevision 缺省用主 canvas
   * 当前 revision。
   *
   * 服务端按闭包真实编译（compileStudioGraph 纯函数，同引擎）估算，不是让前端
   * 自己算：ALL/SELECTED/FROM_NODE 的闭包语义在服务端逐字节与 create 一致。
   *
   * 200 形状：
   *   { ok, canvas:{id,revision}, run:{runMode,selectedNodeIds,nodeCount,
   *       generationNodeCount}, estimate:{shotCount,totalUnits,perKind,
   *       hasUnpriced,unpricedModelIds,breakdown,thresholdUnits,
   *       needsConfirmation},
   *     budget:{exists, policy:'BUDGETED'|'NO_BUDGET', budgetUnits,
   *       spentUnits, remainingUnits, blocked} }
   *   有预算时 blocked = estimate.totalUnits > remainingUnits（与 create 门同判据）。
   */
  async function handleEstimate(req, res, user, projectId) {
    const body = (await parseBody(req)) || {};
    const q = (req && req.query) || {};
    const runMode = String(body.runMode || q.runMode || 'ALL');
    let requestedCanvasRevision = null;
    const brv = body.canvasRevision != null ? body.canvasRevision : q.canvasRevision;
    if (brv != null && brv !== '') requestedCanvasRevision = Number(brv);
    const rawSelection = Array.isArray(body.selectedNodeIds) ? body.selectedNodeIds : [];
    const selectedNodeIds = rawSelection.map((s) => String(s).trim()).filter(Boolean).slice(0, runLimits.maxSelectedIds);

    if (!['ALL', 'SELECTED', 'FROM_NODE'].includes(runMode)) return sendErr(sendJSON, res, 400, 'INVALID_RUN_MODE');
    if (requestedCanvasRevision != null && (!Number.isInteger(requestedCanvasRevision) || requestedCanvasRevision < 1)) {
      return sendErr(sendJSON, res, 400, 'INVALID_CANVAS_REVISION');
    }
    if (runMode !== 'ALL' && !selectedNodeIds.length) return sendErr(sendJSON, res, 400, 'INVALID_SELECTION');

    const client = await pg.connect();
    let access = null;
    try {
      access = await requireProject(client, res, user, projectId);
      if (!access) return;
    } finally { client.release(); }

    let est;
    try {
      est = await estimateProjectRunClosure({ projectId, requestedCanvasRevision, runMode, selectedNodeIds });
    } catch (e) {
      console.error('[studio-runs] estimate failed:', e && e.stack);
      throw e; // 兜底 500（handle 顶层）
    }
    if (!est.ok) {
      if (est.error.code === 'CANVAS_NOT_FOUND') return sendErr(sendJSON, res, 404, 'CANVAS_NOT_FOUND');
      if (est.error.code === 'CANVAS_REVISION_STALE') {
        return sendErr(sendJSON, res, 409, 'CANVAS_REVISION_STALE', {
          canvasId: est.error.canvasId, serverRevision: est.error.currentRevision, requestedRevision: requestedCanvasRevision,
        });
      }
      return sendErr(sendJSON, res, 400, est.error.code, { nodeIds: est.error.nodeIds || [] });
    }

    const budget = await getBudgetSpent(pg, projectId);
    const unpricedModelIds = [];
    est.estimate.breakdown.forEach((b, i) => { if (b.unpriced) unpricedModelIds.push(est.shots[i] && est.shots[i].model); });
    const breakdown = est.estimate.breakdown.map((b, i) => {
      const s = est.shots[i] || {};
      const out = { ...b };
      if (s.seconds != null) out.seconds = s.seconds;
      if (s.count != null) out.count = s.count;
      return out;
    });

    const estimate = {
      shotCount: est.shotCount,
      totalUnits: est.estimate.totalUnits,
      perKind: est.estimate.perKind,
      hasUnpriced: est.estimate.hasUnpriced,
      unpricedModelIds: Array.from(new Set(unpricedModelIds.filter(Boolean))),
      breakdown,
      thresholdUnits: est.estimate.thresholdUnits,
      needsConfirmation: est.estimate.needsConfirmation,
    };

    if (!budget) {
      return sendJSON(res, 200, {
        ok: true,
        canvas: est.canvas,
        run: { runMode, selectedNodeIds, nodeCount: est.nodeCount, generationNodeCount: est.generationNodeCount },
        estimate,
        budget: { exists: false, policy: 'NO_BUDGET' },
      });
    }
    const budgetUnits = creditsToUnits(budget.budget, UNITS_PER_CREDIT);
    const spentUnits = creditsToUnits(budget.spent, UNITS_PER_CREDIT);
    const remainingUnits = creditsToUnits(budget.remaining, UNITS_PER_CREDIT);
    return sendJSON(res, 200, {
      ok: true,
      canvas: est.canvas,
      run: { runMode, selectedNodeIds, nodeCount: est.nodeCount, generationNodeCount: est.generationNodeCount },
      estimate,
      budget: {
        exists: true,
        policy: 'BUDGETED',
        budgetUnits,
        spentUnits,
        remainingUnits,
        blocked: est.estimate.totalUnits > remainingUnits,
      },
    });
  }

  /**
   * G21 — run events SSE. Mount point is wired by server.js/dispatcher; this is
   * the handler that owns authorization (no dispatcher role gate for SSE).
   * `user` may be pre-resolved by the caller; otherwise resolved from the
   * session cookie exactly like every other studio/runs read (run GET).
   * Returns the stream control handle ({ stop, done, closed }) from
   * createRunEventsSse, or null when unauthenticated (401 already written).
   */
  async function handleRunEventsSse(req, res, { runId, user } = {}) {
    const u = user || requireUser(req, res);
    if (!u) return null;
    return createRunEventsSse({ pg }).streamRunEvents({ req, res, runId, user: u });
  }

  async function handle(req, res, urlPath, method) {
    const m = urlPath.match(RUNS_RE);
    if (!m) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const projectId = decodeURIComponent(m[1]);
    const runId = m[2] ? decodeURIComponent(m[2]) : null;
    const seg2 = m[3];
    try {
      if (!runId && method === 'GET') return await handleList(req, res, user, projectId), true;
      if (!runId && method === 'POST') return await handleCreate(req, res, user, projectId), true;
      if (runId && seg2 === 'events' && method === 'GET') {
        // SSE: handleRunEventsSse guards + streams; awaited here only for its
        // (fast) setup — the stream itself keeps running until stop/disconnect/60s.
        await handleRunEventsSse(req, res, { runId, user });
        return true;
      }
      if (runId && !seg2 && method === 'GET' && runId === 'estimate') return await handleEstimate(req, res, user, projectId), true;
      if (runId && !seg2 && method === 'GET') return await handleGet(req, res, user, projectId, runId), true;
      if (runId && seg2 === 'cancel' && method === 'POST') return await handleCancel(req, res, user, projectId, runId), true;
      return sendJSON(res, 404, { ok: false, error: 'Not Found' }), true;
    } catch (e) {
      console.error('[studio-runs] route error:', e && e.stack);
      if (res && res.headersSent) {
        try { res.end(); } catch (_) {}
        return true;
      }
      return sendJSON(res, 500, { ok: false, error: '服务内部错误' }), true;
    }
  }
  return { handle, FORMAT_RUN, formatRunNode, handleRunEventsSse };
}

module.exports = { createStudioRunApi, createRunEventsSse, FORMAT_RUN, formatRunNode };
