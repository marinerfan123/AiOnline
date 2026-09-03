'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScriptApi } = require('./scriptApi.cjs');

function makeHarness({ memberFor = ['p-1'], role = 'editor', characters = [], locations = [] } = {}) {
  const state = { rows: [], nextIndex: 0, deleted: 0, shots: [] };
  const sendJSON = async (res, status, body) => { res.status = status; res.body = body; };
  const pg = {
    async query(sql, params = []) {
      if (/INSERT INTO script_rows/.test(sql)) {
        state.rows.push({ id: params[0], project_id: params[1], scene_index: params[3], row_index: params[4], kind: params[5], text: params[7], continuity_notes: params[10] });
        return { rows: [] };
      }
      if (/DELETE FROM script_rows/.test(sql)) { state.deleted++; return { rowCount: 1 }; }
      if (/UPDATE script_rows SET row_index/.test(sql)) { const r = state.rows.find((x) => x.id === params[1]); if (r) r.row_index = params[0]; return { rows: [] }; }
      if (/UPDATE script_rows SET /.test(sql) && !/row_index/.test(sql)) { const r = state.rows.find((x) => x.id === params[0]); if (r) Object.assign(r, { text: params[3] !== undefined ? params[3] : r.text }); return { rows: [{ id: params[0] }] }; }
      if (/FROM projects p JOIN workspaces/.test(sql)) {
        if (!['p-1'].includes(params[0])) return { rows: [] };
        return { rows: [{ id: params[0], workspace_id: 'w-1', name: 'P' }] };
      }
      if (/FROM workspace_members/.test(sql)) {
        return { rows: memberFor.includes('p-1') && params[1] === 'u-1' ? [{ role }] : [] };
      }
      if (/COALESCE\(MAX\(row_index\)/.test(sql)) return { rows: [{ m: state.rows.filter((r) => r.scene_index === params[1]).length - 1 }] };
      if (/FROM script_rows WHERE id/.test(sql)) {
        const r = state.rows.find((x) => x.id === params[0] && x.project_id === params[1]);
        return { rows: r ? [r] : [] };
      }
      if (/FROM project_characters/.test(sql)) return { rows: characters };
      if (/FROM project_environments/.test(sql)) return { rows: locations };
      // ── persistStoryboardShots (POST …/storyboard/apply) emulation ──
      if (/INSERT INTO project_shots_rows/.test(sql)) {
        state.shots.push({
          project_id: params[0], script_id: params[1], shot_id: params[2],
          beat_id: params[3], scene_index: params[4], beat_index: params[5],
          shot_index: params[6], kind: params[7], intent: params[8],
          subject_refs: JSON.parse(params[9]), duration_ms: params[10],
          ordering: params[11], version: params[12],
        });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT 1 AS ok FROM projects WHERE id = \$1/.test(sql)) {
        return { rows: ['p-1'].includes(params[0]) ? [{ ok: 1 }] : [] };
      }
      if (/SELECT id FROM script_rows WHERE project_id = \$1 AND id = ANY/.test(sql)) {
        const owned = state.rows.filter((r) => r.project_id === params[0]);
        const hit = new Set(owned.map((r) => String(r.id)));
        return { rows: (params[1] || []).filter((id) => hit.has(String(id))).map((id) => ({ id })) };
      }
      if (/COALESCE\(MAX\(version\)/.test(sql)) {
        const v = state.shots
          .filter((s) => s.script_id === params[0] && s.project_id === params[1])
          .reduce((m, s) => Math.max(m, s.version), 0);
        return { rows: [{ v }] };
      }
      if (/DELETE FROM project_shots_rows/.test(sql)) {
        const before = state.shots.length;
        state.shots = state.shots.filter((s) => !(s.script_id === params[0] && s.project_id === params[1]));
        return { rowCount: before - state.shots.length };
      }
      if (/FROM script_rows/.test(sql)) {
        const sc = params.length > 1 ? params[1] : null;
        return { rows: state.rows.filter((r) => (sc === null ? true : r.scene_index === sc)) };
      }
      return { rows: [] };
    },
  };
  const api = createScriptApi({
    pg, sessionUser: () => ({ id: 'u-1' }), sendJSON,
    parseBody: async (req) => req._body,
  });
  return { api, state };
}

const h = (body, params = {}) => ({ _body: body, params });
const call = (api, method, body, path, pid = 'p-1') => {
  const res = {};
  return api.handle(h(body, { projectId: pid }), res, path, method).then(() => res);
};

test('G13: batch insert validated rows → 201 with inserted rows', async () => {
  const { api, state } = makeHarness();
  const res = await call(api, 'POST', {
    rows: [
      { kind: 'dialogue', speaker: 'LUO', text: '出发。', scene_index: 1 },
      { kind: 'action', text: '他走进门。', scene_index: 1 },
    ],
  }, '/api/v2/script/rows');
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted.length, 2);
  assert.equal(state.rows.length, 2);
  assert.ok(state.rows[0].id.startsWith('sr-'));
});

test('G13: invalid rows rejected individually (207 partial, errors listed)', async () => {
  const { api, state } = makeHarness();
  const res = await call(api, 'POST', {
    rows: [
      { kind: 'singing', text: 'x' },
      { kind: 'dialogue', text: 'no speaker' },
      { kind: 'action', text: 'ok' },
    ],
  }, '/api/v2/script/rows');
  assert.equal(res.status, 207);
  assert.equal(res.body.inserted.length, 1);
  assert.equal(res.body.errors.length, 2);
});

test('G13: non-member → 403; missing project → 400', async () => {
  const { api } = makeHarness({ memberFor: [] });
  const res = await call(api, 'POST', { rows: [{ kind: 'action', text: 'x' }] }, '/api/v2/script/rows', 'p-1');
  assert.equal(res.status, 403);
  const res2 = await call(api, 'POST', { rows: [{ kind: 'action', text: 'x' }] }, '/api/v2/script/rows', 'ghost');
  assert.equal(res2.status, 404);
});

test('G13: GET rows grouped by scene', async () => {
  const { api, state } = makeHarness();
  state.rows.push({ id: 'sr-1', project_id: 'p-1', scene_index: 1, row_index: 0, kind: 'action', text: 'a' });
  state.rows.push({ id: 'sr-2', project_id: 'p-1', scene_index: 0, row_index: 0, kind: 'action', text: 'b' });
  const res = await call(api, 'GET', {}, '/api/v2/script/rows');
  assert.equal(res.status, 200);
  assert.equal(res.body.scenes.length, 2);
  assert.equal(res.body.scenes[0].sceneIndex, 0);
});

test('G13: GET single + 404 for foreign', async () => {
  const { api, state } = makeHarness();
  state.rows.push({ id: 'sr-9', project_id: 'p-1', scene_index: 0, row_index: 0, kind: 'action', text: 'x' });
  const ok = await call(api, 'GET', {}, '/api/v2/script/rows/sr-9');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.row.id, 'sr-9');
  const miss = await call(api, 'GET', {}, '/api/v2/script/rows/sr-nope');
  assert.equal(miss.status, 404);
});

test('G13: PATCH revalidates merged row (bad kind → 400)', async () => {
  const { api, state } = makeHarness();
  state.rows.push({ id: 'sr-1', project_id: 'p-1', scene_index: 0, row_index: 0, kind: 'dialogue', speaker: 'LUO', text: 'x' });
  const bad = await call(api, 'PATCH', { kind: 'weird' }, '/api/v2/script/rows/sr-1');
  assert.equal(bad.status, 400);
  const good = await call(api, 'PATCH', { text: '改好了。' }, '/api/v2/script/rows/sr-1');
  assert.equal(good.status, 200);
});

test('G13: DELETE row', async () => {
  const { api, state } = makeHarness();
  const res = await call(api, 'DELETE', {}, '/api/v2/script/rows/sr-5');
  assert.equal(res.status, 200);
  assert.equal(state.deleted, 1);
});

test('G13: PUT order reindexes scene rows', async () => {
  const { api, state } = makeHarness();
  state.rows.push({ id: 'sr-1', project_id: 'p-1', scene_index: 2, row_index: 0 }, { id: 'sr-2', project_id: 'p-1', scene_index: 2, row_index: 1 });
  const res = await call(api, 'PUT', { sceneIndex: 2, rowIds: ['sr-2', 'sr-1'] }, '/api/v2/script/order');
  assert.equal(res.status, 200);
  assert.equal(state.rows.find((x) => x.id === 'sr-2').row_index, 0);
  assert.equal(state.rows.find((x) => x.id === 'sr-1').row_index, 1);
});

test('G13: non-script route → false', async () => {
  const { api } = makeHarness();
  const res = {};
  const handled = await api.handle(h({}, { projectId: 'p-1' }), res, '/api/v2/bible/characters', 'GET');
  assert.equal(handled, false);
});

test('G13: viewer role cannot write (403) — audit M1 fix', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1', name: 'P' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: [{ role: 'viewer' }] };
      return { rows: [] };
    },
  };
  const api = createScriptApi({ pg, sessionUser: () => ({ id: 'u-1' }), sendJSON: (res, code, body) => responses.push({ code, body }), parseBody: async () => ({ rows: [{ kind: 'action', text: 'x' }] }) });
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, {}, '/api/v2/script/rows', 'POST');
  assert.equal(responses[0].code, 403);
});

test('G13: viewer role cannot PATCH script rows (403) — audit LOW ②', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1', name: 'P' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: [{ role: 'viewer' }] };
      return { rows: [] };
    },
  };
  const api = createScriptApi({ pg, sessionUser: () => ({ id: 'u-1' }), sendJSON: (res, code, body) => responses.push({ code, body }), parseBody: async () => ({ text: 'x' }) });
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, {}, '/api/v2/script/rows/sr-1', 'PATCH');
  assert.equal(responses[0].code, 403);
});

test('G13: continuity_notes JSON string single-encoded on POST (no double encoding, LOW ④)', async () => {
  const { api, state } = makeHarness();
  const res = await call(api, 'POST', {
    rows: [
      { kind: 'action', text: 'x', continuity_notes: '{"lock":true}' },
      { kind: 'action', text: 'y', continuity_notes: { lock: true } },
    ],
  }, '/api/v2/script/rows');
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted.length, 2);
  // Both the pre-encoded JSON string and the object must land as the same
  // single-encoded JSON — NOT the double-encoded '"{\"lock\":true}"'.
  assert.equal(state.rows[0].continuity_notes, '{"lock":true}');
  assert.equal(state.rows[1].continuity_notes, '{"lock":true}');
});

test('G13: continuity_notes normalized on PATCH (JSON string → object, LOW ④)', async () => {
  let updateParams = null;
  const pg = {
    async query(sql, params = []) {
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1', name: 'P' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: [{ role: 'editor' }] };
      if (/FROM script_rows WHERE id/.test(sql)) return { rows: [{ id: 'sr-1', project_id: 'p-1', kind: 'action', text: 'x', scene_index: 0, row_index: 0 }] };
      if (/UPDATE script_rows SET /.test(sql)) { updateParams = params; return { rows: [{ id: 'sr-1' }] }; }
      return { rows: [] };
    },
  };
  const api = createScriptApi({
    pg, sessionUser: () => ({ id: 'u-1' }),
    sendJSON: (res, c) => { res.status = c; },
    parseBody: async () => ({ continuity_notes: '{"lock":true}' }),
  });
  const res = {};
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, res, '/api/v2/script/rows/sr-1', 'PATCH');
  assert.equal(res.status, 200);
  // UPDATE params = [id, projectId, ...vals] → $3 is the normalized continuity_notes.
  // After normalization the pre-encoded string must be an object, not a string.
  assert.deepEqual(updateParams[2], { lock: true });
});

// ── G13 推进③ — GET storyboard plan view ────────────────────────────────
// Row shorthand with full model columns (what the SELECT * read returns).
const seedRow = (id, over = {}) => ({
  id, project_id: 'p-1', episode_id: null, scene_index: 0, row_index: 0,
  kind: 'action', speaker: null, text: 'x', beat: null, timing_ms: null,
  ...over,
});

const callParams = (api, method, path, params) => {
  const res = {};
  return api.handle(h({}, params), res, path, method).then(() => res);
};

test('G13: GET storyboard plan view (path form) → 200 with plan {beats,totalShots}', async () => {
  const { api, state } = makeHarness();
  state.rows.push(
    seedRow('sr-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'A enters.', timing_ms: '5000' }),
    seedRow('sr-b', { scene_index: 0, row_index: 1, kind: 'dialogue', speaker: 'LUO', text: '出发。' }),
    seedRow('sr-c', { scene_index: 0, row_index: 2, kind: 'dialogue', speaker: 'MEI', text: '跟上。' }),
    seedRow('sr-d', { scene_index: 1, row_index: 0, kind: 'action', text: 'Car chase.' }),
  );
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(Object.keys(res.body.plan).sort(), ['beats', 'totalShots']);
  const { beats, totalShots } = res.body.plan;
  assert.equal(beats.length, 2); // s0: one content beat (3 rows ≤ 4) + s1: one beat
  assert.equal(beats[0].beatId, 's0:b0');
  assert.deepEqual(beats[0].scriptRowIds, ['sr-a', 'sr-b', 'sr-c']);
  assert.equal(beats[1].beatId, 's1:b0');
  assert.deepEqual(beats[1].scriptRowIds, ['sr-d']);
  assert.equal(totalShots, beats.reduce((n, b) => n + b.shots.length, 0)); // 2+2
  // every shot carries the deterministic defaults
  for (const beat of beats) {
    for (const shot of beat.shots) {
      assert.ok(shot.shotId.startsWith(`${beat.beatId}:k`));
      assert.equal(shot.camera.shotSize, 'medium');
      assert.equal(shot.durationMs, 3000);
      assert.ok(Array.isArray(shot.subjectRefs));
    }
  }
});

test('G13: GET storyboard query form (?scriptId=) works and missing scriptId → 400', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'Door opens.' }));
  const ok = await callParams(api, 'GET', '/api/v2/script/storyboard', { projectId: 'p-1', scriptId: 'q-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.plan.beats.length, 1);
  assert.equal(ok.body.plan.totalShots, 2);
  const miss = await callParams(api, 'GET', '/api/v2/script/storyboard', { projectId: 'p-1' });
  assert.equal(miss.status, 400);
  assert.ok(miss.body.error.includes('scriptId'));
});

test('G13: GET storyboard subjectRefs resolve via project characters then locations (row-internal + bible tables)', async () => {
  const { api, state } = makeHarness({
    characters: [{ id: 'c-1', name: 'LUO' }],
    locations: [{ id: 'l-1', name: 'CASTLE' }],
  });
  state.rows.push(
    seedRow('sr-1', { kind: 'dialogue', speaker: 'LUO', text: '进来。' }),
    seedRow('sr-2', { kind: 'dialogue', speaker: 'CASTLE', text: '城堡回应。' }),
  );
  const res = await callParams(api, 'GET', '/api/v2/script/s-main/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  const beat = res.body.plan.beats[0];
  assert.deepEqual(beat.shots[0].subjectRefs, [{ entityType: 'character', entityId: 'c-1', label: 'LUO' }]);
  assert.deepEqual(beat.shots[1].subjectRefs, [{ entityType: 'location', entityId: 'l-1', label: 'CASTLE' }]);
});

test('G13: GET storyboard subjectRefs empty when no character/location matches (never invented)', async () => {
  const { api, state } = makeHarness(); // no characters/locations seeded
  state.rows.push(seedRow('sr-1', { kind: 'dialogue', speaker: 'STRANGER', text: '谁？' }));
  const res = await callParams(api, 'GET', '/api/v2/script/s-main/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.plan.beats[0].shots[0].subjectRefs, []);
  assert.deepEqual(res.body.plan.beats[0].shots[1].subjectRefs, []);
});

test('G13: GET storyboard with zero script rows → 400 (plan needs ≥ 1 row, locked)', async () => {
  const { api } = makeHarness();
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('至少 1 行'));
});

test('G13: GET storyboard cross-project / unknown project → 404 (project-bound ownership)', async () => {
  const { api } = makeHarness();
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'ghost' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, '项目不存在');
});

test('G13: GET storyboard non-member → 403 (same requireProject gate as rows)', async () => {
  const { api } = makeHarness({ memberFor: [] });
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, '无项目权限');
});

test('G13: GET storyboard viewer role may read — same permission as GET rows', async () => {
  const { api, state } = makeHarness({ role: 'viewer' });
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'Pan across.' }));
  const sb = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(sb.status, 200);
  assert.equal(sb.body.ok, true);
  // parity: the same viewer can read GET /rows
  const rows = await callParams(api, 'GET', '/api/v2/script/rows', { projectId: 'p-1' });
  assert.equal(rows.status, 200);
  // …but still cannot write (403)
  const blocked = await call(api, 'POST', { rows: [{ kind: 'action', text: 'x' }] }, '/api/v2/script/rows', 'p-1');
  assert.equal(blocked.status, 403);
});

test('G13: GET storyboard unauthenticated → 401', async () => {
  const res = {};
  const anon = createScriptApi({
    pg: { query: async () => ({ rows: [] }) }, sessionUser: () => null,
    sendJSON: (r, code, body) => { r.status = code; r.body = body; },
    parseBody: async () => ({}),
  });
  await anon.handle({ params: { projectId: 'p-1' } }, res, '/api/v2/script/s-1/storyboard', 'GET');
  assert.equal(res.status, 401);
});

test('G13: storyboard route is GET-only in this leaf; POST falls through (false)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const res = {};
  const handled = await api.handle(h({}, { projectId: 'p-1' }), res, '/api/v2/script/s-1/storyboard', 'POST');
  assert.equal(handled, false);
  assert.equal(res.status, undefined);
});

test('G13: stored dialogue row without speaker → plan view 400 with model errors (no silent plan)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-bad', { kind: 'dialogue', speaker: null, text: 'orphan line' }));
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.ok(res.body.errors.some((e) => e.includes('speaker')));
});

test('G13: /rows/storyboard prefix stays a rows single-GET (reserved), not a plan view', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const res = await callParams(api, 'GET', '/api/v2/script/rows/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 404); // no row with id 'storyboard'
  assert.equal(res.body.error, 'row 不存在');
});

// ── G13 推进④ — POST …/storyboard/apply (server-computed plan persist) ──
test('G13: POST storyboard/apply (path form) → 200 applied {version:1, shotCount, replaced:0}', async () => {
  const { api, state } = makeHarness();
  state.rows.push(
    seedRow('sr-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'Door opens.' }),
    seedRow('sr-b', { scene_index: 0, row_index: 1, kind: 'dialogue', speaker: 'LUO', text: '出发。' }),
  );
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // 2 rows (≤4) = 1 content beat → 2 default shots
  assert.deepEqual(res.body.applied, { version: 1, shotCount: 2, replaced: 0 });
  assert.equal(state.shots.length, 2);
  assert.ok(state.shots.every((s) => s.version === 1 && s.script_id === 's-1' && s.project_id === 'p-1'));
  assert.deepEqual(new Set(state.shots.map((s) => s.shot_id)), new Set(['s0:b0:k0', 's0:b0:k1']));
});

test('G13: repeat apply bumps version +1 and atomically replaces the old shot set', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-a', { kind: 'action', text: 'Door opens.' }));
  const first = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.applied, { version: 1, shotCount: 2, replaced: 0 });
  const second = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.applied, { version: 2, shotCount: 2, replaced: 2 });
  assert.equal(state.shots.length, 2); // final set == this plan only (no residue)
  assert.ok(state.shots.every((s) => s.version === 2));
  const third = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(third.status, 200);
  assert.deepEqual(third.body.applied, { version: 3, shotCount: 2, replaced: 2 });
});

test('G13: apply recomputes the plan server-side — a forged request body is ignored (anti-forgery)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'dialogue', speaker: 'LUO', text: '进来。' }));
  // Client-supplied plan claims evil ids/beat/duration — must have zero effect.
  const forged = {
    plan: {
      beats: [{
        beatId: 'evil:b0', sceneIndex: 9, beatIndex: 0, scriptRowIds: ['sr-1'],
        shots: [{ shotId: 'evil:k0', beatId: 'evil:b0', shotIndex: 0, intent: 'dialogue', subjectRefs: [], durationMs: 999 }],
      }],
    },
  };
  const res = await call(api, 'POST', forged, '/api/v2/script/s-1/storyboard/apply', 'p-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.applied, { version: 1, shotCount: 2, replaced: 0 });
  // Persisted rows are the deterministic server plan, not the forged body.
  assert.deepEqual(new Set(state.shots.map((s) => s.shot_id)), new Set(['s0:b0:k0', 's0:b0:k1']));
  assert.ok(state.shots.every((s) => s.duration_ms === 3000 && s.version === 1));
});

test('G13: POST storyboard/apply query form (?scriptId=) works; missing scriptId → 400', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'Pan.' }));
  const ok = await callParams(api, 'POST', '/api/v2/script/storyboard/apply', { projectId: 'p-1', scriptId: 'q-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.applied.version, 1);
  assert.ok(state.shots.every((s) => s.script_id === 'q-1'));
  const miss = await callParams(api, 'POST', '/api/v2/script/storyboard/apply', { projectId: 'p-1' });
  assert.equal(miss.status, 400);
  assert.ok(miss.body.error.includes('scriptId'));
});

test('G13: POST storyboard/apply with zero script rows → 400 (nothing to persist)', async () => {
  const { api, state } = makeHarness();
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('至少 1 行'));
  assert.equal(state.shots.length, 0);
});

test('G13: POST storyboard/apply cross-project / unknown project → 404 (project-bound ownership)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'ghost' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, '项目不存在');
  assert.equal(state.shots.length, 0);
});

test('G13: POST storyboard/apply viewer role → 403 (write gate needs owner/editor)', async () => {
  const { api, state } = makeHarness({ role: 'viewer' });
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(res.status, 403);
  assert.ok(res.body.error.includes('只读成员'));
  assert.equal(state.shots.length, 0);
  // …but the same viewer can still read the plan view (parity unchanged)
  const view = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(view.status, 200);
});

test('G13: apply refuses to persist when stored rows fail model validation (400, no write)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-bad', { kind: 'dialogue', speaker: null, text: 'orphan line' }));
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.ok(res.body.errors.some((e) => e.includes('speaker')));
  assert.equal(state.shots.length, 0);
});

test('G13: storyboard/apply URL is POST-only and the plan-view URL stays GET-only (methods never cross)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const resGet = {};
  const handled = await api.handle(h({}, { projectId: 'p-1' }), resGet, '/api/v2/script/s-1/storyboard/apply', 'GET');
  assert.equal(handled, false);
  assert.equal(resGet.status, undefined);
  const resPost = {};
  const handled2 = await api.handle(h({}, { projectId: 'p-1' }), resPost, '/api/v2/script/s-1/storyboard', 'POST');
  assert.equal(handled2, false);
  assert.equal(resPost.status, undefined);
  // 'rows' prefix stays reserved on the apply spelling too — never a persist route
  const resRows = {};
  const handled3 = await api.handle(h({}, { projectId: 'p-1' }), resRows, '/api/v2/script/rows/storyboard/apply', 'POST');
  assert.equal(handled3, false);
});

test('G13: POST storyboard/apply unauthenticated → 401', async () => {
  const anon = createScriptApi({
    pg: { query: async () => ({ rows: [] }) }, sessionUser: () => null,
    sendJSON: (r, code, body) => { r.status = code; r.body = body; },
    parseBody: async () => ({}),
  });
  const res = {};
  await anon.handle({ params: { projectId: 'p-1' } }, res, '/api/v2/script/s-1/storyboard/apply', 'POST');
  assert.equal(res.status, 401);
});
