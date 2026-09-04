'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectExport } = require('./projectExport.cjs');
const { createTimelineExport } = require('../media/timelineExport.cjs');

/**
 * G24-EXP-L1 — whole-project export bundle tests.
 * Fake pg routes every SELECT of BOTH projectExport and the real timelineExport
 * (the equivalence test proves per-timeline entries are shape-identical to the
 * timelineExport bundle). BIGINT ms/ints are handed back as strings — exactly what
 * node-postgres does for int8 — so the tests prove integer JS-number coercion.
 * Tolerance modes: missing {script_rows|project_shots_rows} tables (42P01) and a
 * pre-0054 deployment (plan_fingerprint column missing, 42703).
 */

function baseData() {
  return {
    projects: [{ id: 'p-1', name: '测试项目' }],
    timelines: [
      { id: 'tl-1', project_id: 'p-1', name: '主时间线', created_at: '2026-09-04T00:00:00Z' },
      { id: 'tl-2', project_id: 'p-1', name: '空时间线', created_at: '2026-09-04T00:00:01Z' },
    ],
    tracks: [
      { id: 'tr-video', timeline_id: 'tl-1', kind: 'video', order_index: 0 },
      { id: 'tr-voice', timeline_id: 'tl-1', kind: 'voice', order_index: 1 },
      // tl-2 has no tracks → empty timeline entry with tracks: [].
    ],
    clips: [
      // Q4 rows are pre-joined: mime_type resolved via asset_versions→media.
      { id: 'cl-1', track_id: 'tr-video', shot_id: 's1:b1:k1', asset_version_id: 'av-100', order_index: '0', start_ms: '0', duration_ms: '3000', mime_type: 'video/mp4' },
      { id: 'cl-2', track_id: 'tr-video', shot_id: null, asset_version_id: 'av-200', order_index: '1', start_ms: '3000', duration_ms: '1500', mime_type: 'image/png' },
      { id: 'cl-3', track_id: 'tr-video', shot_id: 's2:b1:k1', asset_version_id: null, order_index: '2', start_ms: '4500', duration_ms: '2000', mime_type: null },
    ],
    // 0039 script_rows — the project's own script CONTENT facet.
    scriptContent: [
      { id: 'sr-1', project_id: 'p-1', episode_id: null, scene_index: '0', row_index: '0', kind: 'dialogue', speaker: 'A', text: '你好', beat: 'b1', timing_ms: '1000', continuity_notes: {} },
      { id: 'sr-2', project_id: 'p-1', episode_id: null, scene_index: '0', row_index: '1', kind: 'action', speaker: null, text: '她转身离开。', beat: null, timing_ms: null, continuity_notes: {} },
    ],
    // 0045+0054 project_shots_rows — persisted storyboard plan facet.
    psr: [
      { script_id: 'scr-1', shot_id: 's1:b1:k1', beat_id: 'b1', scene_index: '0', beat_index: '0', shot_index: '0', kind: 'standard', intent: 'dialogue', subject_refs: [{ entityType: 'character', entityId: 'ch-1', label: 'A' }], duration_ms: '3000', ordering: '0', version: '2', plan_fingerprint: 'fp-002' },
      { script_id: 'scr-1', shot_id: 's2:b1:k1', beat_id: 'b1', scene_index: '1', beat_index: '0', shot_index: '0', kind: 'standard', intent: 'action', subject_refs: [], duration_ms: '2000', ordering: '1', version: '2', plan_fingerprint: 'fp-002' },
      // Older-generation leftover (locked row survives an apply) — still exported in
      // storyboardPlan.rows, but never in a per-timeline scriptRows binding.
      { script_id: 'scr-1', shot_id: 'z9:x:y', beat_id: 'b9', scene_index: '9', beat_index: '0', shot_index: '0', kind: 'standard', intent: 'action', subject_refs: [], duration_ms: '9999', ordering: '9', version: '1', plan_fingerprint: 'fp-001' },
    ],
  };
}

/**
 * Shared fake pg serving BOTH projectExport queries and the real timelineExport
 * module (imported by the equivalence test). opts:
 *   missing: { script_rows?, project_shots_rows? }  → simulate PG 42P01
 *   missingFingerprintCol: true                     → simulate pre-0054 (42703)
 */
function makeHarness(data = baseData(), opts = {}) {
  const calls = [];
  const pg = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const s = sql;
      // Q1 projectExport — plain projects row lookup.
      if (s.includes('FROM projects') && !s.includes('JOIN projects p')) {
        return { rows: data.projects.filter((p) => p.id === params[0]) };
      }
      // Q1 timelineExport — timeline scoped to project (belongs-to-project 404).
      if (s.includes('JOIN projects p ON p.id = t.project_id')) {
        return { rows: data.timelines.filter((t) => t.id === params[0] && t.project_id === params[1]) };
      }
      // Q2 projectExport — project's timeline list.
      if (s.includes('FROM project_timeline') && !s.includes('JOIN')) {
        return { rows: data.timelines.filter((t) => t.project_id === params[0]) };
      }
      // Q3 tracks — projectExport (all timelines) vs timelineExport (one timeline).
      if (s.includes('FROM timeline_tracks')) {
        if (s.includes('timeline_id = ANY')) {
          const ids = params[0] || [];
          return { rows: data.tracks.filter((t) => ids.includes(t.timeline_id)) };
        }
        return { rows: data.tracks.filter((t) => t.timeline_id === params[0]) };
      }
      // Q4 clips — identical SQL in both modules.
      if (s.includes('FROM timeline_clips c')) {
        const ids = params[0] || [];
        return { rows: data.clips.filter((c) => ids.includes(c.track_id)) };
      }
      // Q5 — script content facet (0039).
      if (s.includes('FROM script_rows')) {
        if (opts.missing && opts.missing.script_rows) {
          throw Object.assign(new Error('relation "script_rows" does not exist'), { code: '42P01' });
        }
        return { rows: (data.scriptContent || []).filter((r) => r.project_id === undefined || r.project_id === params[0]) };
      }
      // Q6 / Q6b — storyboard plan facet (0045+0054).
      if (s.includes('FROM project_shots_rows')) {
        if (opts.missing && opts.missing.project_shots_rows) {
          throw Object.assign(new Error('relation "project_shots_rows" does not exist'), { code: '42P01' });
        }
        if (opts.missingFingerprintCol && s.includes('plan_fingerprint')) {
          throw Object.assign(
            new Error('column "plan_fingerprint" of relation "project_shots_rows" does not exist'),
            { code: '42703' },
          );
        }
        const [projectId, shotIds] = params;
        const scoped = (data.psr || []).filter((r) => r.project_id === undefined || r.project_id === projectId);
        // timelineExport's Q4 filters by shot intersection in SQL; projectExport reads
        // the whole project and intersects in memory. Emulate both signatures.
        if (Array.isArray(shotIds)) return { rows: scoped.filter((r) => shotIds.includes(r.shot_id)) };
        return { rows: scoped };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { exportProject } = createProjectExport({ pg });
  const { exportTimeline } = createTimelineExport({ pg });
  return { exportProject, exportTimeline, calls, data };
}

/** Delete every exportedAtMs key recursively (top meta AND nested timeline metas). */
function stripStamps(node) {
  if (Array.isArray(node)) return node.map(stripStamps);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'exportedAtMs') continue;
      out[k] = stripStamps(v);
    }
    return out;
  }
  return node;
}

test('G24-EXP: assembly — full bundle shape (meta/timelines/script content/storyboard plan)', async () => {
  const { exportProject } = makeHarness();
  const res = await exportProject({ projectId: 'p-1' });
  assert.equal(res.ok, true);
  const bundle = res.bundle;

  assert.equal(bundle.meta.projectId, 'p-1');
  assert.equal(bundle.meta.schemaVersion, 1);
  assert.equal(bundle.meta.projectName, '测试项目');
  assert.ok(Number.isInteger(bundle.meta.exportedAtMs) && bundle.meta.exportedAtMs > 0);

  // ── timelines: two entries, in project order ──
  assert.equal(bundle.timelines.length, 2);
  const t1 = bundle.timelines[0];
  assert.equal(t1.meta.projectId, 'p-1');
  assert.equal(t1.meta.timelineId, 'tl-1');
  assert.equal(t1.meta.schemaVersion, 1);
  assert.ok(Number.isInteger(t1.meta.exportedAtMs));
  assert.equal(t1.timeline.name, '主时间线');
  const [video, voice] = t1.timeline.tracks;
  assert.equal(video.id, 'tr-video');
  assert.equal(video.name, 'video'); // kind mirrors the missing 0034 name column
  assert.deepEqual(video.clips, [
    { id: 'cl-1', shotId: 's1:b1:k1', assetVersionId: 'av-100', orderIndex: 0, startMs: 0, durationMs: 3000, mimeType: 'video/mp4' },
    { id: 'cl-2', assetVersionId: 'av-200', orderIndex: 1, startMs: 3000, durationMs: 1500, mimeType: 'image/png' },
    { id: 'cl-3', shotId: 's2:b1:k1', orderIndex: 2, startMs: 4500, durationMs: 2000 },
  ]);
  assert.equal(voice.id, 'tr-voice');
  assert.deepEqual(voice.clips, []);

  // Per-timeline scriptRows = plan rows whose shot intersects this timeline's clips.
  assert.equal(t1.scriptRows.length, 2);
  assert.deepEqual(t1.scriptRows[0], {
    scriptId: 'scr-1', shotId: 's1:b1:k1', beatId: 'b1',
    sceneIndex: 0, beatIndex: 0, shotIndex: 0,
    kind: 'standard', intent: 'dialogue',
    subjectRefs: [{ entityType: 'character', entityId: 'ch-1', label: 'A' }],
    durationMs: 3000, ordering: 0, version: 2,
  });
  assert.equal(t1.scriptRows[1].shotId, 's2:b1:k1');
  assert.ok(!t1.scriptRows.some((r) => r.shotId === 'z9:x:y')); // old gen never bound

  // Empty timeline (no tracks) exported with tracks: [] and no scriptRows.
  const t2 = bundle.timelines[1];
  assert.equal(t2.timeline.name, '空时间线');
  assert.deepEqual(t2.timeline.tracks, []);
  assert.ok(!('scriptRows' in t2));

  // ── top-level script content facet (0039) ──
  assert.deepEqual(bundle.scriptRows, [
    { id: 'sr-1', sceneIndex: 0, rowIndex: 0, kind: 'dialogue', speaker: 'A', text: '你好', beat: 'b1', timingMs: 1000, continuityNotes: {} },
    { id: 'sr-2', sceneIndex: 0, rowIndex: 1, kind: 'action', text: '她转身离开。', continuityNotes: {} },
  ]);

  // ── top-level storyboard plan facet (0045+0054) ──
  assert.equal(bundle.storyboardPlan.version, 2); // max persisted generation
  assert.equal(bundle.storyboardPlan.fingerprint, 'fp-002'); // newest gen fingerprint
  assert.equal(bundle.storyboardPlan.rows.length, 3); // old-gen leftover included
  assert.deepEqual(bundle.storyboardPlan.rows[0], {
    scriptId: 'scr-1', shotId: 's1:b1:k1', beatId: 'b1',
    sceneIndex: 0, beatIndex: 0, shotIndex: 0,
    kind: 'standard', intent: 'dialogue',
    subjectRefs: [{ entityType: 'character', entityId: 'ch-1', label: 'A' }],
    durationMs: 3000, ordering: 0, version: 2,
  });
  assert.equal(bundle.storyboardPlan.rows[2].shotId, 'z9:x:y');
  assert.equal(bundle.storyboardPlan.rows[2].version, 1);
});

test('G24-EXP: BIGINT strings coerced to integer JS numbers everywhere', async () => {
  const { exportProject } = makeHarness();
  const { bundle } = await exportProject({ projectId: 'p-1' });

  for (const tl of bundle.timelines) {
    for (const track of tl.timeline.tracks) {
      for (const clip of track.clips) {
        for (const k of ['orderIndex', 'startMs', 'durationMs']) {
          assert.equal(typeof clip[k], 'number');
          assert.ok(Number.isInteger(clip[k]));
        }
      }
    }
    for (const r of tl.scriptRows || []) {
      assert.equal(typeof r.durationMs, 'number');
      for (const k of ['sceneIndex', 'beatIndex', 'shotIndex', 'ordering', 'version']) {
        assert.equal(typeof r[k], 'number');
        assert.ok(Number.isInteger(r[k]));
      }
    }
  }

  for (const r of bundle.scriptRows) {
    for (const k of ['sceneIndex', 'rowIndex']) {
      assert.equal(typeof r[k], 'number');
      assert.ok(Number.isInteger(r[k]));
    }
    if (r.timingMs !== undefined) {
      assert.equal(typeof r.timingMs, 'number');
      assert.ok(Number.isInteger(r.timingMs));
    }
  }

  assert.equal(typeof bundle.storyboardPlan.version, 'number');
  assert.ok(Number.isInteger(bundle.storyboardPlan.version));
  for (const r of bundle.storyboardPlan.rows) {
    assert.equal(typeof r.durationMs, 'number');
    assert.ok(Number.isInteger(r.durationMs));
  }
});

test('G24-EXP: empty project → meta-only bundle, no facet keys (空表缺省)', async () => {
  const d = baseData();
  d.timelines = [];
  d.scriptContent = [];
  d.psr = [];
  const { exportProject, calls } = makeHarness(d);
  const { ok, bundle } = await exportProject({ projectId: 'p-1' });
  assert.equal(ok, true);
  assert.equal(bundle.meta.projectName, '测试项目');
  assert.ok(!('timelines' in bundle)); // 无 timeline 不附 key
  assert.ok(!('scriptRows' in bundle));
  assert.ok(!('storyboardPlan' in bundle));
  // No-timeline project skips the track/clip queries entirely.
  assert.ok(calls.every((c) => /^\s*SELECT/i.test(c.sql.trim())));
});

test('G24-EXP: per-facet empty tables each omit their own key', async () => {
  // Project with script content but no timeline and no plan rows.
  const d = baseData();
  d.timelines = [];
  d.psr = [];
  const r1 = await makeHarness(d).exportProject({ projectId: 'p-1' });
  assert.equal(r1.ok, true);
  assert.ok(!('timelines' in r1.bundle));
  assert.ok(!('storyboardPlan' in r1.bundle));
  assert.equal(r1.bundle.scriptRows.length, 2);

  // Project with timeline + plan rows but no script content.
  const d2 = baseData();
  d2.scriptContent = [];
  const r2 = await makeHarness(d2).exportProject({ projectId: 'p-1' });
  assert.equal(r2.ok, true);
  assert.equal(r2.bundle.timelines.length, 2);
  assert.ok(!('scriptRows' in r2.bundle));
  assert.equal(r2.bundle.storyboardPlan.rows.length, 3);

  // Plan table present but empty → storyboardPlan omitted; timeline entries carry no
  // per-timeline scriptRows even though clips bind shots.
  const d3 = baseData();
  d3.psr = [];
  const r3 = await makeHarness(d3).exportProject({ projectId: 'p-1' });
  assert.equal(r3.ok, true);
  assert.ok(!('storyboardPlan' in r3.bundle));
  assert.ok(r3.bundle.timelines[0].timeline.tracks[0].clips.some((c) => c.shotId));
  assert.ok(!('scriptRows' in r3.bundle.timelines[0]));
});

test('G24-EXP: schema tolerance — script_rows table missing (42P01) → ok:false + scriptRows:null', async () => {
  const { exportProject } = makeHarness(baseData(), { missing: { script_rows: true } });
  const res = await exportProject({ projectId: 'p-1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /PROJECT_EXPORT_DEGRADED/);
  assert.match(res.error, /script_rows/);
  // Degraded snapshot still carries every readable facet; the absent facet is null.
  assert.equal(res.bundle.scriptRows, null);
  assert.equal(res.bundle.timelines.length, 2);
  assert.equal(res.bundle.storyboardPlan.rows.length, 3);
});

test('G24-EXP: schema tolerance — project_shots_rows table missing (42P01) → ok:false + storyboardPlan:null', async () => {
  const { exportProject } = makeHarness(baseData(), { missing: { project_shots_rows: true } });
  const res = await exportProject({ projectId: 'p-1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /PROJECT_EXPORT_DEGRADED/);
  assert.match(res.error, /project_shots_rows/);
  assert.equal(res.bundle.storyboardPlan, null);
  assert.equal(res.bundle.scriptRows.length, 2); // content facet untouched
  // Per-timeline scriptRows are a projection of the missing plan table → omitted,
  // the timeline bundles themselves stay intact.
  assert.equal(res.bundle.timelines.length, 2);
  assert.equal(res.bundle.timelines[0].timeline.tracks.length, 2);
  assert.ok(!('scriptRows' in res.bundle.timelines[0]));
});

test('G24-EXP: schema tolerance — both plan+script tables missing → ok:false, both facets null', async () => {
  const { exportProject } = makeHarness(baseData(), {
    missing: { script_rows: true, project_shots_rows: true },
  });
  const res = await exportProject({ projectId: 'p-1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /PROJECT_EXPORT_DEGRADED/);
  assert.equal(res.bundle.scriptRows, null);
  assert.equal(res.bundle.storyboardPlan, null);
  assert.equal(res.bundle.timelines.length, 2);
});

test('G24-EXP: schema tolerance — pre-0054 (plan_fingerprint column missing) degrades to base columns, ok stays true', async () => {
  const { exportProject } = makeHarness(baseData(), { missingFingerprintCol: true });
  const res = await exportProject({ projectId: 'p-1' });
  assert.equal(res.ok, true); // rows intact, only the optional fingerprint is dropped
  assert.equal(res.bundle.storyboardPlan.version, 2);
  assert.ok(!('fingerprint' in res.bundle.storyboardPlan));
  assert.equal(res.bundle.storyboardPlan.rows.length, 3);
  // Per-timeline bindings are column-independent → unaffected.
  assert.equal(res.bundle.timelines[0].scriptRows.length, 2);
});

test('G24-EXP: determinism — two exports deep-equal after ignoring every exportedAtMs', async () => {
  const { exportProject } = makeHarness();
  const a = (await exportProject({ projectId: 'p-1' })).bundle;
  const b = (await exportProject({ projectId: 'p-1' })).bundle;
  assert.ok(Number.isInteger(a.meta.exportedAtMs) && Number.isInteger(b.meta.exportedAtMs));
  // One stamp is shared by the top meta and all nested timeline metas.
  assert.equal(a.timelines[0].meta.exportedAtMs, a.meta.exportedAtMs);
  assert.deepEqual(stripStamps(a), stripStamps(b));
  assert.equal(JSON.stringify(stripStamps(a)), JSON.stringify(stripStamps(b)));
});

test('G24-EXP: per-timeline entry is shape-identical to the real timelineExport bundle', async () => {
  // The SAME fake pg serves both modules over the same fixture data.
  const { exportProject, exportTimeline } = makeHarness();
  const project = await exportProject({ projectId: 'p-1' });
  assert.equal(project.ok, true);
  const perTimeline = await exportTimeline({ projectId: 'p-1', timelineId: 'tl-1' });
  assert.equal(perTimeline.ok, true);
  assert.deepEqual(
    stripStamps(project.bundle.timelines[0]),
    stripStamps(perTimeline.bundle),
  );
});

test('G24-EXP: 404 / validation — unknown project, missing projectId', async () => {
  const { exportProject } = makeHarness();
  const ghost = await exportProject({ projectId: 'p-ghost' });
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /项目不存在/);
  assert.equal(ghost.bundle, undefined);

  const noId = await exportProject({});
  assert.equal(noId.ok, false);
  assert.match(noId.error, /projectId/);
});

test('G24-EXP: pure read — SELECT-only and ≤8 queries in every scenario', async () => {
  // Full project: Q1..Q6.
  const h1 = makeHarness();
  await h1.exportProject({ projectId: 'p-1' });
  assert.equal(h1.calls.length, 6);

  // No-timeline project skips tracks/clips: Q1 Q2 Q5 Q6.
  const d = baseData();
  d.timelines = [];
  const h2 = makeHarness(d);
  await h2.exportProject({ projectId: 'p-1' });
  assert.equal(h2.calls.length, 4);

  // project_shots_rows missing: Q1..Q4 + Q5 + throwing Q6.
  const h3 = makeHarness(baseData(), { missing: { project_shots_rows: true } });
  await h3.exportProject({ projectId: 'p-1' });
  assert.equal(h3.calls.length, 6);

  // Pre-0054 column retry adds exactly one query (Q6b).
  const h4 = makeHarness(baseData(), { missingFingerprintCol: true });
  await h4.exportProject({ projectId: 'p-1' });
  assert.equal(h4.calls.length, 7);

  for (const h of [h1, h2, h3, h4]) {
    assert.ok(h.calls.length <= 8);
    for (const c of h.calls) assert.ok(/^\s*SELECT/i.test(c.sql.trim()));
  }
});

test('G24-EXP: BIGINT > 2^53 rejected → ok:false PROJECT_EXPORT_ERROR (no silent rounding)', async () => {
  const d = baseData();
  d.clips[0] = { ...d.clips[0], start_ms: '9007199254740993' }; // 2^53 + 1 → rounds
  const { exportProject } = makeHarness(d);
  const res = await exportProject({ projectId: 'p-1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /PROJECT_EXPORT_ERROR/);
  assert.match(res.error, /超出安全整数范围/);
});
