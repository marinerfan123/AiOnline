'use strict';
/**
 * G13 phase-2 — Script rows CRUD API (0039 script_rows).
 * Endpoints under /api/v2/script (interface mirrors timelineApi/bibleApi:
 * deps {pg, sessionUser, sendJSON, parseBody}; internal requireUser(401) +
 * requireProject(404/403 via projects JOIN workspaces + workspace_members)).
 * Operations:
 *   POST   /api/v2/script/rows            {rows:[validated row...]} → batch insert
 *   GET    /api/v2/script/rows            ?scene= (filter by scene_index) or all
 *   GET    /api/v2/script/rows/:id        single
 *   PATCH  /api/v2/script/rows/:id        merge-update given columns (revalidated)
 *   PUT    /api/v2/script/order           {sceneIndex, rowIds:[...]} reindex 0..n
 *   DELETE /api/v2/script/rows/:id        hard delete (no deleted_at col)
 *   GET    /api/v2/script/:scriptId/storyboard  (or /api/v2/script/storyboard
 *          ?scriptId=) storyboard PLAN view — read-only; computes the
 *          deterministic beats/shots plan from the project's rows (scene order)
 *          via buildStoryboardPlan. Permissions follow GET /rows (viewer can
 *          read; owner/editor not required).
 * Rows carry integer-ms timing only (Blueprint hard rule). Speaker enforced for
 * dialogue by validateScriptRow.
 */
const crypto = require('crypto');
const { validateScriptRow, buildSceneRows, normalizeContinuityNotes } = require('./scriptModel.cjs');
const { buildStoryboardPlan } = require('./storyboardPlan.cjs');

/**
 * Match the storyboard plan-view route on a scriptApi URL. Two spellings are
 * accepted (same handler, same semantics):
 *   A) /api/v2/script/:scriptId/storyboard      — scriptId in the path
 *   B) /api/v2/script/storyboard?scriptId=…     — scriptId in params/query
 * (projectId is always supplied the way sibling rows routes receive it — from
 * the query string via req.params, project-bound SQL does the ownership.)
 * Returns { scriptId } when the URL is a storyboard route (scriptId may be
 * null when spelling B omits it — the handler then 400s), else null.
 * The 'rows' / 'order' prefixes are reserved by the CRUD routes, so
 * /api/v2/script/rows/storyboard stays a rows/:id GET, never a plan view.
 */
function matchStoryboardRoute(urlPath, params) {
  if (urlPath === '/api/v2/script/storyboard') {
    const sid = params && typeof params.scriptId === 'string' ? params.scriptId.trim() : '';
    return { scriptId: sid !== '' ? sid : null };
  }
  const sm = /^\/api\/v2\/script\/([^/]+)\/storyboard$/.exec(urlPath);
  if (sm && sm[1] !== 'rows' && sm[1] !== 'order') {
    let sid = null;
    try { sid = decodeURIComponent(sm[1]); } catch (e) { sid = null; }
    return { scriptId: sid };
  }
  return null;
}

function createScriptApi({ pg, sessionUser, sendJSON, parseBody }) {
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
    // Attach membership role so handlers can gate mutating routes (viewer = read-only).
    return { ...r.rows[0], role: m.rows[0].role };
  }

  async function handle(req, res, urlPath, method) {
    // Storyboard plan view — GET only in this leaf (a future POST mount that
    // persists the plan via storyboardShots is the 主线's call, not ours).
    const storyboard = matchStoryboardRoute(urlPath, req.params || {});
    if (storyboard && method !== 'GET') return false;
    const m = urlPath.match(/^\/api\/v2\/script\/rows(?:\/([^/]+))?$/) || urlPath.match(/^\/api\/v2\/script\/order$/);
    if (!m && !storyboard) return false;
    const isOrder = urlPath === '/api/v2/script/order';
    const { projectId } = req.params || {};
    if (!projectId) { sendJSON(res, 400, { ok: false, error: 'projectId 必填' }); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const project = await requireProject(res, user, projectId);
    if (!project) return true;
    // Audit fix (G14 v4pro M1): viewer is read-only — mutating routes need an
    // owner/editor role (PATCH included for script rows).
    const WRITE = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (WRITE.includes(method) && !['owner', 'editor'].includes(project.role)) {
      return sendJSON(res, 403, { ok: false, error: '只读成员不可修改（需 owner/editor）' });
    }

    // GET /api/v2/script/:scriptId/storyboard — storyboard PLAN view (read-only).
    // Permissions mirror GET /rows: any member may read (viewer included); the
    // WRITE gate above never applies to GET. scriptId ownership = project-scope:
    // a script's content carrier is that project's script_rows (no standalone
    // scripts table before 0045's note), so the rows SELECT binds project_id in
    // SQL exactly like the row-level ownership checks — no other project's rows
    // can ever leak into this plan.
    if (storyboard) {
      const scriptId = storyboard.scriptId;
      if (!scriptId) return sendJSON(res, 400, { ok: false, error: 'scriptId 必填' });
      const r = await pg.query(
        `SELECT * FROM script_rows WHERE project_id = $1 ORDER BY scene_index ASC, row_index ASC`,
        [projectId],
      );
      if (!r.rows.length) {
        return sendJSON(res, 400, { ok: false, error: '计划需至少 1 行脚本行（该项目暂无 script_rows）' });
      }
      // Best-effort entity sources for shot subjectRefs. Both live in this
      // project's bible tables (0027/0028); a read failure must never break the
      // plan view, so swallow to [] — subjectRefs then stay row-internal
      // (dialogue speaker only), which is exactly buildStoryboardPlan S4's
      // never-invent rule.
      let characters = [];
      let locations = [];
      try {
        const [ch, loc] = await Promise.all([
          pg.query('SELECT id, name FROM project_characters WHERE project_id = $1', [projectId]),
          pg.query('SELECT id, name FROM project_environments WHERE project_id = $1', [projectId]),
        ]);
        characters = (ch.rows || []).map((x) => ({ id: x.id, name: x.name }));
        locations = (loc.rows || []).map((x) => ({ id: x.id, name: x.name }));
      } catch (e) {
        characters = [];
        locations = [];
      }
      const plan = buildStoryboardPlan({
        rows: r.rows.map((row) => ({
          id: row.id,
          episode_id: row.episode_id,
          scene_index: row.scene_index,
          row_index: row.row_index,
          kind: row.kind,
          speaker: row.speaker,
          text: row.text,
          beat: row.beat,
          // PG returns BIGINT timing_ms as a string — normalize to an int ms.
          timing_ms: row.timing_ms == null ? null : Number(row.timing_ms),
        })),
        characters,
        locations,
      });
      if (!plan || !Array.isArray(plan.beats)) {
        return sendJSON(res, 400, {
          ok: false,
          errors: plan && Array.isArray(plan.errors) ? plan.errors : ['计划构建失败：脚本行不满足模型校验'],
        });
      }
      return sendJSON(res, 200, { ok: true, plan: { beats: plan.beats, totalShots: plan.totalShots } });
    }

    const id = m && m[1] ? decodeURIComponent(m[1]) : null;

    // PUT /order — reindex rows of one scene in given order
    if (method === 'PUT' && isOrder) {
      const body = (await parseBody(req)) || {};
      const sceneIndex = Number(body.sceneIndex);
      const rowIds = Array.isArray(body.rowIds) ? body.rowIds : [];
      if (!Number.isInteger(sceneIndex) || sceneIndex < 0) return sendJSON(res, 400, { ok: false, error: 'sceneIndex 必须为非负整数' });
      if (!rowIds.length) return sendJSON(res, 400, { ok: false, error: 'rowIds 必填数组' });
      let client = null;
      try {
        client = typeof pg.connect === 'function' ? await pg.connect() : null;
        const q = client || pg;
        if (client) await client.query('BEGIN');
        for (let i = 0; i < rowIds.length; i++) {
          await q.query(
            `UPDATE script_rows SET row_index = $1, updated_at = NOW()
              WHERE id = $2 AND project_id = $3 AND scene_index = $4`,
            [i, rowIds[i], projectId, sceneIndex],
          );
        }
        if (client) await client.query('COMMIT');
        return sendJSON(res, 200, { ok: true, reordered: rowIds.length });
      } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        if (client && typeof client.release === 'function') await client.release();
      }
    }

    // PATCH /rows/:id — merge update given columns (validated against the full
    // merged row, so partial payloads can't skip required-field semantics).
    if (method === 'PATCH' && id) {
      const body = (await parseBody(req)) || {};
      const cur = await pg.query(`SELECT * FROM script_rows WHERE id = $1 AND project_id = $2`, [id, projectId]);
      if (!cur.rows.length) return sendJSON(res, 404, { ok: false, error: 'row 不存在或不属于该项目' });
      const existing = cur.rows[0];
      const merged = { ...existing, project_id: projectId };
      const allowed = ['kind', 'speaker', 'text', 'beat', 'timing_ms', 'scene_index', 'row_index', 'continuity_notes', 'episode_id'];
      const sets = [];
      const vals = [];
      for (const k of allowed) {
        if (body[k] !== undefined) {
          // continuity_notes is JSONB: normalize so a pre-encoded JSON string
          // is not double-encoded on the way to the column.
          const v = k === 'continuity_notes' ? normalizeContinuityNotes(body[k]) : body[k];
          merged[k] = v; sets.push(`${k} = $${sets.length + 2}`); vals.push(v);
        }
      }
      if (!sets.length) return sendJSON(res, 400, { ok: false, error: '无更新字段' });
      const check = validateScriptRow({ ...merged, id: existing.id || id || 'row-x' });
      if (!check.ok) return sendJSON(res, 400, { ok: false, errors: check.errors });
      const r = await pg.query(
        `UPDATE script_rows SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING id`,
        [id, projectId, ...vals],
      );
      if (!r.rows.length) return sendJSON(res, 409, { ok: false, error: '并发修改，请重试' });
      return sendJSON(res, 200, { ok: true, id });
    }

    // DELETE /rows/:id
    if (method === 'DELETE' && id) {
      const r = await pg.query(`DELETE FROM script_rows WHERE id = $1 AND project_id = $2`, [id, projectId]);
      return sendJSON(res, r.rowCount ? 200 : 404, { ok: r.rowCount ? true : false, error: r.rowCount ? undefined : 'row 不存在' });
    }

    // POST /rows — batch insert (validated, auto row_index per scene)
    if (method === 'POST' && !id) {
      const body = (await parseBody(req)) || {};
      const rows = Array.isArray(body.rows) ? body.rows : (body.row ? [body.row] : null);
      if (!rows || !rows.length) return sendJSON(res, 400, { ok: false, error: 'rows 必填数组' });
      const out = [];
      const errors = [];
      for (let i = 0; i < rows.length; i++) {
        const raw = { ...rows[i], project_id: projectId };
        const v = validateScriptRow(raw);
        if (!v.ok) { errors.push({ index: i, errors: v.errors }); continue; }
        const rid = `sr-${crypto.randomUUID()}`;
        const sceneIndex = Number.isInteger(raw.scene_index) ? raw.scene_index : 0;
        const next = await pg.query(
          `SELECT COALESCE(MAX(row_index), -1) AS m FROM script_rows WHERE project_id = $1 AND scene_index = $2`,
          [projectId, sceneIndex],
        );
        const rowIndex = Number.isInteger(raw.row_index) ? raw.row_index : next.rows[0].m + 1;
        const row = {
          id: rid, project_id: projectId, episode_id: raw.episode_id || null,
          scene_index: sceneIndex, row_index: rowIndex,
          kind: raw.kind || 'dialogue', speaker: raw.speaker || null,
          text: String(raw.text || ''), beat: raw.beat || null,
          timing_ms: raw.timing_ms != null ? raw.timing_ms : null,
          continuity_notes: normalizeContinuityNotes(raw.continuity_notes),
        };
        await pg.query(
          `INSERT INTO script_rows (id, project_id, episode_id, scene_index, row_index, kind, speaker, text, beat, timing_ms, continuity_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.project_id, row.episode_id, row.scene_index, row.row_index, row.kind, row.speaker, row.text, row.beat, row.timing_ms, JSON.stringify(row.continuity_notes)],
        );
        out.push(row);
      }
      return sendJSON(res, errors.length ? 207 : 201, { ok: true, inserted: out, errors });
    }

    // GET /rows/:id
    if (method === 'GET' && id) {
      const r = await pg.query(`SELECT * FROM script_rows WHERE id = $1 AND project_id = $2`, [id, projectId]);
      if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'row 不存在' });
      return sendJSON(res, 200, { ok: true, row: r.rows[0] });
    }

    // GET /rows — all or by scene (scene grouping helper exported for UI)
    if (method === 'GET' && !id) {
      const scene = req.params.scene !== undefined ? Number(req.params.scene) : NaN;
      const where = Number.isInteger(scene) ? ` WHERE project_id = $1 AND scene_index = $2` : ` WHERE project_id = $1`;
      const params = Number.isInteger(scene) ? [projectId, scene] : [projectId];
      const r = await pg.query(
        `SELECT * FROM script_rows${where} ORDER BY scene_index ASC, row_index ASC`, params,
      );
      return sendJSON(res, 200, { ok: true, scenes: buildSceneRows(r.rows), rows: r.rows });
    }

    return false;
  }

  return { handle };
}

module.exports = { createScriptApi };
