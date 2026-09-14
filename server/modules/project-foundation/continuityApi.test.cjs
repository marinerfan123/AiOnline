'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createContinuityApi } = require('./continuityApi.cjs');

function makeHarness({ role = 'editor', snapshot = null, removedCount = 1, charRows = [], sceneRows = [] } = {}) {
  const responses = [];
  const calls = [];
  const inserts = [];
  const pg = {
    async query(sql, params = []) {
      calls.push(sql);
      if (/INSERT INTO production_continuity_snapshots/.test(sql)) { inserts.push(params); return { rows: [], rowCount: 1 }; }
      if (/DELETE FROM production_continuity_snapshots/.test(sql)) return { rows: [], rowCount: removedCount };
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: role ? [{ role }] : [] };
      if (sql.includes('scene_shots')) return { rows: sceneRows };
      if (sql.includes('FROM project_characters')) return { rows: charRows };
      if (sql.includes('FROM project_environments')) return { rows: [] };
      if (sql.trim().startsWith('SELECT') && sql.includes('production_continuity_snapshots')) return { rows: snapshot ? [snapshot] : [] };
      return { rows: [] };
    },
  };
  const api = createContinuityApi({
    pg,
    sessionUser: () => ({ id: 'u-1' }),
    sendJSON: (res, code, body) => { responses.push({ code, body }); res.status = code; res.body = body; },
    parseBody: async (req) => req._body || {},
  });
  const call = (method, path, body = {}, params = { projectId: 'p-1' }) => {
    const res = {};
    return api.handle({ _body: body, params }, res, path, method).then(() => res);
  };
  return { api, responses, calls, inserts, call };
}

test('G14: unauthenticated → 401', async () => {
  const responses = [];
  const api = createContinuityApi({
    pg: { query: async () => ({ rows: [] }) },
    sessionUser: () => null,
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({}),
  });
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, {}, '/api/v2/bible/continuity/s-1', 'GET');
  assert.equal(responses[0].code, 401);
});

test('G14: unknown project → 404', async () => {
  const { call } = makeHarness();
  const res = await call('GET', '/api/v2/bible/continuity/s-1', {}, { projectId: 'ghost' });
  assert.equal(res.status, 404);
});

test('G14: GET snapshot returns stored row', async () => {
  const snap = { project_id: 'p-1', shot_id: 's-1', mode: 'narrative', characterStates: [], environmentStates: [], source: 'manual' };
  const { call } = makeHarness({ snapshot: snap });
  const res = await call('GET', '/api/v2/bible/continuity/s-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshot.shot_id, 's-1');
});

test('G14: GET miss → 404', async () => {
  const { call } = makeHarness({ snapshot: null });
  const res = await call('GET', '/api/v2/bible/continuity/s-1');
  assert.equal(res.status, 404);
});

test('G14: PUT invalid continuity (characterStates non-array) → 400', async () => {
  const { call } = makeHarness();
  const res = await call('PUT', '/api/v2/bible/continuity/s-1', { characterStates: 'nope' });
  assert.equal(res.status, 400);
});

test('G14: PUT valid snapshot upserts (writes through store)', async () => {
  const { call, calls } = makeHarness();
  const res = await call('PUT', '/api/v2/bible/continuity/s-1', { characterStates: [{ characterId: 'c-1', name: 'Luo' }] });
  assert.equal(res.status, 200);
  assert.ok(calls.some((s) => s.includes('INSERT INTO production_continuity_snapshots')));
});

test('G14: viewer cannot PUT (403)', async () => {
  const { call } = makeHarness({ role: 'viewer' });
  const res = await call('PUT', '/api/v2/bible/continuity/s-1', { characterStates: [] });
  assert.equal(res.status, 403);
});

test('G14: DELETE removes (200) / miss (404)', async () => {
  const okH = makeHarness({ removedCount: 1 });
  const ok = await okH.call('DELETE', '/api/v2/bible/continuity/s-1');
  assert.equal(ok.status, 200);
  const missH = makeHarness({ removedCount: 0 });
  const miss = await missH.call('DELETE', '/api/v2/bible/continuity/s-2');
  assert.equal(miss.status, 404);
});

test('G14: unknown path → false', async () => {
  const { call } = makeHarness();
  const res = {};
  const h = await makeHarness().api.handle({ _body: {}, params: { projectId: 'p-1' } }, res, '/api/v2/bible/characters', 'GET');
  assert.equal(h, false);
});

test('G14: PUT derive mode — empty inputs rejected (400)', async () => {
  const h = makeHarness();
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', { derive: true, characterIds: [], environmentId: null });
  assert.equal(res.status, 400);
});

test('G14: PUT derive mode — derives from character rows and stores (200)', async () => {
  const h = makeHarness({ charRows: [{ id: 'c-1', name: 'Luo', canonical_appearance: { hair: 'dark' }, wardrobe: {}, voice: {} }] });
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', { derive: true, characterIds: ['c-1'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.derived, true);
  assert.ok(h.calls.some((s) => s.includes('INSERT INTO production_continuity_snapshots')));
});

// ── G14-② PUT scene-inheritance mode ─────────────────────────────────────────

const BASE_SHOT_SNAP = {
  shot_id: 's-0',
  order_index: 0,
  character_states: [
    { characterId: 'c-base', name: 'Base', appearance: { hair: 'dark' }, wardrobe: { coat: 'red' }, voice: { pitch: 'low' } },
  ],
  environment_states: [
    { environmentId: 'e-1', name: 'Room', lighting: { key: 80 } },
  ],
};

test('G14②: PUT scene mode without sceneId → empty start (200, inheritedFrom null, payload stored verbatim)', async () => {
  const h = makeHarness();
  const payload = { mode: 'scene', characterStates: [{ characterId: 'c-1', name: 'Luo', wardrobe: { coat: 'black' } }] };
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.inheritedFrom, null);
  const ins = h.inserts[h.inserts.length - 1];
  assert.ok(ins, 'scene PUT must still write the current shot snapshot row');
  assert.equal(ins[0], 's-1');
  assert.equal(ins[2], 'scene'); // mode column
  assert.deepEqual(JSON.parse(ins[3]), payload.characterStates); // no injection, no base
  assert.deepEqual(JSON.parse(ins[4]), []);
});

test('G14②: PUT scene mode with prior snapshot → missing fields back-filled + inheritedFrom points at prior shot', async () => {
  const h = makeHarness({ sceneRows: [BASE_SHOT_SNAP] }); // s-0 precedes current s-1 in scene order
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', {
    mode: 'scene',
    sceneId: 'scene-1',
    characterStates: [{ characterId: 'c-1', name: 'Luo', wardrobe: { coat: 'black' } }],
    environmentStates: [], // missing content field → back-filled from base
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.inheritedFrom, 's-0');
  const ins = h.inserts[h.inserts.length - 1];
  assert.ok(ins, 'scene PUT with a base must store the merged snapshot');
  const mergedChars = JSON.parse(ins[3]);
  const mergedEnvs = JSON.parse(ins[4]);
  // base-only element carried in (scene order first) …
  assert.deepEqual(mergedChars[0], BASE_SHOT_SNAP.character_states[0]);
  // … current shot element appended with the shot-side override value
  assert.deepEqual(mergedChars[1], { characterId: 'c-1', name: 'Luo', wardrobe: { coat: 'black' } });
  // empty environmentStates back-filled from the base snapshot
  assert.deepEqual(mergedEnvs, BASE_SHOT_SNAP.environment_states);
});

test('G14②: PUT scene mode, current shot overrides same-id base element (shot side wins)', async () => {
  const h = makeHarness({ sceneRows: [BASE_SHOT_SNAP] });
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', {
    mode: 'scene',
    sceneId: 'scene-1',
    characterStates: [{ characterId: 'c-base', name: 'Base', wardrobe: { coat: 'black' } }],
    environmentStates: [],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.inheritedFrom, 's-0');
  const mergedChars = JSON.parse(h.inserts[h.inserts.length - 1][3]);
  // same characterId: shot element replaces base element whole (v1 override)
  assert.equal(mergedChars.length, 1);
  assert.deepEqual(mergedChars[0], { characterId: 'c-base', name: 'Base', wardrobe: { coat: 'black' } });
});

test('G14②: PUT scene mode, prior shots but no snapshot → inheritedFrom null, no error, payload stored verbatim', async () => {
  const h = makeHarness({
    sceneRows: [
      { shot_id: 's-0', order_index: 0, character_states: null, environment_states: null },
      { shot_id: 's-0b', order_index: 1, character_states: null, environment_states: null },
    ],
  });
  const payload = { mode: 'scene', sceneId: 'scene-1', characterStates: [{ characterId: 'c-1', name: 'Luo' }], environmentStates: [] };
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.inheritedFrom, null);
  const ins = h.inserts[h.inserts.length - 1];
  assert.ok(ins);
  assert.deepEqual(JSON.parse(ins[3]), payload.characterStates); // no back-fill
  assert.deepEqual(JSON.parse(ins[4]), []);
});

test('G14②: PUT scene mode, no preceding shots at all → inheritedFrom null, 200', async () => {
  const h = makeHarness({ sceneRows: [] }); // current s-1 is the scene's first/only shot
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', {
    mode: 'scene', sceneId: 'scene-1', characterStates: [{ characterId: 'c-1', name: 'Luo' }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.inheritedFrom, null);
  assert.ok(h.inserts.length > 0);
});

test('G14②: PUT illegal mode → 400 before any write', async () => {
  const h = makeHarness();
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', { mode: 'warp', characterStates: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0);
  assert.equal(h.inserts.length, 0); // nothing persisted
  assert.ok(!h.calls.some((s) => s.includes('scene_shots'))); // no scene read either
});

test('G14②: PUT scene mode, invalid state shape → 400', async () => {
  const h = makeHarness();
  const res = await h.call('PUT', '/api/v2/bible/continuity/s-1', { mode: 'scene', sceneId: 'scene-1', characterStates: 'nope' });
  assert.equal(res.status, 400);
  assert.equal(h.inserts.length, 0);
});
