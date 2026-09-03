'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createContinuityApi } = require('./continuityApi.cjs');

function makeHarness({ role = 'editor', snapshot = null, removedCount = 1, charRows = [] } = {}) {
  const responses = [];
  const calls = [];
  const pg = {
    async query(sql, params = []) {
      calls.push(sql);
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: role ? [{ role }] : [] };
      if (/INSERT INTO production_continuity_snapshots/.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM production_continuity_snapshots/.test(sql)) return { rows: [], rowCount: removedCount };
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
  return { api, responses, calls, call };
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
