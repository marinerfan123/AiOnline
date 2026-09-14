'use strict';
/**
 * G14 remediation — Continuity snapshot HTTP endpoints (/api/v2/bible/continuity).
 * Wires the continuityStore (0038 production_continuity_snapshots) into the
 * role-gated v2 API surface so "persistence" stops being dead code:
 *   GET  /api/v2/bible/continuity/:shotId            → stored snapshot or 404
 *   PUT  /api/v2/bible/continuity/:shotId  {state...} → upsert (validate first)
 *   PUT  ... mode:'scene' (+sceneId)                  → scene-inheritance capture
 *   DELETE /api/v2/bible/continuity/:shotId           → remove
 * Same factory shape as bibleApi/timelineApi: deps {pg, sessionUser, sendJSON,
 * parseBody}; requireUser(401) + requireProject(404/403, role attached);
 * viewer read-only; writes need owner|editor. derive/apply stay pure in
 * prompt-ir/continuity.cjs — this surface stores/reads the per-shot snapshot.
 */
const { validateContinuityState } = require('../prompt-ir/continuity.cjs');
const continuityStore = require('../prompt-ir/continuityStore.cjs');
const { deriveAndStoreSnapshot } = require('../prompt-ir/continuityDerive.cjs');
const { inheritSceneDefault } = require('../prompt-ir/continuityInheritance.cjs');

/**
 * G14-② — PUT scene-inheritance capture (mode:'scene').
 *
 * Mode labels accepted by PUT (stored on the row as `mode`): only these two;
 * any other value is rejected 400 before a write happens.
 */
const PUT_MODES = new Set(['narrative', 'scene']);

/**
 * Ordered candidate lookup for scene inheritance: all shots that belong to the
 * scene (structure shot nodes under the scene node) and come BEFORE the current
 * shot in scene order, joined to their stored continuity snapshots.
 *
 * Membership rule: when the current shot node is found under the scene the
 * candidates are its strict predecessors (order_index < current); when the
 * shot has no node under the scene yet (capture before structure materialised)
 * it is treated as appended at the scene's end → all scene shots are
 * candidates. Caller passes sceneId — the shot's scene — explicitly; without a
 * sceneId there is no ordering context and no inheritance (empty start, same as
 * derive's all-empty slate). Rows come back newest-first so the caller can take
 * the first content-bearing snapshot as the "latest base".
 */
const SCENE_PRIOR_SNAPSHOTS_SQL = `
WITH scene_shots AS (
  SELECT shot_id, order_index
    FROM project_structure_nodes
   WHERE project_id = $1 AND type = 'shot' AND parent_id = $3
),
cur AS (
  SELECT order_index FROM scene_shots WHERE shot_id = $2
)
SELECT p.shot_id AS shot_id,
       s.character_states   AS character_states,
       s.environment_states AS environment_states
  FROM scene_shots p
  LEFT JOIN production_continuity_snapshots s
         ON s.project_id = p.project_id AND s.shot_id = p.shot_id
 WHERE p.order_index < (SELECT order_index FROM cur)
    OR NOT EXISTS (SELECT 1 FROM cur)
 ORDER BY p.order_index DESC`;

/**
 * Normalise a character_states/environment_states JSONB value into an array:
 * pg already parsed JSONB → arrays, but tolerate raw JSON strings/null.
 */
function toContentArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

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
      // Derive mode: load character/environment rows and derive the snapshot
      // (derive-on-write call site; closes the audit derive-gap).
      if (body.derive === true || (body.characterIds && Array.isArray(body.characterIds))) {
        const out = await deriveAndStoreSnapshot(pg, {
          projectId,
          shotId,
          characterIds: Array.isArray(body.characterIds) ? body.characterIds : [],
          environmentId: body.environmentId || null,
          mode: body.mode || 'narrative',
          capturedBy: user.id,
          source: 'derive',
        });
        if (!out.ok) {
          if (out.code === 'SHOT_NOT_FOUND') return sendJSON(res, 404, { ok: false, error: 'shot 不存在（FK）' });
          return sendJSON(res, 400, { ok: false, errors: out.errors || [out.code || 'derive 失败'] });
        }
        return sendJSON(res, 200, { ok: true, shotId, derived: true });
      }

      // Every non-derive PUT stores a snapshot under a supported capture mode;
      // unknown mode labels are rejected before any read/write.
      const mode = body.mode != null && body.mode !== '' ? String(body.mode) : 'narrative';
      if (!PUT_MODES.has(mode)) {
        return sendJSON(res, 400, { ok: false, errors: [`mode '${mode}' 不支持（PUT 支持: narrative | scene）`] });
      }

      // Scene-inheritance mode (G14-②): capture the current shot snapshot as a
      // field-level override over the latest prior shot snapshot of its scene.
      // The pure continuityInheritance.inheritSceneDefault(base, shot) fills the
      // current record's empty/absent content fields from the base snapshot and
      // element-merges present fields with the shot side winning (v1 override →
      // the merged result is what lands in 0038). sceneId missing / no
      // content-bearing prior snapshot → all-empty start like derive:
      // {ok:true, inheritedFrom:null} and no error.
      if (mode === 'scene') {
        const sceneId = body.sceneId != null && body.sceneId !== '' ? body.sceneId : null;
        let base = null;
        let inheritedFrom = null;
        if (sceneId) {
          const prior = await pg.query(SCENE_PRIOR_SNAPSHOTS_SQL, [projectId, shotId, sceneId]);
          for (const row of (prior && prior.rows) || []) {
            const cs = toContentArray(row && row.character_states);
            const es = toContentArray(row && row.environment_states);
            if (cs.length || es.length) { // first (nearest prior) content-bearing snapshot = base
              base = { shot_id: row.shot_id, characterStates: cs, environmentStates: es };
              inheritedFrom = row.shot_id;
              break;
            }
          }
        }
        const record = {
          project_id: projectId,
          shot_id: shotId,
          mode,
          characterStates: body.characterStates || body.state || [],
          environmentStates: body.environmentStates || [],
        };
        const sv = validateContinuityState(record);
        if (!sv.ok) return sendJSON(res, 400, { ok: false, errors: sv.errors });
        let stored = record;
        if (base) {
          const merged = inheritSceneDefault(base, record);
          if (merged) stored = merged;
        }
        try {
          const r = await continuityStore.upsertSnapshot(pg, { record: stored, capturedBy: user.id, source: body.source || 'scene' });
          if (!r.ok) return sendJSON(res, 400, { ok: false, errors: r.errors });
        } catch (e) {
          if (e && e.code === '23503') return sendJSON(res, 404, { ok: false, error: 'shot 不存在（FK）' });
          throw e;
        }
        return sendJSON(res, 200, { ok: true, shotId, mode, inheritedFrom });
      }

      const record = {
        project_id: projectId,
        shot_id: shotId,
        mode,
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
