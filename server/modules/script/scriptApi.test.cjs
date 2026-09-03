'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScriptApi } = require('./scriptApi.cjs');

function makeHarness({ memberFor = ['p-1'] } = {}) {
  const state = { rows: [], nextIndex: 0, deleted: 0 };
  const sendJSON = async (res, status, body) => { res.status = status; res.body = body; };
  const pg = {
    async query(sql, params = []) {
      if (/INSERT INTO script_rows/.test(sql)) {
        state.rows.push({ id: params[0], project_id: params[1], scene_index: params[3], row_index: params[4], kind: params[5], text: params[7] });
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
        return { rows: memberFor.includes('p-1') && params[1] === 'u-1' ? [{ role: 'editor' }] : [] };
      }
      if (/COALESCE\(MAX\(row_index\)/.test(sql)) return { rows: [{ m: state.rows.filter((r) => r.scene_index === params[1]).length - 1 }] };
      if (/FROM script_rows WHERE id/.test(sql)) {
        const r = state.rows.find((x) => x.id === params[0] && x.project_id === params[1]);
        return { rows: r ? [r] : [] };
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
