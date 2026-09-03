'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimelineApi } = require('./timelineApi.cjs');

function makeHarness({ timelineExists = true, memberFor = ['p-1'] } = {}) {
  const state = { timelines: [], tracks: [], clips: [], deleted: 0 };
  const sendJSON = async (res, status, body) => { res.status = status; res.body = body; };
  const pg = {
    async query(sql, params = []) {
      if (/INSERT INTO project_timeline/.test(sql)) { state.timelines.push({ id: params[0], project_id: params[1], name: params[3] }); return { rows: [] }; }
      if (/INSERT INTO timeline_tracks/.test(sql)) { const id = params[0]; state.tracks.push({ id, timeline_id: params[1] }); return { rows: [] }; }
      if (/INSERT INTO timeline_clips/.test(sql)) {
        state.clips.push({ id: params[0], track_id: params[1], order_index: params[4], start_ms: params[5], duration_ms: params[6] });
        return { rows: [] };
      }
      if (/DELETE FROM timeline_clips/.test(sql)) { state.deleted++; return { rowCount: 1 }; }
      if (/FROM project_timeline t JOIN projects/.test(sql)) {
        if (!timelineExists) return { rows: [] };
        if (!state.timelines.length) state.timelines.push({ id: 'tl-1', project_id: 'p-1', workspace_id: 'w-1', name: 'T' });
        return { rows: state.timelines.filter((x) => x.id === params[0]) };
      }
      if (/FROM projects p JOIN workspaces/.test(sql)) {
        if (!['p-1', 'p-2'].includes(params[0])) return { rows: [] };
        return { rows: [{ id: params[0], workspace_id: 'w-1', name: 'P' }] };
      }
      if (/FROM workspace_members/.test(sql)) {
        const w = params[0];
        const isMember = memberFor.some((pid) => state.timelines.length ? pid === state.timelines[0].project_id : false) || w === 'w-1';
        if (w !== 'w-1') return { rows: [] };
        return { rows: params[1] === 'u-1' && memberFor.length && w === 'w-1' ? [{ role: 'editor' }] : [] };
      }
      if (/SELECT id FROM timeline_tracks/.test(sql)) {
        if (!state.tracks.length) state.tracks.push({ id: 'tr-1', timeline_id: 'tl-1' });
        return { rows: state.tracks.filter((x) => x.timeline_id === params[0]) };
      }
      if (/COALESCE\(MAX\(order_index\)/.test(sql)) { return { rows: [{ m: state.clips.length - 1 }] }; }
      if (/LEFT JOIN asset_versions/.test(sql)) { return { rows: [...state.clips].sort((a, b) => a.order_index - b.order_index) }; }
      if (/FROM project_timeline WHERE project_id/.test(sql)) { return { rows: state.timelines }; }
      if (/UPDATE timeline_clips SET order_index/.test(sql)) { const c = state.clips.find((x) => x.id === params[1]); if (c) c.order_index = params[0]; return { rows: [] }; }
      return { rows: [] };
    },
  };
  const sessionUser = () => ({ id: 'u-1' });
  const parseBody = async (req) => req._body;
  const api = createTimelineApi({ pg, sessionUser, sendJSON, parseBody });
  return { api, state };
}

const h = (body, params = {}) => ({ _body: body, params });
const post = (api, body, pid = 'p-1', path = '/api/v2/timelines') => { const res = {}; return api.handle(h(body, { projectId: pid }), res, path, 'POST').then(() => res); };
const get = (api, pid, path) => { const res = {}; return api.handle(h({}, { projectId: pid }), res, path, 'GET').then(() => res); };
const del = (api, pid, path) => { const res = {}; return api.handle(h({}, { projectId: pid }), res, path, 'DELETE').then(() => res); };
const put = (api, body, pid, path) => { const res = {}; return api.handle(h(body, { projectId: pid }), res, path, 'PUT').then(() => res); };

test('G18: create timeline → 201 with tl id (workspace from project)', async () => {
  const { api, state } = makeHarness();
  const res = await post(api, { name: '主时间线' });
  assert.equal(res.status, 201);
  assert.equal(state.timelines.length, 1);
  assert.ok(state.timelines[0].id.startsWith('tl-'));
});

test('G18: unknown project → 404; known project non-member → 403', async () => {
  const { api } = makeHarness();
  const a = await post(api, {}, 'ghost');
  assert.equal(a.status, 404);
  const { api: api2 } = makeHarness({ memberFor: [] });
  const b = await post(api2, {}, 'p-2');
  assert.equal(b.status, 403);
});

test('G18: append clip requires assetVersionId or shotId', async () => {
  const { api } = makeHarness();
  const res = await post(api, { durationMs: 1000 }, 'p-1', '/api/v2/timelines/tl-1/clips');
  assert.equal(res.status, 400);
});

test('G18: float seconds rejected — durationMs must be integer ms', async () => {
  const { api } = makeHarness();
  const res = await post(api, { assetVersionId: 'av-1', durationMs: 1.5 }, 'p-1', '/api/v2/timelines/tl-1/clips');
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.some((e) => e.includes('durationMs')));
});

test('G18: append integer clip lands on video track with auto order_index', async () => {
  const { api, state } = makeHarness();
  const res = await post(api, { assetVersionId: 'av-9', durationMs: 2400 }, 'p-1', '/api/v2/timelines/tl-1/clips');
  assert.equal(res.status, 201);
  assert.equal(state.clips.length, 1);
  assert.equal(state.clips[0].duration_ms, 2400);
  assert.equal(state.clips[0].order_index, 0);
});

test('G18: GET timeline returns ordered clip list with track', async () => {
  const { api } = makeHarness();
  await post(api, { assetVersionId: 'av-9', durationMs: 2400 }, 'p-1', '/api/v2/timelines/tl-1/clips');
  const res = await get(api, 'p-1', '/api/v2/timelines/tl-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.timeline.trackId, 'tr-1');
  assert.equal(res.body.clips.length, 1);
});

test('G18: timeline of another project → 404', async () => {
  const { api } = makeHarness({ timelineExists: false });
  const res = await get(api, 'p-1', '/api/v2/timelines/tl-x');
  assert.equal(res.status, 404);
});

test('G18: clip DELETE removes row (200); missing clipId → 400', async () => {
  const { api, state } = makeHarness();
  const res = await del(api, 'p-1', '/api/v2/timelines/tl-1/clips/cl-5');
  assert.equal(res.status, 200);
  assert.equal(state.deleted, 1);
  const res2 = await del(api, 'p-1', '/api/v2/timelines/tl-1/clips');
  assert.equal(res2.status, 400);
});

test('G18: reorder PUT reindexes clips', async () => {
  const { api, state } = makeHarness();
  state.clips.push({ id: 'cl-1', track_id: 'tr-1', order_index: 0 }, { id: 'cl-2', track_id: 'tr-1', order_index: 1 });
  const res = await put(api, { clipIds: ['cl-2', 'cl-1'] }, 'p-1', '/api/v2/timelines/tl-1/order');
  assert.equal(res.status, 200);
  assert.equal(state.clips.find((x) => x.id === 'cl-2').order_index, 0);
  assert.equal(state.clips.find((x) => x.id === 'cl-1').order_index, 1);
});

test('G18: non-timeline route → false', async () => {
  const { api } = makeHarness();
  const res = {};
  const handled = await api.handle(h({}, { projectId: 'p-1' }), res, '/api/v2/uploads/x', 'POST');
  assert.equal(handled, false);
});

test('G18: viewer role cannot write (403) — audit M1 fix', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1', name: 'P' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: [{ role: 'viewer' }] };
      return { rows: [] };
    },
  };
  const api = createTimelineApi({ pg, sessionUser: () => ({ id: 'u-1' }), sendJSON: (res, code, body) => responses.push({ code, body }), parseBody: async () => ({ name: 'T' }) });
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, {}, '/api/v2/timelines', 'POST');
  assert.equal(responses[0].code, 403);
});
