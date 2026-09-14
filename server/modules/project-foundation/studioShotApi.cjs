'use strict';
/**
 * M05-E — Studio Shot API (/api/v2/projects/:id/episodes/:epId/shots).
 *
 *  - POST   /api/v2/projects/:projectId/episodes/:epId/shots       bulk create from canvas nodes
 *  - GET    /api/v2/projects/:projectId/episodes/:epId/shots       timeline (ordered by seq)
 *  - PATCH  /api/v2/projects/:projectId/episodes/:epId/shots/:shotId  update seq/duration/note
 */
const SHOTS_RE = /^\/api\/v2\/projects\/([^/]+)\/episodes\/([^/]+)\/shots(?:\/([^/]+))?$/;

const FORMAT_SHOT = (r) => ({
  id: r.id,
  episodeId: r.episode_id,
  canvasNodeId: r.canvas_node_id,
  seq: r.seq,
  assetId: r.asset_id || null,
  durationSeconds: r.duration_seconds || null,
  note: r.note || null,
  title: r.title || null,
  storyIntent: r.story_intent && typeof r.story_intent === 'object' ? r.story_intent : (r.story_intent ? JSON.parse(r.story_intent) : null),
  cinematography: r.cinematography || null,
  context: r.context || null,
  generationMeta: r.generation_meta || null,
  output: r.output || null,
  commerce: r.commerce || null,
  version: r.version != null ? Number(r.version) : 1,
  createdAt: toIso(r.created_at),
});

function toIso(v) { return v ? new Date(v).toISOString() : null; }
function sendErr(sendJSON, res, status, error, extra = {}) {
  return sendJSON(res, status, { ok: false, error, ...extra });
}
function cleanText(s, maxLen) {
  if (!s) return '';
  return String(s).slice(0, maxLen || 500).replace(/\s+/g, ' ').trim();
}

function createStudioShotApi(deps) {
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
    return { project, membership, permissions: { role: membership.role, canRead: true, canUpdate: owner && project.status !== 'archived' } };
  }
  async function requireEpisode(client, res, user, projectId, epId) {
    const er = await client.query('SELECT * FROM episodes WHERE id=$1 AND project_id=$2', [epId, projectId]);
    if (!er.rows.length) return sendErr(sendJSON, res, 404, 'EPISODE_NOT_FOUND'), null;
    return er.rows[0];
  }

  async function handleList(req, res, user, projectId, epId) {
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      const ep = await requireEpisode(client, res, user, projectId, epId);
      if (!ep) return;
      const r = await client.query('SELECT * FROM shots WHERE episode_id=$1 ORDER BY seq ASC', [epId]);
      return sendJSON(res, 200, { shots: r.rows.map(FORMAT_SHOT) });
    } finally { client.release(); }
  }

  async function handleBulkCreate(req, res, user, projectId, epId) {
    const body = (await parseBody(req)) || {};
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');
      const ep = await requireEpisode(client, res, user, projectId, epId);
      if (!ep) return;
      if (ep.status === 'archived') return sendErr(sendJSON, res, 400, 'EPISODE_ARCHIVED');

      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      if (!nodes.length) return sendErr(sendJSON, res, 400, 'NODES_REQUIRED');

      // Validate canvas_node_ids exist on the episode's canvas
      const nodeIds = nodes.map(n => String(n.canvasNodeId || '').trim()).filter(Boolean);
      if (!nodeIds.length) return sendErr(sendJSON, res, 400, 'NODES_REQUIRED');
      const existing = await client.query(
        'SELECT node_id FROM studio_canvas_nodes WHERE canvas_id=$1 AND node_id=ANY($2::text[])',
        [ep.canvas_id, nodeIds]
      );
      const existingIds = new Set(existing.rows.map(r => r.node_id));
      const invalid = nodeIds.filter(id => !existingIds.has(id));
      if (invalid.length) return sendErr(sendJSON, res, 400, 'INVALID_NODE_IDS', { invalidNodeIds: invalid });

      // Determine starting seq: max existing + 1
      const seqR = await client.query('SELECT COALESCE(MAX(seq),0)::int AS mx FROM shots WHERE episode_id=$1', [epId]);
      let nextSeq = (seqR.rows[0].mx || 0) + 1;

      const inserted = [];
      for (const n of nodes) {
        const canvasNodeId = String(n.canvasNodeId || '').trim();
        const assetId = n.assetId ? String(n.assetId) : null;
        const durationSeconds = n.durationSeconds != null ? Number(n.durationSeconds) : null;
        const note = cleanText(n.note, 500);
        if (isNaN(durationSeconds) && n.durationSeconds != null) return sendErr(sendJSON, res, 400, 'INVALID_DURATION');

        const r = await client.query(
          `INSERT INTO shots (id, episode_id, canvas_node_id, seq, asset_id, duration_seconds, note, created_at)
           VALUES ('shot-' || gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())
           RETURNING *`,
          [epId, canvasNodeId, nextSeq++, assetId, durationSeconds, note]
        );
        inserted.push(FORMAT_SHOT(r.rows[0]));
      }
      return sendJSON(res, 201, { ok: true, shots: inserted });
    } finally { client.release(); }
  }

  async function handlePatch(req, res, user, projectId, epId, shotId) {
    const body = (await parseBody(req)) || {};
    const client = await pg.connect();
    try {
      const access = await requireProject(client, res, user, projectId);
      if (!access) return;
      if (!access.permissions.canUpdate) return sendErr(sendJSON, res, 403, '无权执行该项目');

      // Verify shot belongs to episode in this project
      const sr = await client.query(
        `SELECT s.* FROM shots s JOIN episodes e ON e.id=s.episode_id
         WHERE s.id=$1 AND e.project_id=$2`,
        [shotId, projectId]
      );
      if (!sr.rows.length) return sendErr(sendJSON, res, 404, 'SHOT_NOT_FOUND');
      const shot = sr.rows[0];

      // Locked fields (system-written during generation) are not user-editable.
      for (const k of ['generationMeta', 'output', 'commerce']) {
        if (body[k] !== undefined) return sendErr(sendJSON, res, 400, 'LOCKED_FIELD', { field: k });
      }

      const updates = [];
      const params = [];
      let idx = 1;
      if (body.seq !== undefined) {
        const s = Number(body.seq);
        if (!Number.isInteger(s) || s < 1) return sendErr(sendJSON, res, 400, 'INVALID_SEQ');
        updates.push(`seq=$${idx++}`);
        params.push(s);
      }
      if (body.durationSeconds !== undefined) {
        const d = body.durationSeconds == null ? null : Number(body.durationSeconds);
        if (body.durationSeconds != null && (isNaN(d) || d < 0)) return sendErr(sendJSON, res, 400, 'INVALID_DURATION');
        updates.push(`duration_seconds=$${idx++}`);
        params.push(d);
      }
      if (body.note !== undefined) {
        updates.push(`note=$${idx++}`);
        params.push(cleanText(body.note, 500));
      }
      if (body.assetId !== undefined) {
        updates.push(`asset_id=$${idx++}`);
        params.push(body.assetId ? String(body.assetId) : null);
      }
      if (body.title !== undefined) {
        updates.push(`title=$${idx++}`);
        params.push(cleanText(body.title, 200));
      }
      for (const k of ['storyIntent', 'cinematography', 'context']) {
        if (body[k] !== undefined) {
          const col = k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
          updates.push(`${col}=$${idx++}`);
          params.push(typeof body[k] === 'string' ? body[k] : JSON.stringify(body[k]));
        }
      }

      if (!updates.length) return sendJSON(res, 200, { ok: true, shot: FORMAT_SHOT(shot) });

      // Optimistic concurrency: always bump version; if a version is supplied, require a match.
      updates.push(`version = version + 1`);
      const optimistic = body.version != null ? Number(body.version) : null;
      const concurr = optimistic != null && Number.isInteger(optimistic) && optimistic > 0;
      const where = concurr ? `id=$${idx} AND version=$${idx + 1}` : `id=$${idx}`;
      const rp = [...params, shotId];
      if (concurr) rp.push(optimistic);

      const r = await client.query(
        `UPDATE shots SET ${updates.join(', ')} WHERE ${where} RETURNING *`,
        rp
      );
      if (!r.rows.length) return sendErr(sendJSON, res, 409, 'STALE_SHOT_VERSION');
      return sendJSON(res, 200, { ok: true, shot: FORMAT_SHOT(r.rows[0]) });
    } finally { client.release(); }
  }

  async function handle(req, res, urlPath, method) {
    const m = urlPath.match(SHOTS_RE);
    if (!m) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const projectId = decodeURIComponent(m[1]);
    const epId = decodeURIComponent(m[2]);
    const shotId = m[3] ? decodeURIComponent(m[3]) : null;
    try {
      if (!shotId && method === 'GET') return await handleList(req, res, user, projectId, epId), true;
      if (!shotId && method === 'POST') return await handleBulkCreate(req, res, user, projectId, epId), true;
      if (shotId && method === 'PATCH') return await handlePatch(req, res, user, projectId, epId, shotId), true;
      return sendJSON(res, 404, { ok: false, error: 'Not Found' }), true;
    } catch (e) {
      console.error('[studio-shots] route error:', e && e.stack);
      return sendJSON(res, 500, { ok: false, error: '服务内部错误' }), true;
    }
  }
  return { handle, FORMAT_SHOT };
}

module.exports = { createStudioShotApi };
