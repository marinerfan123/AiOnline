'use strict';
/**
 * M05-D1 — Studio Run API (/api/v2/projects/:id/studio/runs).
 *
 *  - POST   /api/v2/projects/:projectId/studio/runs               create Run (ALL/SELECTED/FROM_NODE)
 *  - GET    /api/v2/projects/:projectId/studio/runs               list runs (paginated)
 *  - GET    /api/v2/projects/:projectId/studio/runs/:runId        run detail (nodes + counts)
 *  - POST   /api/v2/projects/:projectId/studio/runs/:runId/cancel request durable cancellation (D1 foundation)
 *
 * Authorization reuses M01 project permissions (workspace membership).
 * Run id is never a scope bypass: every read re-joins project+workspace.
 */
const { LIMITS: GRAPH_LIMITS } = require('./studioRunGraph.cjs');

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
      if (runId && !seg2 && method === 'GET') return await handleGet(req, res, user, projectId, runId), true;
      if (runId && seg2 === 'cancel' && method === 'POST') return await handleCancel(req, res, user, projectId, runId), true;
      return sendJSON(res, 404, { ok: false, error: 'Not Found' }), true;
    } catch (e) {
      console.error('[studio-runs] route error:', e && e.stack);
      return sendJSON(res, 500, { ok: false, error: '服务内部错误' }), true;
    }
  }
  return { handle, FORMAT_RUN, formatRunNode };
}

module.exports = { createStudioRunApi, FORMAT_RUN, formatRunNode };
