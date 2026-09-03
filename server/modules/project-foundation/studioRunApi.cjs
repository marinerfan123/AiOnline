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
const { LIMITS: GRAPH_LIMITS } = require('./studioRunGraph.cjs');
const { createRunEventStore } = require('./runEventStore.cjs');

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
