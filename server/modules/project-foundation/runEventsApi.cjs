'use strict';
/**
 * G21-READ — Studio run events REST read API (JSON pages over run_events).
 *
 * Endpoints (both under the run event store's seq-ordered log):
 *   GET /api/v2/projects/:projectId/studio/runs/:runId/events?afterSeq=&limit=
 *        → forward page: events with seq > afterSeq (exclusive cursor), ASC.
 *          limit default 200, hard cap 200. HasMore = a further page exists.
 *   GET /api/v2/projects/:projectId/studio/runs/:runId/events/latest?limit=
 *        → tail page: the LAST ≤50 events, seq DESC (newest first).
 *          limit default 50, hard cap 50. HasMore = older events exist
 *          beyond the returned window.
 *
 * 200 body (exact wire shape, no `ok` flag — list read):
 *   { events: [{ seq, kind, status?, nodeId?, tsMs }], hasMore }
 *     seq    = per-run monotonic seq (run_events.seq, int)
 *     kind   = run_events.type verbatim ('studio.run.started',
 *              'studio.run_node.succeeded', 'studio.run.status', ...)
 *     status = payload.status (non-empty string) — run/status transitions
 *              and any event whose payload carries a status; omitted otherwise
 *     nodeId = payload.run_node_id (non-empty string) — set for node-scoped
 *              events (relay folds engine runNodeId into payload.run_node_id);
 *              omitted otherwise. Run-status events that were emitted with a
 *              triggering runNodeId also carry it (engine emitEvent folds).
 *     tsMs   = run_events.created_at as epoch milliseconds (int)
 *
 * Non-200:
 *   401 { ok:false, error:'未登录' }           — only when sessionUser hook set
 *   403 { ok:false, error:'无项目权限' }        — authProject hook denial default
 *   404 { ok:false, error:'RUN_NOT_FOUND' }   — no such run / run not under
 *                                               :projectId (no cross-project leak)
 *   400 { ok:false, error:'INVALID_AFTER_SEQ' } — afterSeq not a ≥0 safe int
 *   500 { ok:false, error:'服务内部错误' }
 *
 * AUTH — double-hook convention. NOTE the hook signature DIFFERS from
 * canvasCommandLogApi: that leaf takes authProject(req, projectId) (two args,
 * { ok:false } deny shape); THIS leaf takes authProject(ctx) (one context
 * object, { allowed:false } deny shape). The factory takes two OPTIONAL hooks;
 * when either is omitted the request is ALLOWED (缺省放行) and the missing
 * scope is not enforced:
 *   sessionUser(req) → user|null        identity hook. When provided, a request
 *     without a session is answered 401 BEFORE any read. When omitted, no
 *     identity is required (user passed to authProject is null).
 *   authProject(ctx) → allow/deny       project-scope hook. ctx =
 *     { projectId, runId, user, req }. May be async. Resolutions:
 *       null / undefined / true  / { allowed:true  }  → allow
 *       false / { allowed:false } / { ok:false }       → deny (403; { ok:false }
 *                                                        accepted defensively,
 *                                                        fail-closed)
 *       { allowed:false, status, error }              → deny with given status/error
 *     When omitted, project scope is NOT gated (缺省放行 — dev/test default).
 *     ⚠️ A production mount MUST inject a membership gate here (mirror the
 *     G24 /export pattern: project + workspace_members, foreign → 404 no leak)
 *     or the API reads any project's run events.
 *     ⚠️ Wiring hazard (audit 2026-09-04, CRITICAL): authProject is invoked with
 *     ONE argument (ctx). A mount that wires it with the canvasCommandLogApi
 *     two-arg shape `(req, projectId) => …` receives the ctx object as `req`
 *     and `undefined` as `projectId` — the membership gate then fails every
 *     request (500/403). server.js must pass `(ctx) => membership(ctx.projectId,
 *     ctx.user)`, NOT the `(req, projectId)` shape.
 *
 * RUN-OWNERSHIP 404 is structural and ALWAYS enforced (never hooked): the run
 * must exist in studio_runs AND its project_id must equal :projectId, so an
 * authenticated-but-wrong-scope run id answers 404 (no existence leak), same
 * as the run GET handler.
 *
 * Read path does NOT touch runEventStore.cjs (its listRunEvents has no
 * created_at and no DESC tail) — queries mirror createRunEventsSse in
 * studioRunApi.cjs and read run_events directly. runEventStore / engine /
 * server.js are untouched; this module's handle() is exported for a future
 * mount (dispatcher leaf), exactly like presenceApi.cjs ("不挂载, handle 导出").
 *
 * ⚠️ Mount-order note for the integration leaf: studioRunApi.handle currently
 * answers GET /runs/:runId/events as SSE. When this JSON face is mounted it
 * must take precedence (order runEventsApi BEFORE studioRunApi in server.js)
 * and the SSE dispatch should move to its own path — not this leaf's concern.
 */

const EVENTS_PATH_RE =
  /^\/api\/v2\/projects\/([^/]+)\/studio\/runs\/([^/]+)\/events(?:\/(latest))?$/;

// Wire caps (see header). Exported so tests pin the contract.
const LIMITS = Object.freeze({
  PAGE_MAX: 200,    // GET /events?limit=  hard cap
  PAGE_DEFAULT: 200,
  TAIL_MAX: 50,     // GET /events/latest   hard cap (desc tail ≤ 50)
  TAIL_DEFAULT: 50,
});

const RUN_OWNER_SQL =
  'SELECT 1 FROM studio_runs WHERE id = $1 AND project_id = $2';

const PAGE_SQL = `
SELECT seq, type, payload_json, created_at
  FROM run_events
 WHERE run_id = $1 AND seq > $2
 ORDER BY seq ASC
 LIMIT $3`;

const TAIL_SQL = `
SELECT seq, type, payload_json, created_at
  FROM run_events
 WHERE run_id = $1
 ORDER BY seq DESC
 LIMIT $2`;

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function parsePayloadJsonValue(v) {
  // node-pg returns jsonb already parsed; mocks / odd drivers may hand back strings.
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
  return v === undefined || v === null ? {} : v;
}

function tsMs(v) {
  if (v === undefined || v === null) return Date.now();
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? Math.round(t) : Date.now();
}

/**
 * Store row → wire event. Optional fields (status?/nodeId?) are OMITTED (not
 * null) when the payload does not carry them, per the wire contract.
 */
function rowToApiEvent(row) {
  const payload = parsePayloadJsonValue(row && row.payload_json);
  const out = {
    seq: Number(row.seq),
    kind: row.type,
    tsMs: tsMs(row.created_at),
  };
  if (isNonEmptyString(payload.status)) out.status = payload.status;
  if (isNonEmptyString(payload.run_node_id)) out.nodeId = payload.run_node_id;
  return out;
}

/** First scalar query value (duplicate keys → first wins; '' → undefined). */
function scalar(q, key) {
  const v = q && q[key];
  if (Array.isArray(v)) return v.length ? v[0] : undefined;
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s === '' ? undefined : s;
}

/** int param with [min..max] cap; unset/invalid → fallback. Returns capped int. */
function boundedInt(raw, fallback, max) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** afterSeq must be a ≥0 safe integer when present (BIGINT-overflow guard). */
function parseAfterSeq(raw) {
  if (raw === undefined) return { ok: true, afterSeq: 0 };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    return { ok: false, error: 'INVALID_AFTER_SEQ' };
  }
  return { ok: true, afterSeq: n };
}

function writeJson(res, status, body) {
  if (!res || res.writableEnded) return;
  try {
    if (!res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (typeof res.end === 'function') {
      res.end(body === undefined ? '' : JSON.stringify(body));
    }
  } catch (_) { /* client already gone — nothing to answer */ }
}

/**
 * Create the run-events JSON read API.
 * @param {{pg: {query:Function}, sessionUser?: Function, authProject?: Function,
 *          sendJSON?: Function}} deps
 *   pg           — required, query-capable (pool or mock).
 *   sessionUser  — optional identity hook (see header AUTH). Absent → no 401 gate.
 *   authProject  — optional project-scope hook (see header AUTH). Absent →
 *                  allow (缺省放行 — production mount must inject a gate).
 *   sendJSON     — optional (res, status, body) writer; defaults to an internal
 *                  res.writeHead/end JSON writer (same shape as guard writers).
 * @returns {{ handle: Function, LIMITS: object }}
 *   handle(req, res, urlPath, method) → Promise<true|false>
 *     true = claimed & answered; false = not this module's URL (dispatcher may
 *     try the next handler).
 */
function createRunEventsApi({ pg, sessionUser, authProject, sendJSON } = {}) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createRunEventsApi: { pg } with query() required');
  }
  const send = typeof sendJSON === 'function' ? sendJSON : writeJson;

  async function resolveUser(req) {
    if (typeof sessionUser !== 'function') return { user: null };
    const user = await sessionUser(req);
    if (!user) return { denied: 401 };
    return { user };
  }

  /** Normalize authProject resolutions (see header AUTH). */
  async function gateProject(ctx) {
    if (typeof authProject !== 'function') {
      return { allowed: true }; // 缺省放行 — see header AUTH note
    }
    const d = await authProject(ctx);
    if (d === null || d === undefined || d === true) return { allowed: true };
    if (d === false) return { allowed: false, status: 403, error: '无项目权限' };
    if (d && typeof d === 'object' && (d.allowed === false || d.ok === false)) {
      const status = Number.isInteger(d.status) && d.status >= 400 ? d.status : 403;
      const error = typeof d.error === 'string' && d.error.length > 0
        ? d.error
        : (d.ok === false ? 'FORBIDDEN' : '无项目权限');
      return { allowed: false, status, error };
    }
    return { allowed: true };
  }

  /** Run must exist AND belong to :projectId — always enforced (no-leak 404). */
  async function runUnderProject(runId, projectId) {
    const r = await pg.query(RUN_OWNER_SQL, [runId, projectId]);
    return Boolean(r && r.rows && r.rows.length);
  }

  async function readPage({ runId, afterSeq, limit }) {
    const r = await pg.query(PAGE_SQL, [runId, afterSeq, limit]);
    return ((r && r.rows) || []).map(rowToApiEvent);
  }

  async function readTail({ runId, limit }) {
    const r = await pg.query(TAIL_SQL, [runId, limit]);
    return ((r && r.rows) || []).map(rowToApiEvent);
  }

  async function handleEventsPage(req, res, projectId, runId) {
    const q = (req && req.query) || {};
    const after = parseAfterSeq(scalar(q, 'afterSeq'));
    if (!after.ok) { send(res, 400, { ok: false, error: after.error }); return; }
    const limit = boundedInt(scalar(q, 'limit'), LIMITS.PAGE_DEFAULT, LIMITS.PAGE_MAX);

    if (!(await runUnderProject(runId, projectId))) {
      send(res, 404, { ok: false, error: 'RUN_NOT_FOUND' });
      return;
    }
    // Fetch one extra row to compute hasMore without a second COUNT query.
    const events = await readPage({ runId, afterSeq: after.afterSeq, limit: limit + 1 });
    const hasMore = events.length > limit;
    if (hasMore) events.length = limit;
    send(res, 200, { events, hasMore });
  }

  async function handleTail(req, res, projectId, runId) {
    const q = (req && req.query) || {};
    const limit = boundedInt(scalar(q, 'limit'), LIMITS.TAIL_DEFAULT, LIMITS.TAIL_MAX);

    if (!(await runUnderProject(runId, projectId))) {
      send(res, 404, { ok: false, error: 'RUN_NOT_FOUND' });
      return;
    }
    const events = await readTail({ runId, limit: limit + 1 });
    const hasMore = events.length > limit;
    if (hasMore) events.length = limit;
    send(res, 200, { events, hasMore });
  }

  async function handle(req, res, urlPath, method) {
    const m = EVENTS_PATH_RE.exec(String(urlPath || ''));
    if (!m) return false; // not this module's URL — dispatcher keeps trying

    // OPTIONS preflight: no session/auth (browser CORS preflight is anonymous).
    if (method === 'OPTIONS') { send(res, 204, undefined); return true; }
    if (method !== 'GET') return false; // never answers non-GET (no 405 here)

    let projectId;
    let runId;
    try {
      projectId = decodeURIComponent(m[1]);
      runId = decodeURIComponent(m[2]);
    } catch (_) {
      send(res, 400, { ok: false, error: '路径参数非法' });
      return true;
    }

    try {
      // Hook 1 — identity (401 when a sessionUser hook is set and no session).
      const ident = await resolveUser(req);
      if (ident.denied) { send(res, 401, { ok: false, error: '未登录' }); return true; }
      // Hook 2 — project scope (authProject; absent → 缺省放行).
      const gate = await gateProject({ projectId, runId, user: ident.user, req });
      if (!gate.allowed) { send(res, gate.status, { ok: false, error: gate.error }); return true; }

      if (m[3] === 'latest') await handleTail(req, res, projectId, runId);
      else await handleEventsPage(req, res, projectId, runId);
      return true;
    } catch (e) {
      console.error('[run-events] read error:', e && e.stack);
      if (res && res.headersSent) {
        try { res.end(); } catch (_) {}
        return true;
      }
      send(res, 500, { ok: false, error: '服务内部错误' });
      return true;
    }
  }

  return { handle, LIMITS };
}

module.exports = { createRunEventsApi, LIMITS, rowToApiEvent };
