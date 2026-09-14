'use strict';
/**
 * G18 — Project timeline API (0034 project_timeline/timeline_tracks/timeline_clips).
 * Ordered editing timeline of shot/asset-version clips. All timing is integer
 * milliseconds (Blueprint hard rule — no float seconds). Clips bind to asset
 * VERSION ids (immutable-output rule: sources are never edited in place).
 * Interface mirrors uploadApi: deps { pg, sessionUser, sendJSON, parseBody }.
 */
const crypto = require('crypto');
const rid = (p) => `${p}-${crypto.randomUUID()}`;

function validateTiming(v, name, errors) {
  if (v === undefined || v === null) return;
  if (!Number.isInteger(v) || v < 0) errors.push(`${name} 必须为非负整数毫秒`);
}

function createTimelineApi({ pg, sessionUser, sendJSON, parseBody }) {
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

  async function requireTimeline(res, projectId, timelineId) {
    const r = await pg.query(
      `SELECT t.* FROM project_timeline t JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 AND t.project_id = $2`,
      [timelineId, projectId],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  async function ensureVideoTrack(tid) {
    const r = await pg.query(`SELECT id FROM timeline_tracks WHERE timeline_id = $1 AND kind = 'video' ORDER BY order_index LIMIT 1`, [tid]);
    if (r.rows.length) return r.rows[0].id;
    const id = rid('tr');
    await pg.query(`INSERT INTO timeline_tracks (id, timeline_id, kind, order_index) VALUES ($1,$2,'video',0)`, [id, tid]);
    return id;
  }

  async function handle(req, res, urlPath, method) {
    const m = urlPath.match(/^\/api\/v2\/timelines(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!m) return false;
    const { projectId } = req.params || {};
    if (!projectId) { sendJSON(res, 400, { ok: false, error: 'projectId 必填' }); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const project = await requireProject(res, user, projectId);
    if (!project) return true;
    // Audit fix (G14 v4pro M1): viewer is read-only — mutating routes need an
    // owner/editor role.
    const WRITE = ['POST', 'PUT', 'DELETE'];
    if (WRITE.includes(method) && !['owner', 'editor'].includes(project.role)) {
      return sendJSON(res, 403, { ok: false, error: '只读成员不可修改（需 owner/editor）' });
    }

    const timelineId = m[1] ? decodeURIComponent(m[1]) : null;
    const sub = m[2] ? decodeURIComponent(m[2]) : null;
    const tail = m[3] ? decodeURIComponent(m[3]) : null;

    // ── timeline CRUD ──
    if (method === 'POST' && !timelineId && !sub) {
      const body = (await parseBody(req)) || {};
      const name = String(body.name || '').trim() || 'Timeline';
      const id = rid('tl');
      await pg.query(
        `INSERT INTO project_timeline (id, project_id, workspace_id, name, metadata) VALUES ($1,$2,$3,$4,$5)`,
        [id, projectId, project.workspace_id, name, JSON.stringify(body.metadata || {})],
      );
      return sendJSON(res, 201, { ok: true, timeline: { id, projectId, name } });
    }
    if (method === 'GET' && !timelineId && !sub) {
      const r = await pg.query(
        `SELECT id, name, created_at, updated_at FROM project_timeline WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId],
      );
      return sendJSON(res, 200, { ok: true, timelines: r.rows });
    }

    const timeline = timelineId ? await requireTimeline(res, projectId, timelineId) : null;
    if (timelineId && !timeline) { sendJSON(res, 404, { ok: false, error: 'timeline 不存在或不属于该项目' }); return true; }

    if (method === 'GET' && timelineId && !sub) {
      const trackId = await ensureVideoTrack(timelineId);
      // Plain clip read: asset_versions has no mime_type column (0032), so no
      // JOIN — a join here was a double bug (wrong key AND missing column),
      // caught by real-schema probe (audit H1 + follow-up).
      const clips = await pg.query(
        `SELECT c.id, c.shot_id, c.asset_version_id, c.order_index, c.start_ms, c.duration_ms
           FROM timeline_clips c
          WHERE c.track_id = $1 ORDER BY c.order_index, c.start_ms`,
        [trackId],
      );
      return sendJSON(res, 200, { ok: true, timeline: { id: timelineId, trackId }, clips: clips.rows });
    }

    // ── clip append ──
    if (method === 'POST' && timelineId && sub === 'clips') {
      const body = (await parseBody(req)) || {};
      const errors = [];
      if (!body.assetVersionId && !body.shotId) errors.push('assetVersionId 或 shotId 必填');
      validateTiming(body.durationMs, 'durationMs', errors);
      if (body.durationMs !== undefined && body.durationMs <= 0) errors.push('durationMs 必须 > 0');
      validateTiming(body.startMs, 'startMs', errors);
      if (errors.length) { sendJSON(res, 400, { ok: false, errors }); return true; }
      const trackId = await ensureVideoTrack(timelineId);
      // Audit fix (G18 H3): assetVersionId must exist AND belong to this project —
      // never bind a clip to a forged/foreign version id.
      if (body.assetVersionId) {
        const v = await pg.query(`SELECT 1 FROM asset_versions WHERE version_id = $1 AND project_id = $2`, [body.assetVersionId, projectId]);
        if (!v.rows.length) return sendJSON(res, 422, { ok: false, error: 'assetVersionId 不存在或不属于该项目' });
      }
      const max = await pg.query(`SELECT COALESCE(MAX(order_index), -1) AS m FROM timeline_clips WHERE track_id = $1`, [trackId]);
      const id = rid('cl');
      await pg.query(
        `INSERT INTO timeline_clips (id, track_id, shot_id, asset_version_id, order_index, start_ms, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, trackId, body.shotId || null, body.assetVersionId || null, max.rows[0].m + 1,
          Number.isInteger(body.startMs) ? body.startMs : 0, body.durationMs ?? 0],
      );
      return sendJSON(res, 201, { ok: true, clipId: id });
    }

    // ── clip remove (immutable source untouched) ──
    // Audit fix (G18 H2): scope by track of the CURRENT timeline — a foreign
    // clip id must not be deletable through this project's timeline.
    if (method === 'DELETE' && timelineId && sub === 'clips') {
      if (!tail) { sendJSON(res, 400, { ok: false, error: 'clipId 必填' }); return true; }
      const r = await pg.query(
        `DELETE FROM timeline_clips WHERE id = $1 AND track_id IN (SELECT id FROM timeline_tracks WHERE timeline_id = $2)`,
        [tail, timelineId],
      );
      return sendJSON(res, r.rowCount ? 200 : 404, { ok: r.rowCount ? true : false, error: r.rowCount ? undefined : 'clip 不存在或不属于该时间线' });
    }

    // ── clip reorder (replace order_index list, reindex 0..n) ──
    if (method === 'PUT' && timelineId && sub === 'order') {
      const body = (await parseBody(req)) || {};
      const order = Array.isArray(body.clipIds) ? body.clipIds : [];
      if (!order.length) { sendJSON(res, 400, { ok: false, error: 'clipIds 必填数组' }); return true; }
      const trackId = await ensureVideoTrack(timelineId);
      let client = null;
      try {
        client = typeof pg.connect === 'function' ? await pg.connect() : null;
        const q = client || pg;
        if (client) await client.query('BEGIN');
        let updated = 0;
        for (let i = 0; i < order.length; i++) {
          const u = await q.query(
            `UPDATE timeline_clips SET order_index = $1, updated_at = NOW() WHERE id = $2 AND track_id = $3`,
            [i, order[i], trackId],
          );
          updated += (u && u.rowCount) || 0;
        }
        if (updated < order.length) {
          // Audit fix (G18 M1): never report a fake success — some clip ids were
          // not on this track.
          if (client) await client.query('ROLLBACK').catch(() => {});
          return sendJSON(res, 409, { ok: false, error: `部分 clip 不属于该时间线 (${order.length - updated} 个未找到)` });
        }
        if (client) await client.query('COMMIT');
        return sendJSON(res, 200, { ok: true, reordered: order.length });
      } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        if (client && typeof client.release === 'function') await client.release();
      }
    }

    return false;
  }

  return { handle };
}

module.exports = { createTimelineApi };
