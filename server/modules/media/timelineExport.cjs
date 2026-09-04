'use strict';
/**
 * G24 — Timeline JSON bundle export (pure-read service, schema v1).
 *
 * `createTimelineExport({ pg })` → `exportTimeline({ projectId, timelineId })`
 * returns `{ ok: true, bundle }` where bundle is a self-contained, project-scoped
 * snapshot of one timeline:
 *
 *   bundle = {
 *     meta:     { projectId, timelineId, exportedAtMs, schemaVersion: 1 },
 *     timeline: {
 *       name,                                  // project_timeline.name (0034)
 *       tracks: [{ id, name, clips: [...] }],  // track "name" mirrors timeline_tracks.kind —
 *                                              // 0034 has no name column; deterministic mapping.
 *     },
 *     scriptRows?: [ ... ],                    // project_shots_rows plan rows whose shot_id
 *                                              // intersects the timeline's clip shot_ids.
 *                                              // Omitted when no clip carries a bound shot.
 *   }
 *
 *   clip = { id, shotId?, assetVersionId?, orderIndex, startMs, durationMs, mimeType? }
 *   mimeType is resolved asset_version_id → asset_versions.media_id → media.mime_type
 *   (asset_versions itself has no mime column — see 0032; media.mime_type from 0013).
 *   Optional keys (shotId / assetVersionId / mimeType) are omitted when NULL.
 *
 * Read path: 3–4 SELECTs, zero writes.
 *   Q1 timeline (JOIN projects; enforces timeline-belongs-to-project — else 404)
 *   Q2 tracks of timeline
 *   Q3 clips of those tracks (+ media LEFT JOIN for mimeType)
 *   Q4 project_shots_rows intersection (only when some clip has a shot_id)
 *
 * Determinism: same DB state → byte-identical bundle EXCEPT meta.exportedAtMs
 * (Date.now() stamp). Tests compare bundles after ignoring that one key.
 * Timing rules: start_ms/duration_ms are BIGINT integer ms; pg may surface them
 * as strings, so assembly coerces to Number and rejects non-integer values
 * (Blueprint hard rule — no float seconds). All numbers are JS numbers.
 */

function intMs(v, what) {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n)) throw new Error(`timelineExport: ${what} 必须为整数毫秒 (got ${v})`);
  // BIGINT (int8) can exceed 2^53; Number() silently rounds, so reject instead of
  // exporting a corrupted value (audit: BIGINT→Number 越界 → 静默失真).
  if (!Number.isSafeInteger(n)) throw new Error(`timelineExport: ${what} 超出安全整数范围 (got ${v})`);
  return n;
}

function intOr(v, what) {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n)) throw new Error(`timelineExport: ${what} 必须为整数 (got ${v})`);
  if (!Number.isSafeInteger(n)) throw new Error(`timelineExport: ${what} 超出安全整数范围 (got ${v})`);
  return n;
}

function asJson(v, what) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { throw new Error(`timelineExport: ${what} 非法 JSON`); }
  }
  return v;
}

function omitNil(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function buildClip(row) {
  const startMs = intMs(row.start_ms, 'clip start_ms');
  const durationMs = intMs(row.duration_ms, 'clip duration_ms');
  const orderIndex = intOr(row.order_index, 'clip order_index');
  return omitNil({
    id: row.id,
    shotId: row.shot_id || undefined,
    assetVersionId: row.asset_version_id || undefined,
    orderIndex,
    startMs,
    durationMs,
    mimeType: row.mime_type || undefined,
  });
}

function buildScriptRow(r) {
  return omitNil({
    scriptId: r.script_id,
    shotId: r.shot_id,
    beatId: r.beat_id,
    sceneIndex: intOr(r.scene_index, 'scene_index'),
    beatIndex: intOr(r.beat_index, 'beat_index'),
    shotIndex: intOr(r.shot_index, 'shot_index'),
    kind: r.kind,
    intent: r.intent,
    subjectRefs: asJson(r.subject_refs, 'subject_refs') || [],
    durationMs: intMs(r.duration_ms, 'psr duration_ms'),
    ordering: intOr(r.ordering, 'ordering'),
    version: intOr(r.version, 'version'),
  });
}

function createTimelineExport({ pg }) {
  async function exportTimeline({ projectId, timelineId }) {
    if (!projectId) return { ok: false, error: 'projectId 必填' };
    if (!timelineId) return { ok: false, error: 'timelineId 必填' };

    // Q1 — timeline row scoped to project (belongs-to-project check ⇒ 404).
    const tl = await pg.query(
      `SELECT t.id, t.project_id, t.name
         FROM project_timeline t JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 AND t.project_id = $2`,
      [timelineId, projectId],
    );
    if (!tl.rows || !tl.rows.length) {
      return { ok: false, error: 'timeline 不存在或不属于该项目' };
    }
    const tlRow = tl.rows[0];

    // Q2 — tracks of this timeline, deterministic order.
    const tracksRes = await pg.query(
      `SELECT id, kind, order_index
         FROM timeline_tracks
        WHERE timeline_id = $1
        ORDER BY order_index, id`,
      [timelineId],
    );
    const trackRows = tracksRes.rows || [];
    const trackIds = trackRows.map((r) => r.id);

    // Q3 — clips of exactly these tracks, with media mimeType via asset_versions.
    const clipRes = await pg.query(
      `SELECT c.id, c.track_id, c.shot_id, c.asset_version_id, c.order_index,
              c.start_ms, c.duration_ms, m.mime_type
         FROM timeline_clips c
         LEFT JOIN asset_versions av ON av.version_id = c.asset_version_id
         LEFT JOIN media m ON m.id = av.media_id
        WHERE c.track_id = ANY($1::text[])
        ORDER BY c.track_id, c.order_index, c.start_ms, c.id`,
      [trackIds],
    );
    const clipsByTrack = new Map();
    for (const c of clipRes.rows || []) {
      const list = clipsByTrack.get(c.track_id) || [];
      list.push(buildClip(c));
      clipsByTrack.set(c.track_id, list);
    }

    // Q4 — script-bound plan rows for the timeline's shots (only if any shot_id).
    const shotIds = [...new Set(
      [...clipsByTrack.values()]
        .flat()
        .map((c) => c.shotId)
        .filter((s) => s !== undefined),
    )];
    let scriptRows;
    if (shotIds.length) {
      const psr = await pg.query(
        `SELECT script_id, shot_id, beat_id, scene_index, beat_index, shot_index,
                kind, intent, subject_refs, duration_ms, ordering, version
           FROM project_shots_rows
          WHERE project_id = $1 AND shot_id = ANY($2::text[])
          ORDER BY ordering, shot_id, id`,
        [projectId, shotIds],
      );
      const rows = (psr.rows || []).map(buildScriptRow);
      scriptRows = rows.length ? rows : undefined;
    }

    const bundle = {
      meta: {
        projectId,
        timelineId,
        exportedAtMs: Date.now(),
        schemaVersion: 1,
      },
      timeline: {
        name: tlRow.name,
        tracks: trackRows.map((t) => ({
          id: t.id,
          name: t.kind, // 0034 timeline_tracks has no name column — kind is the stable label.
          clips: clipsByTrack.get(t.id) || [],
        })),
      },
    };
    if (scriptRows) bundle.scriptRows = scriptRows;
    return { ok: true, bundle };
  }

  return { exportTimeline };
}

module.exports = { createTimelineExport };
