'use strict';
/**
 * M05-E — Studio Episode API (/api/v2/projects/:id/episodes).
 *
 *  - GET    /api/v2/projects/:projectId/episodes              list (paginated)
 *  - POST   /api/v2/projects/:projectId/episodes              create from canvas
 *  - GET    /api/v2/projects/:projectId/episodes/:epId        detail (with shots)
 *  - PATCH  /api/v2/projects/:projectId/episodes/:epId        update title/status
 *  - POST   /api/v2/projects/:projectId/episodes/:epId/publish  draft -> published
 */
const EPISODES_RE = /^\/api\/v2\/projects\/([^/]+)\/episodes(?:\/([^/]+)(?:\/([^/]+))?)?$/;

const FORMAT_EPISODE = (row) => ({
  id: row.id,
  projectId: row.project_id,
  workspaceId: row.workspace_id,
  canvasId: row.canvas_id,
  seq: row.seq,
  title: row.title || '',
  status: row.status,
  meta: row.meta || {},
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  publishedAt: toIso(row.published_at),
  archivedAt: toIso(row.archived_at),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const FORMAT_SHOT = (r) => ({
  id: r.id,
  episodeId: r.episode_id,
  canvasNodeId: r.canvas_node_id,
  seq: r.seq,
  assetId: r.asset_id || null,
  durationSeconds: r.duration_seconds || null,
  note: r.note || null,
  createdAt: toIso(r.created_at),
});

function toIso(v) { return v ? new Date(v).toISOString() : null; }
function sendErr(sendJSON, res, status, error, extra = {}) {
  return sendJSON(res, status, { ok: false, error, ...extra });
}
function cleanText(s, maxLen) {
  if (!s) return '';
  return String(s).slice(0, maxLen || 200).replace(/\s+/g, ' ').trim();
}

function createStudioEpisodeApi(deps) {
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
    if (!r.rows.length) return sendErr(sendJSON, res, 404, '项目不存在'), null;
    const project = r.rows[0];
    const membership = isAdmin(user) ? { role: 'owner' } : await getMembership(client, user.id, project.workspace_id);
    if (!membership) return sendErr(sendJSON, res, 403, '无项目权限'), null;
    const owner = membership.role === 'owner' || isAdmin(user);
    return { project, membership, permissions: { role: membership.role, canRead: true, canUpdate: owner && project.status !== 'archived', canArchive: owner && project.status !== 'archived' } };
  }

  async function handleList(req, res, user, projectId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      const q = req.query || {};
      const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
      const offset = Math.max(Number(q.offset) || 0, 0);
      const statusFilter = q.status ? String(q.status).toLowerCase() : null;
      const params = [projectId];
      let where = 'WHERE project_id=$1';
      if (statusFilter) { params.push(statusFilter); where += ` AND status=$${params.length}`; }
      const cr = await client.query(`SELECT COUNT(*)::int AS total FROM episodes ${where}`, params);
      const r = await client.query(`SELECT * FROM episodes ${where} ORDER BY seq ASC, created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
      return sendJSON(res, 200, { episodes: r.rows.map(FORMAT_EPISODE), pagination: { limit, offset, total: cr.rows[0].total, hasMore: offset + r.rows.length < cr.rows[0].total } });
    } finally { client.release(); }
  }

  async function handleCreate(req, res, user, projectId) {
    const body = (await parseBody(req)) || {};
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');

      const canvasId = String(body.canvasId || '').trim();
      if (!canvasId) return sendErr(sendJSON, res, 400, 'CANVAS_ID_REQUIRED');

      // Verify canvas belongs to project
      const cr = await client.query('SELECT id FROM studio_canvases WHERE id=$1 AND project_id=$2 AND archived_at IS NULL', [canvasId, projectId]);
      if (!cr.rows.length) return sendErr(sendJSON, res, 404, 'CANVAS_NOT_FOUND');

      // Determine seq: next available after highest non-archived
      const seqR = await client.query('SELECT COALESCE(MAX(seq),0)::int AS mx FROM episodes WHERE project_id=$1 AND status != \'archived\'', [projectId]);
      const seq = (seqR.rows[0].mx || 0) + 1;

      const title = cleanText(body.title, 200);
      const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};

      const r = await client.query(
        `INSERT INTO episodes (id, project_id, workspace_id, canvas_id, seq, title, status, meta, created_by, updated_by, created_at, updated_at)
         VALUES ('ep-' || gen_random_uuid(), $1, $2, $3, $4, $5, 'draft', $6, $7, $7, NOW(), NOW())
         RETURNING *`,
        [projectId, access.project.workspace_id, canvasId, seq, title, JSON.stringify(meta), user.id]
      );
      const episode = r.rows[0];
      return sendJSON(res, 201, { ok: true, episode: FORMAT_EPISODE(episode) });
    } finally { client.release(); }
  }

  async function handleGet(req, res, user, projectId, epId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      const r = await client.query('SELECT * FROM episodes WHERE id=$1 AND project_id=$2', [epId, projectId]);
      if (!r.rows.length) return sendErr(sendJSON, res, 404, 'EPISODE_NOT_FOUND');
      const episode = r.rows[0];

      // Join shots
      const sr = await client.query('SELECT * FROM shots WHERE episode_id=$1 ORDER BY seq ASC', [epId]);
      const shots = sr.rows.map(FORMAT_SHOT);

      return sendJSON(res, 200, { ok: true, episode: FORMAT_EPISODE(episode), shots });
    } finally { client.release(); }
  }

  async function handlePatch(req, res, user, projectId, epId) {
    const body = (await parseBody(req)) || {};
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');

      const er = await client.query('SELECT * FROM episodes WHERE id=$1 AND project_id=$2', [epId, projectId]);
      if (!er.rows.length) return sendErr(sendJSON, res, 404, 'EPISODE_NOT_FOUND');
      const ep = er.rows[0];

      const updates = [];
      const params = [];
      let idx = 1;
      if (body.title !== undefined) {
        updates.push(`title=$${idx++}`);
        params.push(cleanText(body.title, 200));
      }
      if (body.meta !== undefined && body.meta !== null) {
        updates.push(`meta=$${idx++}`);
        params.push(JSON.stringify(body.meta));
      }
      if (body.status !== undefined) {
        const newStatus = String(body.status).toLowerCase();
        if (!['draft', 'published', 'archived'].includes(newStatus)) return sendErr(sendJSON, res, 400, 'INVALID_STATUS');
        if (newStatus === ep.status) {
          // no-op on status; fall through to update updated_at
        } else if (newStatus === 'published' && ep.status !== 'draft') {
          return sendErr(sendJSON, res, 400, 'INVALID_TRANSITION');
        } else if (newStatus === 'archived' && ep.status === 'archived') {
          // no-op
        } else {
          updates.push(`status=$${idx++}`, `updated_at=NOW()`);
          params.push(newStatus);
          if (newStatus === 'published') updates.push(`published_at=NOW()`);
          if (newStatus === 'archived') updates.push(`archived_at=NOW()`);
        }
      }

      if (!updates.length) return sendJSON(res, 200, { ok: true, episode: FORMAT_EPISODE(ep) });
      updates.push(`updated_by=$${idx++}`);
      params.push(user.id);
      params.push(epId);

      const r = await client.query(`UPDATE episodes SET ${updates.join(',')} WHERE id=$${idx} RETURNING *`, params);
      return sendJSON(res, 200, { ok: true, episode: FORMAT_EPISODE(r.rows[0]) });
    } finally { client.release(); }
  }

  async function handlePublish(req, res, user, projectId, epId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');

      const r = await client.query(
        `UPDATE episodes SET status='published', published_at=NOW(), updated_by=$1, updated_at=NOW()
         WHERE id=$2 AND project_id=$3 AND status='draft'
         RETURNING *`,
        [user.id, epId, projectId]
      );
      if (!r.rows.length) {
        const check = await client.query('SELECT status FROM episodes WHERE id=$1 AND project_id=$2', [epId, projectId]);
        if (!check.rows.length) return sendErr(sendJSON, res, 404, 'EPISODE_NOT_FOUND');
        return sendErr(sendJSON, res, 400, 'INVALID_TRANSITION', { currentStatus: check.rows[0]?.status });
      }
      return sendJSON(res, 200, { ok: true, episode: FORMAT_EPISODE(r.rows[0]) });
    } finally { client.release(); }
  }

  async function handle(req, res, urlPath, method) {
    const m = urlPath.match(EPISODES_RE);
    if (!m) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const projectId = decodeURIComponent(m[1]);
    const epId = m[2] ? decodeURIComponent(m[2]) : null;
    const seg2 = m[3];
    try {
      if (!epId && method === 'GET') return await handleList(req, res, user, projectId), true;
      if (!epId && method === 'POST') return await handleCreate(req, res, user, projectId), true;
      if (epId && !seg2 && method === 'GET') return await handleGet(req, res, user, projectId, epId), true;
      if (epId && !seg2 && method === 'PATCH') return await handlePatch(req, res, user, projectId, epId), true;
      if (epId && seg2 === 'publish' && method === 'POST') return await handlePublish(req, res, user, projectId, epId), true;
      return sendJSON(res, 404, { ok: false, error: 'Not Found' }), true;
    } catch (e) {
      console.error('[studio-episodes] route error:', e && e.stack);
      return sendJSON(res, 500, { ok: false, error: '服务内部错误' }), true;
    }
  }
  return { handle, FORMAT_EPISODE, FORMAT_SHOT };
}

module.exports = { createStudioEpisodeApi };
