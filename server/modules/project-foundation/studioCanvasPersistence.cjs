'use strict';
const crypto = require('crypto');
// G22 — canvas.patch 命令日志: 挂载 collaboration 的 commandLogStore 地基(幂等 append)。
// 反向依赖安全: commandLogStore.cjs 零 require(纯地基叶), 无环。server.js 未改动时
// 本模块用同一个注入 pg 自建 store; 合成根日后可经 deps.commandLogStore 注入共享实例。
const { createCommandLogStore } = require('../collaboration/commandLogStore.cjs');

const PREFIX_RE = /^\/api\/v2\/projects\/([^/]+)\/studio\/canvas(?:\/([^/]+)(?:\/([^/]+))?)?$/;
const CANVAS_SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({
  maxNodesPerPatch: Number(process.env.STUDIO_CANVAS_MAX_NODES_PER_PATCH || 200),
  maxEdgesPerPatch: Number(process.env.STUDIO_CANVAS_MAX_EDGES_PER_PATCH || 400),
  maxDeleteIdsPerPatch: Number(process.env.STUDIO_CANVAS_MAX_DELETES_PER_PATCH || 500),
  maxNameLength: 120,
  maxDescriptionLength: 1000,
  maxSnapshotBytes: Number(process.env.STUDIO_CANVAS_MAX_SNAPSHOT_BYTES || 8 * 1024 * 1024),
});
const FORBIDDEN_DATA_KEYS = new Set(['temporaryPreviewUrl', 'tempPreviewUrl', 'signedUrl', 'signedURL', 'apiKey', 'api_key', 'credential', 'credentials', 'jwt', 'token', 'cookie', 'localPath']);

function isAdmin(user) { return user && (user.role === 'admin' || user.role === 'system'); }
function sendErr(sendJSON, res, status, error, extra = {}) { return sendJSON(res, status, { ok: false, error, ...extra }); }
function toIso(v) { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function cleanText(v, max) { if (v === undefined || v === null) return null; return String(v).trim().slice(0, max); }
function safeJson(v, fallback) { return v && typeof v === 'object' && !Array.isArray(v) ? v : fallback; }
function stripForbiddenData(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_DATA_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
function durableNodeData(raw) {
  const d = stripForbiddenData(raw || {});
  const nodeKind = String(d.nodeKind || d.nodeType || '').trim();
  const schemaVersion = Number(d.schemaVersion || d.nodeSchemaVersion || 1) || 1;
  const out = {
    nodeKind,
    nodeType: String(d.nodeType || nodeKind),
    schemaVersion,
    title: String(d.title || nodeKind || 'Node').slice(0, 200),
    status: String(d.status || 'IDLE'),
    parameters: safeJson(d.parameters, {}),
  };
  if (typeof d.assetId === 'string' || d.assetId === null) out.assetId = d.assetId;
  if (typeof d.prompt === 'string') out.prompt = d.prompt;
  if (d.validation && typeof d.validation === 'object') out.validation = d.validation;
  if (typeof d.frameLabel === 'string') out.frameLabel = d.frameLabel;
  // W2-06: authoritative structure/Shot binding survives durability.
  if (typeof d.shotId === 'string' || d.shotId === null) out.shotId = d.shotId;
  if (typeof d.structureNodeId === 'string' || d.structureNodeId === null) out.structureNodeId = d.structureNodeId;
  return stripForbiddenData(out);
}
function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('INVALID_NODE');
  const nodeId = String(raw.nodeId || raw.id || '').trim();
  const data = durableNodeData(raw.data || raw);
  const nodeType = String(raw.nodeType || data.nodeKind || '').trim();
  const sv = Number(raw.nodeSchemaVersion || data.schemaVersion || raw.schemaVersion || 1);
  const pos = safeJson(raw.position, {});
  if (!nodeId || !nodeType || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) throw new Error('INVALID_NODE');
  return {
    nodeId, nodeType, nodeSchemaVersion: sv >= 1 ? Math.floor(sv) : 1,
    positionX: Number(pos.x), positionY: Number(pos.y),
    width: raw.size?.width ?? raw.width ?? null, height: raw.size?.height ?? raw.height ?? null,
    zIndex: raw.zIndex ?? raw.z_index ?? null, data,
  };
}
function normalizeEdge(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('INVALID_EDGE');
  const edgeId = String(raw.edgeId || raw.id || '').trim();
  const sourceNodeId = String(raw.sourceNodeId || raw.source || '').trim();
  const targetNodeId = String(raw.targetNodeId || raw.target || '').trim();
  if (!edgeId || !sourceNodeId || !targetNodeId) throw new Error('INVALID_EDGE');
  return { edgeId, sourceNodeId, targetNodeId, sourceHandle: raw.sourceHandle || null, targetHandle: raw.targetHandle || null, edgeType: raw.edgeType || raw.type || null, data: stripForbiddenData(raw.data || {}) };
}
function formatCanvas(row) { return { id: row.id, projectId: row.project_id, workspaceId: row.workspace_id, name: row.name, revision: row.revision, schemaVersion: row.schema_version, archivedAt: toIso(row.archived_at), createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at), restoredFromVersionId: row.restored_from_version_id || null }; }
function formatNode(r) { return { nodeId: r.node_id, nodeType: r.node_type, nodeSchemaVersion: r.node_schema_version, position: { x: Number(r.position_x), y: Number(r.position_y) }, size: { width: r.width == null ? null : Number(r.width), height: r.height == null ? null : Number(r.height) }, zIndex: r.z_index == null ? null : r.z_index, data: r.data_json || {} }; }
function formatEdge(r) { return { edgeId: r.edge_id, sourceNodeId: r.source_node_id, sourceHandle: r.source_handle, targetNodeId: r.target_node_id, targetHandle: r.target_handle, edgeType: r.edge_type, data: r.data_json || {} }; }
async function loadGraph(client, canvasId) {
  const [nr, er] = await Promise.all([
    client.query('SELECT * FROM studio_canvas_nodes WHERE canvas_id=$1 ORDER BY created_at ASC, node_id ASC', [canvasId]),
    client.query('SELECT * FROM studio_canvas_edges WHERE canvas_id=$1 ORDER BY created_at ASC, edge_id ASC', [canvasId]),
  ]);
  return { nodes: nr.rows.map(formatNode), edges: er.rows.map(formatEdge) };
}
function response(canvas, graph, viewport, extra = {}) { return { canvas: formatCanvas(canvas), nodes: graph.nodes, edges: graph.edges, viewport: viewport || null, permissions: extra.permissions, ...extra.extra }; }
// Commercial hardening (A): set-based bulk restore — one INSERT...SELECT per table,
// NOT one round trip per node/edge. Snapshot JSONB is normalized then hydrated in one shot.
function bulkInsertNodes(client, canvasId, rawNodes) {
  if (!rawNodes || !rawNodes.length) return Promise.resolve({ rowCount: 0 });
  const rows = rawNodes.map((raw) => {
    const n = normalizeNode(raw);
    return { node_id: n.nodeId, node_type: n.nodeType, node_schema_version: n.nodeSchemaVersion, position_x: n.positionX, position_y: n.positionY, width: n.width, height: n.height, z_index: n.zIndex, data_json: n.data };
  });
  return client.query(`
    INSERT INTO studio_canvas_nodes (canvas_id,node_id,node_type,node_schema_version,position_x,position_y,width,height,z_index,data_json,created_at,updated_at)
    SELECT $1, n.node_id, n.node_type, n.node_schema_version, n.position_x, n.position_y, n.width, n.height, n.z_index, n.data_json, NOW(), NOW()
    FROM jsonb_to_recordset($2::jsonb) AS n (
      node_id text, node_type text, node_schema_version int,
      position_x double precision, position_y double precision,
      width double precision, height double precision, z_index int, data_json jsonb
    )`, [canvasId, JSON.stringify(rows)]);
}
function bulkInsertEdges(client, canvasId, rawEdges) {
  if (!rawEdges || !rawEdges.length) return Promise.resolve({ rowCount: 0 });
  const rows = rawEdges.map((raw) => {
    const e = normalizeEdge(raw);
    return { edge_id: e.edgeId, source_node_id: e.sourceNodeId, source_handle: e.sourceHandle, target_node_id: e.targetNodeId, target_handle: e.targetHandle, edge_type: e.edgeType, data_json: e.data };
  });
  return client.query(`
    INSERT INTO studio_canvas_edges (canvas_id,edge_id,source_node_id,source_handle,target_node_id,target_handle,edge_type,data_json,created_at,updated_at)
    SELECT $1, e.edge_id, e.source_node_id, e.source_handle, e.target_node_id, e.target_handle, e.edge_type, e.data_json, NOW(), NOW()
    FROM jsonb_to_recordset($2::jsonb) AS e (
      edge_id text, source_node_id text, source_handle text,
      target_node_id text, target_handle text, edge_type text, data_json jsonb
    )`, [canvasId, JSON.stringify(rows)]);
}

function createStudioCanvasPersistence(deps) {
  const { pg, sessionUser, sendJSON, parseBody, logEvent } = deps;
  function requireUser(req, res) { const user = sessionUser(req); if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; } return user; }
  async function getMembership(client, userId, workspaceId) { const r = await client.query('SELECT workspace_id,user_id,role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]); return r.rows[0] || null; }
  async function requireProject(client, res, user, projectId) {
    const r = await client.query('SELECT p.*, w.owner_id AS workspace_owner_id FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1', [projectId]);
    if (!r.rows.length) return sendErr(sendJSON, res, 404, '项目不存在'), null;
    const project = r.rows[0];
    const membership = isAdmin(user) ? { workspace_id: project.workspace_id, user_id: user.id, role: 'owner' } : await getMembership(client, user.id, project.workspace_id);
    if (!membership) return sendErr(sendJSON, res, 403, '无项目权限'), null;
    const owner = membership.role === 'owner' || isAdmin(user);
    // canRestore mirrors M01 project policy (archived projects restore via /projects/:id/restore);
    // Studio version-restore authorization is enforced via canUpdate in handleRestore.
    return { project, membership, permissions: { role: membership.role, canRead: true, canUpdate: owner && project.status !== 'archived', canArchive: owner && project.status !== 'archived', canRestore: owner && project.status === 'archived', canDelete: false } };
  }
  async function getCanvas(client, projectId) { const r = await client.query('SELECT * FROM studio_canvases WHERE project_id=$1 AND is_primary=TRUE AND archived_at IS NULL LIMIT 1', [projectId]); return r.rows[0] || null; }
  async function createCanvasTx(client, project, user, name) {
    const id = `canvas-${crypto.randomUUID()}`;
    const r = await client.query(`INSERT INTO studio_canvases (id,project_id,workspace_id,name,revision,schema_version,created_by,updated_by,created_at,updated_at)
      VALUES ($1,$2,$3,$4,1,$5,$6,$6,NOW(),NOW()) ON CONFLICT (project_id) WHERE is_primary=TRUE AND archived_at IS NULL DO UPDATE SET updated_at=studio_canvases.updated_at RETURNING *`, [id, project.id, project.workspace_id, name || 'Primary Canvas', CANVAS_SCHEMA_VERSION, user.id]);
    return r.rows[0];
  }
  async function ensureCanvas(client, project, user) { return await getCanvas(client, project.id) || await createCanvasTx(client, project, user, 'Primary Canvas'); }
  async function emit(eventType, payload) { if (!logEvent) return; try { await logEvent(pg, { aggregate: 'studio_canvas', eventType, payload }); } catch (_) {} }

  // G22 — canvas.patch 命令日志。优先用合成根注入的 commandLogStore(需含幂等 appendCommand);
  // 未注入则用同一 pg 自建 store(server.js 零改动即生效, 挂载地基叶)。recordCanvasPatch
  // 全程 warn-only —— 命令日志任何失败(抛错/拒绝)绝不让已提交的 PATCH 主链破。
  const commandLog =
    deps.commandLogStore && typeof deps.commandLogStore.appendCommand === 'function'
      ? deps.commandLogStore
      : (() => {
          try {
            return pg && typeof pg.query === 'function' ? createCommandLogStore({ pg }) : null;
          } catch (e) {
            console.warn('[studio-canvas] commandLogStore init skipped:', e && e.message);
            return null;
          }
        })();
  async function recordCanvasPatch({ canvasId, commandId, actorId, baseRevision, ops }) {
    if (!commandLog) return;
    try {
      const r = await commandLog.appendCommand({
        canvasId, commandId, type: 'canvas.patch', actorId, baseRevision,
        payload: { baseRevision, ops },
      });
      if (r && r.ok === false) console.warn('[studio-canvas] appendCommand rejected:', JSON.stringify(r.errors || r));
    } catch (e) {
      console.warn('[studio-canvas] appendCommand failed after commit (PATCH unaffected):', e && e.message);
    }
  }

  async function handleGet(req, res, user, projectId) {
    const access = await requireProject(pg, res, user, projectId); if (!access) return;
    const canvas = await getCanvas(pg, projectId);
    if (!canvas) return sendJSON(res, 200, { canvas: null, nodes: [], edges: [], viewport: null, permissions: access.permissions });
    const graph = await loadGraph(pg, canvas.id);
    return sendJSON(res, 200, response(canvas, graph, canvas.viewport_json, { permissions: access.permissions }));
  }
  async function handleCreate(req, res, user, projectId) {
    const body = (await parseBody(req)) || {}; const client = await pg.connect();
    try { await client.query('BEGIN'); const access = await requireProject(client, res, user, projectId); if (!access) { await client.query('ROLLBACK'); return; } if (!access.permissions.canUpdate) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 403, '无权编辑该项目'); }
      const canvas = await createCanvasTx(client, access.project, user, cleanText(body.name, LIMITS.maxNameLength) || 'Primary Canvas'); const graph = await loadGraph(client, canvas.id); await client.query('COMMIT');
      await emit('canvas.created', { canvas_id: canvas.id, project_id: projectId, workspace_id: canvas.workspace_id, revision: canvas.revision, actor_id: user.id, timestamp: new Date().toISOString() });
      return sendJSON(res, canvas.created_by === user.id ? 201 : 200, response(canvas, graph, canvas.viewport_json, { permissions: access.permissions }));
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} if (e.message === 'INVALID_NODE') return sendErr(sendJSON, res, 400, 'INVALID_NODE'); throw e; } finally { client.release(); }
  }
  async function handlePatch(req, res, user, projectId) {
    const body = (await parseBody(req)) || {}; const cmid = String(body.clientMutationId || '').trim(); const base = Number(body.baseRevision);
    if (!cmid || !Number.isInteger(base)) return sendErr(sendJSON, res, 400, 'INVALID_PATCH');
    const upsertNodes = Array.isArray(body.upsertNodes) ? body.upsertNodes : [];
    const deleteNodeIds = Array.isArray(body.deleteNodeIds) ? body.deleteNodeIds.map(String) : [];
    const upsertEdges = Array.isArray(body.upsertEdges) ? body.upsertEdges : [];
    const deleteEdgeIds = Array.isArray(body.deleteEdgeIds) ? body.deleteEdgeIds.map(String) : [];
    if (upsertNodes.length > LIMITS.maxNodesPerPatch || upsertEdges.length > LIMITS.maxEdgesPerPatch || deleteNodeIds.length + deleteEdgeIds.length > LIMITS.maxDeleteIdsPerPatch) return sendErr(sendJSON, res, 413, 'PATCH_TOO_LARGE');
    const client = await pg.connect();
    try { await client.query('BEGIN'); const access = await requireProject(client, res, user, projectId); if (!access) { await client.query('ROLLBACK'); return; } if (!access.permissions.canUpdate) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 403, '无权编辑该项目'); }
      const canvas = await ensureCanvas(client, access.project, user);
      const prior = await client.query('SELECT response_json FROM studio_canvas_mutations WHERE canvas_id=$1 AND client_mutation_id=$2', [canvas.id, cmid]);
      if (prior.rows.length) { await client.query('COMMIT'); return sendJSON(res, 200, { ...prior.rows[0].response_json, idempotent: true }); }
      const cas = await client.query('UPDATE studio_canvases SET revision=revision+1, viewport_json=COALESCE($3, viewport_json), updated_by=$4, updated_at=NOW() WHERE id=$1 AND revision=$2 RETURNING *', [canvas.id, base, body.viewport === undefined ? null : JSON.stringify(safeJson(body.viewport, {})), user.id]);
      if (!cas.rows.length) { const cur = await client.query('SELECT revision FROM studio_canvases WHERE id=$1', [canvas.id]); await client.query('ROLLBACK'); return sendErr(sendJSON, res, 409, 'CONFLICT', { serverRevision: cur.rows[0]?.revision || canvas.revision, canvasId: canvas.id }); }
      if (deleteEdgeIds.length) await client.query('DELETE FROM studio_canvas_edges WHERE canvas_id=$1 AND edge_id = ANY($2::text[])', [canvas.id, deleteEdgeIds]);
      if (deleteNodeIds.length) await client.query('DELETE FROM studio_canvas_nodes WHERE canvas_id=$1 AND node_id = ANY($2::text[])', [canvas.id, deleteNodeIds]);
      for (const raw of upsertNodes) { const n = normalizeNode(raw); await client.query(`INSERT INTO studio_canvas_nodes (canvas_id,node_id,node_type,node_schema_version,position_x,position_y,width,height,z_index,data_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()) ON CONFLICT (canvas_id,node_id) DO UPDATE SET node_type=EXCLUDED.node_type,node_schema_version=EXCLUDED.node_schema_version,position_x=EXCLUDED.position_x,position_y=EXCLUDED.position_y,width=EXCLUDED.width,height=EXCLUDED.height,z_index=EXCLUDED.z_index,data_json=EXCLUDED.data_json,updated_at=NOW()`, [canvas.id,n.nodeId,n.nodeType,n.nodeSchemaVersion,n.positionX,n.positionY,n.width,n.height,n.zIndex,JSON.stringify(n.data)]); }
      for (const raw of upsertEdges) { const e = normalizeEdge(raw); await client.query(`INSERT INTO studio_canvas_edges (canvas_id,edge_id,source_node_id,source_handle,target_node_id,target_handle,edge_type,data_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT (canvas_id,edge_id) DO UPDATE SET source_node_id=EXCLUDED.source_node_id,source_handle=EXCLUDED.source_handle,target_node_id=EXCLUDED.target_node_id,target_handle=EXCLUDED.target_handle,edge_type=EXCLUDED.edge_type,data_json=EXCLUDED.data_json,updated_at=NOW()`, [canvas.id,e.edgeId,e.sourceNodeId,e.sourceHandle,e.targetNodeId,e.targetHandle,e.edgeType,JSON.stringify(e.data)]); }
      const graph = await loadGraph(client, canvas.id); const fresh = (await client.query('SELECT * FROM studio_canvases WHERE id=$1', [canvas.id])).rows[0]; const resp = response(fresh, graph, fresh.viewport_json, { permissions: access.permissions, extra: { applied: true, clientMutationId: cmid } });
      await client.query('INSERT INTO studio_canvas_mutations (canvas_id,client_mutation_id,base_revision,resulting_revision,response_json,created_by) VALUES ($1,$2,$3,$4,$5,$6)', [canvas.id, cmid, base, fresh.revision, JSON.stringify(resp), user.id]);
      await client.query('COMMIT');
      // G22 — mutation 已提交(CAS 通过)后写 canvas.patch 命令日志。commandId=clientMutationId,
      // 幂等由 (canvas_id,command_id) 保证 → 同 mutationId 重放安全。失败路径仅在成功分支后
      // warn-only(见 recordCanvasPatch), 不破主链。409/校验失败/回滚路径永不走到此处。
      await recordCanvasPatch({ canvasId: canvas.id, commandId: cmid, actorId: user.id, baseRevision: base, ops: { nodeUpserts: upsertNodes.length, nodeDeletes: deleteNodeIds.length, edgeUpserts: upsertEdges.length, edgeDeletes: deleteEdgeIds.length } });
      await emit('canvas.updated', { canvas_id: canvas.id, project_id: projectId, workspace_id: fresh.workspace_id, revision: fresh.revision, actor_id: user.id, timestamp: new Date().toISOString() }); return sendJSON(res, 200, resp);
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} if (['INVALID_NODE','INVALID_EDGE'].includes(e.message)) return sendErr(sendJSON, res, 400, e.message); if (e.code === '23503') return sendErr(sendJSON, res, 400, 'INTEGRITY_ERROR'); throw e; } finally { client.release(); }
  }
  async function handleVersionList(req, res, user, projectId) { const access = await requireProject(pg, res, user, projectId); if (!access) return; const canvas = await getCanvas(pg, projectId); if (!canvas) return sendJSON(res, 200, { versions: [], pagination: { limit: 20, offset: 0, total: 0, hasMore: false } }); const q = req.query || {}; const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100); const offset = Math.max(Number(q.offset) || 0, 0); const cr = await pg.query('SELECT COUNT(*)::int AS total FROM studio_canvas_versions WHERE canvas_id=$1', [canvas.id]); const r = await pg.query('SELECT id,canvas_id,revision,version_number,name,description,snapshot_json,created_by,restore_source_version_id,created_at FROM studio_canvas_versions WHERE canvas_id=$1 ORDER BY version_number DESC LIMIT $2 OFFSET $3', [canvas.id, limit, offset]); const versions = r.rows.map(v => ({ id:v.id, canvasId:v.canvas_id, revision:v.revision, versionNumber:v.version_number, name:v.name, description:v.description, createdBy:v.created_by, createdAt:toIso(v.created_at), restoredFromVersionId:v.restore_source_version_id, nodeCount:(v.snapshot_json?.nodes||[]).length, edgeCount:(v.snapshot_json?.edges||[]).length })); return sendJSON(res, 200, { versions, pagination: { limit, offset, total: cr.rows[0].total, hasMore: offset + versions.length < cr.rows[0].total } }); }
  async function handleVersionCreate(req, res, user, projectId) { const body = (await parseBody(req)) || {}; const client = await pg.connect(); try { await client.query('BEGIN'); const access = await requireProject(client, res, user, projectId); if (!access) { await client.query('ROLLBACK'); return; } if (!access.permissions.canUpdate) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 403, '无权编辑该项目'); } const canvas = await ensureCanvas(client, access.project, user); // Commercial hardening (B): serialize concurrent version creates per canvas.
      // The MAX(version_number)+1 read below is only race-free while we hold this row lock.
      await client.query('SELECT id FROM studio_canvases WHERE id=$1 FOR UPDATE', [canvas.id]); const graph = await loadGraph(client, canvas.id); const snap = { schemaVersion: canvas.schema_version, revision: canvas.revision, nodes: graph.nodes, edges: graph.edges, viewport: canvas.viewport_json || null }; if (Buffer.byteLength(JSON.stringify(snap)) > LIMITS.maxSnapshotBytes) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 413, 'SNAPSHOT_TOO_LARGE'); } const nr = await client.query('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM studio_canvas_versions WHERE canvas_id=$1', [canvas.id]); const vr = await client.query('INSERT INTO studio_canvas_versions (id,canvas_id,revision,version_number,name,description,snapshot_json,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *', [`scv-${crypto.randomUUID()}`,canvas.id,canvas.revision,nr.rows[0].n,cleanText(body.name,LIMITS.maxNameLength),cleanText(body.description,LIMITS.maxDescriptionLength),JSON.stringify(snap),user.id]); await client.query('COMMIT'); const v=vr.rows[0]; return sendJSON(res,201,{version:{id:v.id,canvasId:v.canvas_id,revision:v.revision,versionNumber:v.version_number,name:v.name,description:v.description,createdBy:v.created_by,createdAt:toIso(v.created_at),nodeCount:graph.nodes.length,edgeCount:graph.edges.length}}); } catch(e){ try{await client.query('ROLLBACK');}catch(_){} throw e;} finally{client.release();} }
  async function handleRestore(req, res, user, projectId, versionId) { const body = (await parseBody(req)) || {}; const base = Number(body.baseRevision); if (!Number.isInteger(base)) return sendErr(sendJSON,res,400,'INVALID_RESTORE'); const client = await pg.connect(); try { await client.query('BEGIN'); const access = await requireProject(client,res,user,projectId); if(!access){await client.query('ROLLBACK'); return;} if(!access.permissions.canUpdate){await client.query('ROLLBACK'); return sendErr(sendJSON,res,403,'无权恢复版本');} const canvas = await ensureCanvas(client, access.project, user); const vr = await client.query('SELECT * FROM studio_canvas_versions WHERE id=$1 AND canvas_id=$2', [versionId, canvas.id]); if(!vr.rows.length){ await client.query('ROLLBACK'); return sendErr(sendJSON,res,404,'版本不存在'); } const cas = await client.query('UPDATE studio_canvases SET revision=revision+1, viewport_json=$3, restored_from_version_id=$4, updated_by=$5, updated_at=NOW() WHERE id=$1 AND revision=$2 RETURNING *', [canvas.id, base, JSON.stringify(vr.rows[0].snapshot_json.viewport || null), versionId, user.id]); if(!cas.rows.length){ const cur=await client.query('SELECT revision FROM studio_canvases WHERE id=$1',[canvas.id]); await client.query('ROLLBACK'); return sendErr(sendJSON,res,409,'CONFLICT',{serverRevision:cur.rows[0]?.revision||canvas.revision,canvasId:canvas.id}); } await client.query('DELETE FROM studio_canvas_edges WHERE canvas_id=$1',[canvas.id]); await client.query('DELETE FROM studio_canvas_nodes WHERE canvas_id=$1',[canvas.id]); await bulkInsertNodes(client,canvas.id,vr.rows[0].snapshot_json.nodes || []); await bulkInsertEdges(client,canvas.id,vr.rows[0].snapshot_json.edges || []); const fresh=cas.rows[0]; const graph=await loadGraph(client,canvas.id); await client.query('COMMIT'); return sendJSON(res,200,response(fresh,graph,fresh.viewport_json,{permissions:access.permissions,extra:{restoredFromVersionId:versionId}})); } catch(e){ try{await client.query('ROLLBACK');}catch(_){} throw e;} finally{client.release();} }

  async function handle(req, res, urlPath, method) {
    const restore = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/studio\/canvas\/versions\/([^/]+)\/restore$/);
    const m = urlPath.match(PREFIX_RE);
    if (!m && !restore) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }
    const user = requireUser(req, res); if (!user) return true;
    const projectId = decodeURIComponent((restore ? restore[1] : m[1]));
    const seg1 = m && m[2]; const seg2 = m && m[3];
    try {
      if (restore && method === 'POST') return await handleRestore(req,res,user,projectId,decodeURIComponent(restore[2])), true;
      if (!seg1 && method === 'GET') return await handleGet(req,res,user,projectId), true;
      if (!seg1 && method === 'POST') return await handleCreate(req,res,user,projectId), true;
      if (!seg1 && method === 'PATCH') return await handlePatch(req,res,user,projectId), true;
      if (seg1 === 'versions' && !seg2 && method === 'GET') return await handleVersionList(req,res,user,projectId), true;
      if (seg1 === 'versions' && !seg2 && method === 'POST') return await handleVersionCreate(req,res,user,projectId), true;
      return sendJSON(res, 404, { ok:false, error:'Not Found' }), true;
    } catch (e) { console.error('[studio-canvas] route error:', e && e.stack); return sendJSON(res, 500, { ok:false, error:'服务内部错误' }), true; }
  }
  return { handle, LIMITS };
}
function validateAuthoritativeBindings(nodes, { shotIds = [], structureNodeIds = [] } = {}) {
  const errors = [];
  for (const n of nodes || []) {
    const data = n.data || {};
    const sid = data.shotId;
    const snid = data.structureNodeId;
    if (sid != null && !shotIds.includes(sid)) errors.push(`node.${n.nodeId}: shotId ${sid} is not an authoritative project shot`);
    if (snid != null && !structureNodeIds.includes(snid)) errors.push(`node.${n.nodeId}: structureNodeId ${snid} is not an authoritative project structure node`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { createStudioCanvasPersistence, normalizeNode, normalizeEdge, durableNodeData, bulkInsertNodes, bulkInsertEdges, validateAuthoritativeBindings, LIMITS };
