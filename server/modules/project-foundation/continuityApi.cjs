'use strict';
/**
 * G14 remediation — Continuity snapshot HTTP endpoints (/api/v2/bible/continuity).
 * Wires the continuityStore (0038 production_continuity_snapshots) into the
 * role-gated v2 API surface so "persistence" stops being dead code:
 *   GET  /api/v2/bible/continuity/:shotId            → stored snapshot or 404
 *   PUT  /api/v2/bible/continuity/:shotId  {state...} → upsert (validate first)
 *   DELETE /api/v2/bible/continuity/:shotId           → remove
 * Same factory shape as bibleApi/timelineApi: deps {pg, sessionUser, sendJSON,
 * parseBody}; requireUser(401) + requireProject(404/403, role attached);
 * viewer read-only; writes need owner|editor. derive/apply stay pure in
 * prompt-ir/continuity.cjs — this surface stores/reads the per-shot snapshot.
 */
const { validateContinuityState } = require('../prompt-ir/continuity.cjs');
const continuityStore = require('../prompt-ir/continuityStore.cjs');

function createContinuityApi({ pg, sessionUser, sendJSON, parseBody }) {
  function requireUser(req, res) {
    const user = sessionUser ? sessionUser(req) : null;
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    return user;
  }
  async function requireProject(res, user, projectId) {
    const r = await pg.query(
      `SELECT p.*, w.owner_id AS workspace_owner_id
       FROM projects p JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = $1`,
      [projectId],
    );
    if (!r.rows.length) { sendJSON(res, 404, { ok: false, error: '项目不存在' }); return null; }
    const m = await pg.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [r.rows[0].workspace_id, user.id],
    );
    if (!m.rows.length) { sendJSON(res, 403, { ok: false, error: '无项目权限' }); return null; }
    return { ...r.rows[0], role: m.rows[0].role };
  }
  async function handle(req, res, urlPath, method) {
    const m = urlPath.match(/^\/api\/v2\/bible\/continuity\/([^/]+)$/);
    if (!m) return false;
    const { projectId } = req.params || {};
    if (!projectId) { sendJSON(res, 400, { ok: false, error: 'projectId 必填' }); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const project = await requireProject(res, user, projectId);
    if (!project) return true;
    const shotId = decodeURIComponent(m[1]);

    if (method === 'GET') {
      const snap = await continuityStore.getSnapshot(pg, { projectId, shotId });
      if (!snap) return sendJSON(res, 404, { ok: false, error: '该 shot 无 continuity 快照' });
      return sendJSON(res, 200, { ok: true, snapshot: snap });
    }

    const WRITE = ['PUT', 'DELETE'];
    if (WRITE.includes(method) && !['owner', 'editor'].includes(project.role)) {
      return sendJSON(res, 403, { ok: false, error: '只读成员不可修改（需 owner/editor）' });
    }

    if (method === 'PUT') {
      const body = (await parseBody(req)) || {};
      const record = {
        project_id: projectId,
        shot_id: shotId,
        mode: body.mode || 'narrative',
        characterStates: body.characterStates || body.state || [],
        environmentStates: body.environmentStates || [],
      };
      // Character/env states may be given by reference id; run the pure derive
      // path when the caller passes characters/environment instead of states.
      const v = validateContinuityState(record);
      if (!v.ok) return sendJSON(res, 400, { ok: false, errors: v.errors });
      const r = await continuityStore.upsertSnapshot(pg, { record, capturedBy: user.id, source: body.source || 'manual' });
      if (!r.ok) return sendJSON(res, 400, { ok: false, errors: r.errors });
      return sendJSON(res, 200, { ok: true, shotId });
    }

    if (method === 'DELETE') {
      const r = await continuityStore.removeSnapshot(pg, { projectId, shotId });
      return sendJSON(res, r.removed ? 200 : 404, { ok: r.removed, error: r.removed ? undefined : '快照不存在' });
    }

    return false;
  }

  return { handle };
}

module.exports = { createContinuityApi };
