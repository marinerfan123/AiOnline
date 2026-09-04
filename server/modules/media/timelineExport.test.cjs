'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimelineExport } = require('./timelineExport.cjs');

/**
 * G24 — timelineExport bundle tests.
 * Fake pg routes the module's SELECTs by signature and returns joined rows
 * (Q3 mimeType join resolved in the fixture). BIGINT ms are handed back as
 * strings — exactly what node-postgres does for int8 — so the tests prove the
 * assembly coerces to integer JS numbers.
 */

function baseData() {
  return {
    timelines: [{ id: 'tl-1', project_id: 'p-1', name: '主时间线' }],
    tracks: [
      { id: 'tr-video', timeline_id: 'tl-1', kind: 'video', order_index: 0 },
      { id: 'tr-voice', timeline_id: 'tl-1', kind: 'voice', order_index: 1 },
    ],
    clips: [
      // Q3 rows are pre-joined: mime_type already resolved via asset_versions→media.
      { id: 'cl-1', track_id: 'tr-video', shot_id: 's1:b1:k1', asset_version_id: 'av-100', order_index: '0', start_ms: '0', duration_ms: '3000', mime_type: 'video/mp4' },
      { id: 'cl-2', track_id: 'tr-video', shot_id: null, asset_version_id: 'av-200', order_index: '1', start_ms: '3000', duration_ms: '1500', mime_type: 'image/png' },
      { id: 'cl-3', track_id: 'tr-video', shot_id: 's2:b1:k1', asset_version_id: null, order_index: '2', start_ms: '4500', duration_ms: '2000', mime_type: null },
    ],
    psr: [
      { script_id: 'scr-1', shot_id: 's1:b1:k1', beat_id: 'b1', scene_index: '0', beat_index: '0', shot_index: '0', kind: 'standard', intent: 'dialogue', subject_refs: [{ entityType: 'character', entityId: 'ch-1', label: 'A' }], duration_ms: '3000', ordering: '0', version: '1' },
      { script_id: 'scr-1', shot_id: 's2:b1:k1', beat_id: 'b1', scene_index: '1', beat_index: '0', shot_index: '0', kind: 'standard', intent: 'action', subject_refs: [], duration_ms: '2000', ordering: '1', version: '1' },
      // Unrelated shot — must NOT leak into the export.
      { script_id: 'scr-1', shot_id: 'z9:x:y', beat_id: 'b9', scene_index: '9', beat_index: '0', shot_index: '0', kind: 'standard', intent: 'action', subject_refs: [], duration_ms: '9999', ordering: '9', version: '1' },
    ],
  };
}

function makeHarness(data = baseData()) {
  const calls = [];
  const pg = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('JOIN projects p ON p.id = t.project_id')) {
        return { rows: data.timelines.filter((t) => t.id === params[0] && t.project_id === params[1]) };
      }
      if (sql.includes('FROM timeline_tracks') && sql.includes('ORDER BY order_index, id')) {
        return { rows: data.tracks.filter((t) => t.timeline_id === params[0]) };
      }
      if (sql.includes('FROM timeline_clips c')) {
        const trackIds = params[0] || [];
        return { rows: data.clips.filter((c) => trackIds.includes(c.track_id)) };
      }
      if (sql.includes('FROM project_shots_rows')) {
        const [projectId, shotIds] = params;
        return { rows: data.psr.filter((r) => r.project_id === undefined || r.project_id === projectId).filter((r) => shotIds.includes(r.shot_id)) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { exportTimeline } = createTimelineExport({ pg });
  return { exportTimeline, calls, data };
}

const stripStamp = (bundle) => {
  const c = JSON.parse(JSON.stringify(bundle));
  delete c.meta.exportedAtMs;
  return c;
};

test('G24: export shape — meta/timeline/tracks/clips assembled, nil optionals omitted', async () => {
  const { exportTimeline } = makeHarness();
  const { ok, bundle } = await exportTimeline({ projectId: 'p-1', timelineId: 'tl-1' });
  assert.equal(ok, true);

  assert.equal(bundle.meta.projectId, 'p-1');
  assert.equal(bundle.meta.timelineId, 'tl-1');
  assert.equal(bundle.meta.schemaVersion, 1);
  assert.ok(Number.isInteger(bundle.meta.exportedAtMs) && bundle.meta.exportedAtMs > 0);
  assert.equal(bundle.timeline.name, '主时间线');
  assert.equal(bundle.timeline.tracks.length, 2);

  const [video, voice] = bundle.timeline.tracks;
  assert.equal(video.id, 'tr-video');
  assert.equal(video.name, 'video'); // 0034 has no track name col — kind is the stable label
  assert.equal(video.clips.length, 3);

  const [c1, c2, c3] = video.clips;
  // Both bindings + resolved mime (asset_versions→media).
  assert.deepEqual(c1, { id: 'cl-1', shotId: 's1:b1:k1', assetVersionId: 'av-100', orderIndex: 0, startMs: 0, durationMs: 3000, mimeType: 'video/mp4' });
  // No shotId → key omitted.
  assert.deepEqual(c2, { id: 'cl-2', assetVersionId: 'av-200', orderIndex: 1, startMs: 3000, durationMs: 1500, mimeType: 'image/png' });
  assert.ok(!('shotId' in c2));
  // No asset version → assetVersionId AND mimeType omitted.
  assert.deepEqual(c3, { id: 'cl-3', shotId: 's2:b1:k1', orderIndex: 2, startMs: 4500, durationMs: 2000 });
  assert.ok(!('assetVersionId' in c3) && !('mimeType' in c3));

  // Track order preserved; track 2 kept with empty clips.
  assert.equal(voice.id, 'tr-voice');
  assert.equal(voice.name, 'voice');
  assert.deepEqual(voice.clips, []);

  // scriptRows: only the two timeline-bound shots, in psr ordering, foreign shot excluded.
  assert.equal(bundle.scriptRows.length, 2);
  assert.deepEqual(bundle.scriptRows[0], {
    scriptId: 'scr-1', shotId: 's1:b1:k1', beatId: 'b1',
    sceneIndex: 0, beatIndex: 0, shotIndex: 0,
    kind: 'standard', intent: 'dialogue',
    subjectRefs: [{ entityType: 'character', entityId: 'ch-1', label: 'A' }],
    durationMs: 3000, ordering: 0, version: 1,
  });
  assert.equal(bundle.scriptRows[1].shotId, 's2:b1:k1');
  assert.ok(!bundle.scriptRows.some((r) => r.shotId === 'z9:x:y'));
});

test('G24: BIGINT strings coerced to integer JS numbers (no float ms)', async () => {
  const { exportTimeline } = makeHarness();
  const { bundle } = await exportTimeline({ projectId: 'p-1', timelineId: 'tl-1' });
  for (const track of bundle.timeline.tracks) {
    for (const clip of track.clips) {
      assert.equal(typeof clip.startMs, 'number');
      assert.equal(typeof clip.durationMs, 'number');
      assert.equal(typeof clip.orderIndex, 'number');
      assert.ok(Number.isInteger(clip.startMs) && clip.startMs >= 0);
      assert.ok(Number.isInteger(clip.durationMs));
    }
  }
  for (const r of bundle.scriptRows) {
    assert.equal(typeof r.durationMs, 'number');
    assert.ok(Number.isInteger(r.durationMs));
    for (const k of ['sceneIndex', 'beatIndex', 'shotIndex', 'ordering', 'version']) {
      assert.equal(typeof r[k], 'number');
      assert.ok(Number.isInteger(r[k]));
    }
  }
});

test('G24: empty track exported as clips:[]; empty timeline → tracks:[] and no scriptRows', async () => {
  const d = baseData();
  d.clips = [];
  const { exportTimeline } = makeHarness(d);
  const { bundle } = await exportTimeline({ projectId: 'p-1', timelineId: 'tl-1' });
  assert.equal(bundle.timeline.tracks.length, 2);
  assert.deepEqual(bundle.timeline.tracks[0].clips, []);
  assert.deepEqual(bundle.timeline.tracks[1].clips, []);
  assert.ok(!('scriptRows' in bundle)); // no clip shots → no binding → key omitted

  const d2 = baseData();
  d2.tracks = [];
  d2.clips = [];
  const { exportTimeline: ex2 } = makeHarness(d2);
  const b2 = (await ex2({ projectId: 'p-1', timelineId: 'tl-1' })).bundle;
  assert.deepEqual(b2.timeline.tracks, []);
  assert.ok(!('scriptRows' in b2));
});

test('G24: 404 — timeline unknown or belonging to another project', async () => {
  const { exportTimeline } = makeHarness();
  const ghost = await exportTimeline({ projectId: 'p-1', timelineId: 'tl-ghost' });
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /不存在或不属于/);

  // Same id exists in the DB but under project p-9 — must still be 404 for p-1.
  const d = baseData();
  d.timelines.push({ id: 'tl-9', project_id: 'p-9', name: '别家时间线' });
  const { exportTimeline: ex2 } = makeHarness(d);
  const foreign = await ex2({ projectId: 'p-1', timelineId: 'tl-9' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /不存在或不属于/);

  // Foreign export must not surface another project's script rows.
  assert.equal(foreign.bundle, undefined);
});

test('G24: validation — missing projectId/timelineId → ok:false', async () => {
  const { exportTimeline } = makeHarness();
  const a = await exportTimeline({ timelineId: 'tl-1' });
  assert.equal(a.ok, false);
  assert.match(a.error, /projectId/);
  const b = await exportTimeline({ projectId: 'p-1' });
  assert.equal(b.ok, false);
  assert.match(b.error, /timelineId/);
});

test('G24: determinism — two exports of identical data are deep-equal (ignoring meta.exportedAtMs)', async () => {
  const { exportTimeline } = makeHarness();
  const a = (await exportTimeline({ projectId: 'p-1', timelineId: 'tl-1' })).bundle;
  const b = (await exportTimeline({ projectId: 'p-1', timelineId: 'tl-1' })).bundle;
  // exportedAtMs is a live Date.now() stamp (may even coincide within one ms)…
  assert.ok(Number.isInteger(a.meta.exportedAtMs) && Number.isInteger(b.meta.exportedAtMs));
  assert.deepEqual(stripStamp(a), stripStamp(b));            // …everything else identical
  assert.deepEqual(JSON.stringify(stripStamp(a)), JSON.stringify(stripStamp(b)));
});

test('G24: scriptRows omitted when no clip shot intersects project_shots_rows', async () => {
  const d = baseData();
  d.psr = []; // no script-bound rows exist
  const { exportTimeline } = makeHarness(d);
  const { bundle } = await exportTimeline({ projectId: 'p-1', timelineId: 'tl-1' });
  // Clips still carry shotIds, but nothing is bound in the script layer → no key.
  assert.ok(bundle.timeline.tracks[0].clips.some((c) => c.shotId));
  assert.ok(!('scriptRows' in bundle));
});

test('G24: pure read — SELECT only, exactly 4 queries (3 without shot bindings)', async () => {
  const { exportTimeline, calls } = makeHarness();
  await exportTimeline({ projectId: 'p-1', timelineId: 'tl-1' });
  assert.equal(calls.length, 4); // timeline + tracks + clips + psr
  for (const c of calls) assert.ok(/^\s*SELECT/i.test(c.sql.trim()));

  const d = baseData();
  d.clips = d.clips.filter((c) => c.shot_id === null); // no shot ids → psr query skipped
  const { exportTimeline: ex2, calls: calls2 } = makeHarness(d);
  await ex2({ projectId: 'p-1', timelineId: 'tl-1' });
  assert.equal(calls2.length, 3);
  for (const c of calls2) assert.ok(/^\s*SELECT/i.test(c.sql.trim()));
});
