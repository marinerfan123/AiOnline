'use strict';
/**
 * W1-14 — Unified structure API (/api/v2/projects/:id/structure).
 *
 *  - GET    /api/v2/projects/:projectId/structure                          ordered flat tree (parent_id NULLS FIRST, order_index)
 *  - POST   /api/v2/projects/:projectId/structure                          create a node (mode type-set + parent-child adjacency)
 *  - PUT    /api/v2/projects/:projectId/structure/:nodeId                  update label/meta/order_index/shotId (whole-tree validateTree)
 *  - POST   /api/v2/projects/:projectId/structure/:nodeId/move            reorder (parent + order_index); shot leaves cannot move/be parents
 *  - DELETE /api/v2/projects/:projectId/structure/:nodeId                  delete (referential guard: HAS_CHILDREN / shot project-lock)
 *
 * Reuses structureNode.cjs (validateTree, typeSetForMode) and projectTypeModes.cjs
 * (resolveProjectMode) so hierarchy rules + mode type-sets live in one place.
 * Workspace-scoped: every handler requireProject() → membership check → 403 for non-members.
 */
const crypto = require('crypto');
const { validateTree, typeSetForMode } = require('./structureNode.cjs');
const { resolveProjectMode } = require('./projectTypeModes.cjs');

const STRUCTURE_RE = /^\/api\/v2\/projects\/([^/]+)\/structure(?:\/([^/]+)(?:\/(move))?)?$/;

function toIso(v) { return v ? new Date(v).toISOString() : null; }
function parseMeta(m) {
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m); } catch { return {}; }
}
function sendErr(sendJSON, res, status, error, extra = {}) {
  return sendJSON(res, status, { ok: false, error, ...extra });
}
function cleanText(s, maxLen) {
  if (!s) return '';
  return String(s).slice(0, maxLen || 500).replace(/\s+/g, ' ').trim();
}
function nodeShape(r) {
  return { id: r.id, parent_id: r.parent_id, type: r.type, order_index: Number(r.order_index), shot_id: r.shot_id || null };
}
/** Max order_index among siblings of `parentId` (null = roots). -1 when no siblings. */
function maxSiblingIndex(rows, parentId) {
  let mx = -1;
  for (const n of rows) if ((n.parent_id || null) === (parentId || null)) mx = Math.max(mx, Number(n.order_index) || 0);
  return mx;
}

const FORMAT_NODE = (r) => ({
  id: r.id,
  projectId: r.project_id,
  parentId: r.parent_id || null,
  type: r.type,
  orderIndex: Number(r.order_index),
  shotId: r.shot_id || null,
  label: r.label || null,
  meta: parseMeta(r.meta),
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

function createStudioStructureApi(deps) {
  const { pg, sessionUser, sendJSON, parseBody } = deps;

  function requireUser(req, res) {
    const user = sessionUser(req);
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    return user;
  }
  function isAdmin(user) { return user && (user.role === 'admin' || user.role === 'system'); }
  async function getMembership(client, userId, workspaceId) {
    const r = await client.query('SELECT workspace_id, user_id, role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
    return r.rows[0] || null;
  }
  async function requireProject(client, res, user, projectId) {
    const r = await client.query('SELECT p.*, w.owner_id AS workspace_owner_id FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1', [projectId]);
    if (!r.rows.length) { sendErr(sendJSON, res, 404, '项目不存在'); return null; }
    const project = r.rows[0];
    const membership = isAdmin(user) ? { role: 'owner' } : await getMembership(client, user.id, project.workspace_id);
    if (!membership) { sendErr(sendJSON, res, 403, '无项目权限'); return null; }
    const owner = membership.role === 'owner' || isAdmin(user);
    return { project, membership, permissions: { role: membership.role, canRead: true, canUpdate: owner && project.status !== 'archived' } };
  }
  async function loadNodes(client, projectId) {
    const r = await client.query('SELECT * FROM project_structure_nodes WHERE project_id=$1', [projectId]);
    return r.rows;
  }
  async function getNode(client, projectId, nodeId) {
    const r = await client.query('SELECT * FROM project_structure_nodes WHERE id=$1 AND project_id=$2', [nodeId, projectId]);
    return r.rows[0] || null;
  }
  /** Verify a shots row converges on a real shot in this project. */
  async function ensureShotExists(client, projectId, shotId) {
    if (shotId == null || shotId === '') return true; // non-shot nodes / optional
    const r = await client.query('SELECT s.id FROM shots s JOIN episodes e ON e.id=s.episode_id WHERE s.id=$1 AND e.project_id=$2', [shotId, projectId]);
    return r.rows.length > 0;
  }

  async function handleList(req, res, user, projectId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      const r = await client.query('SELECT * FROM project_structure_nodes WHERE project_id=$1 ORDER BY parent_id NULLS FIRST, order_index ASC, created_at ASC', [projectId]);
      return sendJSON(res, 200, { ok: true, nodes: r.rows.map(FORMAT_NODE) });
    } finally { client.release(); }
  }

  async function handleCreate(req, res, user, projectId) {
    const body = (await parseBody(req)) || {};
    const node = (body && body.node) || body || {};
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');
      const mode = resolveProjectMode(access.project.project_type);

      const type = String(node.type || '').trim();
      if (!type) return sendErr(sendJSON, res, 400, 'TYPE_REQUIRED');
      const parentId = node.parentId != null && node.parentId !== '' ? String(node.parentId) : null;
      const shotId = type === 'shot' ? (node.shotId != null ? String(node.shotId) : null) : null;
      const label = cleanText(node.label, 300) || null;
      const meta = node.meta != null ? (typeof node.meta === 'string' ? node.meta : JSON.stringify(node.meta)) : '{}';
      const existing = await loadNodes(client, projectId);
      const orderIndex = node.orderIndex != null ? Number(node.orderIndex) : maxSiblingIndex(existing, parentId) + 1;
      const id = crypto.randomUUID();

      // Clear errors: parent must exist (in project), parent can't be a shot leaf.
      if (parentId) {
        const parent = await getNode(client, projectId, parentId);
        if (!parent) return sendErr(sendJSON, res, 404, 'PARENT_NOT_FOUND');
        if (parent.type === 'shot') return sendErr(sendJSON, res, 400, 'SHOT_CANNOT_BE_PARENT');
      }

      // Whole-tree validation: mode type-set + parent->child adjacency + order_index + shot convergence.
      const prospective = existing.map(nodeShape).concat([{ id, parent_id: parentId, type, order_index: orderIndex, shot_id: shotId }]);
      const v = validateTree(prospective, mode);
      if (!v.ok) return sendErr(sendJSON, res, 400, 'VALIDATION_FAILED', { errors: v.errors });

      if (type === 'shot' && shotId && !(await ensureShotExists(client, projectId, shotId))) {
        return sendErr(sendJSON, res, 404, 'SHOT_NOT_FOUND');
      }

      const ins = await client.query(
        `INSERT INTO project_structure_nodes (id, project_id, parent_id, type, order_index, shot_id, label, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
        [id, projectId, parentId, type, orderIndex, shotId, label, meta]
      );
      return sendJSON(res, 201, { ok: true, node: FORMAT_NODE(ins.rows[0]) });
    } finally { client.release(); }
  }

  async function handleUpdate(req, res, user, projectId, nodeId) {
    const body = (await parseBody(req)) || {};
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');
      const mode = resolveProjectMode(access.project.project_type);

      const node = await getNode(client, projectId, nodeId);
      if (!node) return sendErr(sendJSON, res, 404, 'NODE_NOT_FOUND');

      const patch = {};
      const updates = [];
      const params = [];
      let idx = 1;
      if (body.label !== undefined) {
        const label = cleanText(body.label, 300);
        updates.push(`label=$${idx++}`); params.push(label); patch.label = label;
      }
      if (body.meta !== undefined) {
        const meta = typeof body.meta === 'string' ? body.meta : JSON.stringify(body.meta);
        updates.push(`meta=$${idx++}`); params.push(meta); patch.meta = meta;
      }
      if (body.orderIndex !== undefined) {
        const oi = Number(body.orderIndex);
        updates.push(`order_index=$${idx++}`); params.push(oi); patch.order_index = oi;
      }
      if (body.shotId !== undefined) {
        const sid = body.shotId != null ? String(body.shotId) : null;
        updates.push(`shot_id=$${idx++}`); params.push(sid); patch.shot_id = sid;
      }
      if (!updates.length) return sendJSON(res, 200, { ok: true, node: FORMAT_NODE(node) });

      if (node.type === 'shot' && patch.shot_id && !(await ensureShotExists(client, projectId, patch.shot_id))) {
        return sendErr(sendJSON, res, 404, 'SHOT_NOT_FOUND');
      }

      // Whole-tree validation after applying the patch.
      const existing = await loadNodes(client, projectId);
      const applied = existing.map((r) => (r.id === nodeId ? { ...nodeShape(r), ...patch } : nodeShape(r)));
      const v = validateTree(applied, mode);
      if (!v.ok) return sendErr(sendJSON, res, 400, 'VALIDATION_FAILED', { errors: v.errors });

      updates.push('updated_at = NOW()');
      const ur = await client.query(
        `UPDATE project_structure_nodes SET ${updates.join(', ')} WHERE id=$${idx} AND project_id=$${idx + 1} RETURNING *`,
        [...params, nodeId, projectId]
      );
      return sendJSON(res, 200, { ok: true, node: FORMAT_NODE(ur.rows[0]) });
    } finally { client.release(); }
  }

  async function handleMove(req, res, user, projectId, nodeId) {
    const body = (await parseBody(req)) || {};
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');
      const mode = resolveProjectMode(access.project.project_type);

      const node = await getNode(client, projectId, nodeId);
      if (!node) return sendErr(sendJSON, res, 404, 'NODE_NOT_FOUND');
      if (node.type === 'shot') return sendErr(sendJSON, res, 400, 'SHOT_CANNOT_MOVE');

      const newParentId = body.parentId === undefined
        ? node.parent_id
        : (body.parentId == null || body.parentId === '' ? null : String(body.parentId));

      if (newParentId) {
        const parent = await getNode(client, projectId, newParentId);
        if (!parent) return sendErr(sendJSON, res, 404, 'PARENT_NOT_FOUND');
        if (parent.type === 'shot') return sendErr(sendJSON, res, 400, 'SHOT_CANNOT_BE_PARENT');
      }

      const existing = await loadNodes(client, projectId);
      const orderIndex = body.orderIndex !== undefined ? Number(body.orderIndex) : maxSiblingIndex(existing, newParentId) + 1;

      const applied = existing.map((r) => (r.id === nodeId
        ? { ...nodeShape(r), parent_id: newParentId, order_index: orderIndex }
        : nodeShape(r)));
      const v = validateTree(applied, mode);
      if (!v.ok) return sendErr(sendJSON, res, 400, 'VALIDATION_FAILED', { errors: v.errors });

      const ur = await client.query(
        'UPDATE project_structure_nodes SET parent_id=$1, order_index=$2, updated_at=NOW() WHERE id=$3 AND project_id=$4 RETURNING *',
        [newParentId, orderIndex, nodeId, projectId]
      );
      return sendJSON(res, 200, { ok: true, node: FORMAT_NODE(ur.rows[0]) });
    } finally { client.release(); }
  }

  async function handleDelete(req, res, user, projectId, nodeId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');

      const node = await getNode(client, projectId, nodeId);
      if (!node) return sendErr(sendJSON, res, 404, 'NODE_NOT_FOUND');

      // Shot leaves are project-locked (they converge on a shots row; delete only via shots API).
      if (node.type === 'shot') return sendErr(sendJSON, res, 409, 'SHOT_LOCKED');

      // Referential guard: reject delete when a child references this node.
      const cr = await client.query('SELECT id FROM project_structure_nodes WHERE project_id=$1 AND parent_id=$2 LIMIT 1', [projectId, nodeId]);
      if (cr.rows.length) return sendErr(sendJSON, res, 409, 'HAS_CHILDREN');

      const dr = await client.query('DELETE FROM project_structure_nodes WHERE id=$1 AND project_id=$2 RETURNING *', [nodeId, projectId]);
      return sendJSON(res, 200, { ok: true, deleted: FORMAT_NODE(dr.rows[0]) });
    } finally { client.release(); }
  }

  async function handle(req, res, urlPath, method) {
    const m = urlPath.match(STRUCTURE_RE);
    if (!m) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const projectId = decodeURIComponent(m[1]);
    const nodeId = m[2] ? decodeURIComponent(m[2]) : null;
    const isMove = m[3] === 'move';
    try {
      if (!nodeId && method === 'GET') return await handleList(req, res, user, projectId), true;
      if (!nodeId && method === 'POST') return await handleCreate(req, res, user, projectId), true;
      if (nodeId && !isMove && method === 'PUT') return await handleUpdate(req, res, user, projectId, nodeId), true;
      if (nodeId && isMove && method === 'POST') return await handleMove(req, res, user, projectId, nodeId), true;
      if (nodeId && !isMove && method === 'DELETE') return await handleDelete(req, res, user, projectId, nodeId), true;
      return sendJSON(res, 404, { ok: false, error: 'Not Found' }), true;
    } catch (e) {
      console.error('[studio-structure] route error:', e && e.stack);
      return sendJSON(res, 500, { ok: false, error: '服务内部错误' }), true;
    }
  }

  return { handle, FORMAT_NODE };
}

module.exports = { createStudioStructureApi };
