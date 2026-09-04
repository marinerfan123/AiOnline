'use strict';
/**
 * G24-EXP-L1 — Whole-project JSON bundle export (pure-read service, schema v1).
 *
 * `createProjectExport({ pg })` → `exportProject({ projectId })` returns
 * `{ ok: true, bundle }` where bundle is a self-contained snapshot of one
 * project (meta + media timelines + script content + persisted storyboard plan):
 *
 *   bundle = {
 *     meta:     { projectId, exportedAtMs, schemaVersion: 1, projectName },
 *     timelines?: [ per-timeline bundle ],   // each element has the SAME shape as
 *                                            // timelineExport's bundle — { meta:
 *                                            // {projectId, timelineId, exportedAtMs,
 *                                            // schemaVersion}, timeline: {name,
 *                                            // tracks:[{id,name,clips}]}, scriptRows? }
 *                                            // where per-timeline scriptRows = the plan
 *                                            // rows (project_shots_rows) whose shot_id
 *                                            // intersects this timeline's clip shot_ids
 *                                            // (identical rule to timelineExport Q4).
 *     scriptRows?:  [ script content rows ], // the project's OWN script content
 *                                            // (0039 script_rows): { id, episodeId?,
 *                                            // sceneIndex, rowIndex, kind, speaker?,
 *                                            // text, beat?, timingMs?, continuityNotes }
 *     storyboardPlan?: { version, fingerprint?, rows: [...] },
 *                                            // persisted G13 storyboard plan
 *                                            // (project_shots_rows, 0045+0054).
 *   }
 *
 * Per-timeline clips/tracks keep timelineExport's exact conventions (name mirrors
 * timeline_tracks.kind — 0034 has no name column; nil optionals omitted; BIGINT ms
 * coerced to integer JS numbers, no float seconds).
 *
 * Empty-table defaults (空表缺省): when a facet's TABLE exists but has ZERO rows the
 * key is OMITTED (no timelines / no scriptRows / no storyboardPlan). This is distinct
 * from schema-evolution degradation below, where the key IS present as null.
 *
 * Schema-evolution tolerance (宽容): script_rows (0039) and project_shots_rows
 * (0045+0054) are later-wave tables than the media timeline tables (0034/0032/0013),
 * so a deployment may legitimately lack them. When such a query hits PG 42P01
 * (relation missing) — or, for the 0054 additive plan_fingerprint column, 42703 —
 * the export does NOT crash:
 *   - table missing   → the affected facet key is emitted EXPLICITLY as null and the
 *                       whole result is { ok:false, error:'PROJECT_EXPORT_DEGRADED …',
 *                       bundle } — the bundle still carries every facet that DID read
 *                       (caller decides whether the degraded snapshot is usable; only
 *                       ok:true means a complete export).
 *   - 0054 column missing → the plan facet degrades to pre-0054 columns only
 *                       (fingerprint omitted — it is optional in the shape); rows are
 *                       still exported and ok stays true.
 * Per-timeline scriptRows are a projection of project_shots_rows, so when that table
 * is missing they are simply omitted inside the timeline entries (their optional key).
 *
 * Auth note (membership): this leaf has NO auth layer and takes no session/user. The
 * project-exists check is plain `projects` row lookup (404 = row absent). Workspace /
 * workspace_members membership and role gating MUST be enforced by the CALLER before
 * calling exportProject — otherwise any known projectId could be enumerated/exported.
 *
 * Determinism: same DB state → byte-identical JSON EXCEPT every exportedAtMs stamp
 * (one Date.now() captured at export start is reused for the top meta AND every nested
 * per-timeline meta). Tests deep-compare after ignoring exportedAtMs recursively.
 *
 * Read path: pure SELECTs, at most 8 queries regardless of timeline count.
 *   Q1 projects row (404 gate)
 *   Q2 project_timeline rows
 *   Q3 timeline_tracks for all of the project's timelines
 *   Q4 timeline_clips of those tracks (+ asset_versions/media LEFT JOIN for mimeType)
 *   Q5 script_rows content facet
 *   Q6 project_shots_rows plan facet (42703 → Q6b base-column retry without 0054)
 * Q3/Q4 are skipped when the project has no timeline; Q1–Q4 unexpected failures and
 * data-shape violations (e.g. non-integer ms) surface as { ok:false, error } — this
 * leaf never throws.
 */

function intMs(v, what) {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n)) throw new Error(`projectExport: ${what} 必须为整数毫秒 (got ${v})`);
  return n;
}

function intOr(v, what) {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n)) throw new Error(`projectExport: ${what} 必须为整数 (got ${v})`);
  return n;
}

function asJson(v, what) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { throw new Error(`projectExport: ${what} 非法 JSON`); }
  }
  return v;
}

function omitNil(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/** PG relation-missing predicate (42P01) — mirrors server/cli/mlg.cjs's helper. */
function isTableMissing(e) {
  return !!(e && (e.code === '42P01' || /relation "[^"]+" does not exist/i.test(String(e.message))));
}

/** PG column-missing predicate (42703) — 0054 additive plan_fingerprint absent. */
function isColumnMissing(e) {
  return !!(e && (e.code === '42703' || /column "[^"]+" does not exist/i.test(String(e.message))));
}

function errMsg(e) {
  return String((e && e.message) || e);
}

// Per-timeline clip shape — identical builder to timelineExport.buildClip.
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

// Plan-row shape (project_shots_rows) — identical builder to timelineExport.buildScriptRow.
// Deliberately excludes per-row 0052 locked / 0053 source_trace / 0054 plan_fingerprint /
// dirty and the surrogate id: row fidelity beyond the timelineExport row contract is not
// part of this bundle (summary fingerprint lives on storyboardPlan.fingerprint instead).
function buildPlanRow(r) {
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

// Script content row shape (0039 script_rows) — the project's own text.
function buildScriptRow(r) {
  const timingMs = intMs(r.timing_ms, 'script timing_ms');
  return omitNil({
    id: r.id,
    episodeId: r.episode_id || undefined,
    sceneIndex: intOr(r.scene_index, 'script scene_index'),
    rowIndex: intOr(r.row_index, 'script row_index'),
    kind: r.kind,
    speaker: r.speaker || undefined,
    text: r.text,
    beat: r.beat || undefined,
    timingMs,
    continuityNotes: asJson(r.continuity_notes, 'continuity_notes'),
  });
}

// Q1
const PROJECT_SQL = 'SELECT id, name FROM projects WHERE id = $1';
// Q2
const TIMELINES_SQL =
  'SELECT id, name FROM project_timeline WHERE project_id = $1 ORDER BY created_at, id';
// Q3
const TRACKS_SQL =
  'SELECT id, timeline_id, kind, order_index FROM timeline_tracks' +
  ' WHERE timeline_id = ANY($1::text[])' +
  ' ORDER BY timeline_id, order_index, id';
// Q4 — same join shape as timelineExport Q3 (mimeType via asset_versions → media).
const CLIPS_SQL =
  'SELECT c.id, c.track_id, c.shot_id, c.asset_version_id, c.order_index,' +
  ' c.start_ms, c.duration_ms, m.mime_type' +
  ' FROM timeline_clips c' +
  ' LEFT JOIN asset_versions av ON av.version_id = c.asset_version_id' +
  ' LEFT JOIN media m ON m.id = av.media_id' +
  ' WHERE c.track_id = ANY($1::text[])' +
  ' ORDER BY c.track_id, c.order_index, c.start_ms, c.id';
// Q5 — script content facet.
const SCRIPT_ROWS_SQL =
  'SELECT id, episode_id, scene_index, row_index, kind, speaker, text, beat,' +
  ' timing_ms, continuity_notes' +
  ' FROM script_rows' +
  ' WHERE project_id = $1' +
  ' ORDER BY episode_id NULLS FIRST, scene_index, row_index, id';
// Q6 — persisted storyboard plan facet (0054 plan_fingerprint read best-effort).
const PLAN_SQL =
  'SELECT script_id, shot_id, beat_id, scene_index, beat_index, shot_index,' +
  ' kind, intent, subject_refs, duration_ms, ordering, version, plan_fingerprint' +
  ' FROM project_shots_rows' +
  ' WHERE project_id = $1' +
  ' ORDER BY ordering, shot_id, id';
// Q6b — same read without the 0054 additive column (legacy deployment retry).
const PLAN_BASE_SQL =
  'SELECT script_id, shot_id, beat_id, scene_index, beat_index, shot_index,' +
  ' kind, intent, subject_refs, duration_ms, ordering, version' +
  ' FROM project_shots_rows' +
  ' WHERE project_id = $1' +
  ' ORDER BY ordering, shot_id, id';

function createProjectExport({ pg }) {
  async function exportProject({ projectId }) {
    try {
      return await doExport(projectId);
    } catch (e) {
      // Unexpected DB / data-shape failure (incl. float-ms violations, core-table
      // absence): report ok:false instead of throwing up to the HTTP layer.
      return { ok: false, error: `PROJECT_EXPORT_ERROR: ${errMsg(e)}` };
    }
  }

  async function doExport(projectId) {
    if (!projectId) return { ok: false, error: 'projectId 必填' };

    // Q1 — project existence gate (404). Membership/auth is the CALLER's duty
    // (see header) — nothing in this signature can tell whether the caller may
    // read this project.
    const proj = await pg.query(PROJECT_SQL, [projectId]);
    if (!proj.rows || !proj.rows.length) {
      return { ok: false, error: '项目不存在' };
    }
    const projectRow = proj.rows[0];

    // Q2 — timelines of the project (empty table → timelines key omitted below).
    const tlRes = await pg.query(TIMELINES_SQL, [projectId]);
    const tlRows = tlRes.rows || [];
    let trackRows = [];
    let clipRows = [];
    if (tlRows.length) {
      // Q3 — tracks across ALL project timelines in one shot.
      const trRes = await pg.query(TRACKS_SQL, [tlRows.map((t) => t.id)]);
      trackRows = trRes.rows || [];
      if (trackRows.length) {
        // Q4 — clips of all those tracks (+ media mimeType via asset_versions).
        const clRes = await pg.query(CLIPS_SQL, [trackRows.map((t) => t.id)]);
        clipRows = clRes.rows || [];
      }
    }

    // Q5 — script content facet (0039). 42P01 → facet null + degraded result.
    let scriptFacet;
    try {
      const res = await pg.query(SCRIPT_ROWS_SQL, [projectId]);
      scriptFacet = { rows: res.rows || [] };
    } catch (e) {
      if (isTableMissing(e)) scriptFacet = { tableMissing: true, reason: errMsg(e) };
      else throw e;
    }

    // Q6 — storyboard plan facet (0045 + 0054 fingerprint). 42P01 → facet null +
    // degraded; 42703 (0054 not applied) → Q6b retry without the fingerprint column
    // (fingerprint simply omitted; export stays complete for that schema).
    let planFacet;
    try {
      const full = await pg.query(PLAN_SQL, [projectId]);
      planFacet = { rows: full.rows || [], fingerprintRead: true };
    } catch (e) {
      if (isColumnMissing(e)) {
        const base = await pg.query(PLAN_BASE_SQL, [projectId]);
        planFacet = { rows: base.rows || [], fingerprintRead: false };
      } else if (isTableMissing(e)) {
        planFacet = { tableMissing: true, reason: errMsg(e) };
      } else {
        throw e;
      }
    }

    const now = Date.now(); // one stamp reused top-level AND nested (determinism helper)
    const bundle = {
      meta: {
        projectId,
        exportedAtMs: now,
        schemaVersion: 1,
        projectName: projectRow.name,
      },
    };
    const degrade = [];

    // ── per-timeline bundles (same shape as timelineExport.exportTimeline output) ──
    if (tlRows.length) {
      const clipsByTrack = new Map();
      for (const c of clipRows) {
        const list = clipsByTrack.get(c.track_id) || [];
        list.push(buildClip(c));
        clipsByTrack.set(c.track_id, list);
      }
      const tracksByTimeline = new Map();
      for (const t of trackRows) {
        const list = tracksByTimeline.get(t.timeline_id) || [];
        list.push(t);
        tracksByTimeline.set(t.timeline_id, list);
      }

      // Plan rows are shared by every timeline entry (project-wide one-shot read).
      // When the plan table is missing, timeline-level scriptRows are simply omitted.
      const planObjs = planFacet.tableMissing ? null : planFacet.rows.map(buildPlanRow);
      const planShotSet = planObjs ? new Set(planObjs.map((r) => r.shotId)) : null;

      const timelineBundles = [];
      for (const tl of tlRows) {
        const tracks = (tracksByTimeline.get(tl.id) || []).map((t) => {
          const name = t.kind; // 0034 timeline_tracks has no name column — kind is the label
          return { id: t.id, name, clips: clipsByTrack.get(t.id) || [] };
        });
        const timelineEntry = {
          meta: {
            projectId,
            timelineId: tl.id,
            exportedAtMs: now,
            schemaVersion: 1,
          },
          timeline: { name: tl.name, tracks },
        };
        // Timeline-bound plan rows (shot intersection) — same rule as timelineExport Q4.
        if (planObjs) {
          const shotIds = new Set();
          for (const track of tracks) {
            for (const clip of track.clips) {
              if (clip.shotId !== undefined && planShotSet.has(clip.shotId)) shotIds.add(clip.shotId);
            }
          }
          if (shotIds.size) {
            const bound = planObjs.filter((r) => shotIds.has(r.shotId));
            if (bound.length) timelineEntry.scriptRows = bound;
          }
        }
        timelineBundles.push(timelineEntry);
      }
      bundle.timelines = timelineBundles;
    }

    // ── top-level script content facet ──
    if (scriptFacet.tableMissing) {
      bundle.scriptRows = null;
      degrade.push(`script_rows 表缺失 (${scriptFacet.reason})`);
    } else if (scriptFacet.rows.length) {
      bundle.scriptRows = scriptFacet.rows.map(buildScriptRow);
    }
    // 空表缺省: zero rows → key omitted (no scriptRows key).

    // ── top-level storyboard plan facet ──
    if (planFacet.tableMissing) {
      bundle.storyboardPlan = null;
      degrade.push(`project_shots_rows 表缺失 (${planFacet.reason})`);
    } else if (planFacet.rows.length) {
      const versions = planFacet.rows.map((r) => Number(r.version));
      const maxVersion = Math.max(...versions); // newest persisted generation
      const plan = {
        version: maxVersion,
        rows: planFacet.rows.map(buildPlanRow),
      };
      // fingerprint = newest-generation fingerprint; deterministic (max of the distinct
      // fingerprints carried by rows of the max version — single value in practice).
      if (planFacet.fingerprintRead) {
        const fps = [...new Set(
          planFacet.rows
            .filter((r) => Number(r.version) === maxVersion && r.plan_fingerprint != null)
            .map((r) => String(r.plan_fingerprint)),
        )].sort();
        if (fps.length) plan.fingerprint = fps[fps.length - 1];
      }
      bundle.storyboardPlan = plan;
    }
    // 空表缺省: zero rows → key omitted (no storyboardPlan key).

    if (degrade.length) {
      return {
        ok: false,
        error: `PROJECT_EXPORT_DEGRADED — ${degrade.join('; ')}`,
        bundle, // partial-but-useful snapshot; only ok:true means a complete export
      };
    }
    return { ok: true, bundle };
  }

  return { exportProject };
}

module.exports = { createProjectExport };
