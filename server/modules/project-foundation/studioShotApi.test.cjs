'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createStudioShotApi } = require('./studioShotApi.cjs');

// Scripted pg client: return rows per SQL pattern, tracking the UPDATE params for optimistic checks.
function makeDeps({ updateRows = null } = {}) {
  const rowsBySql = {
    'SELECT p.*, w.owner_id': [{ id: 'p1', workspace_id: 'w1', status: 'active' }],
    'SELECT * FROM episodes WHERE': [{ id: 'e1', project_id: 'p1', canvas_id: 'c1' }],
    'FROM shots s JOIN episodes': [{ ...SHOT_ROW }],
  };
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const key of Object.keys(rowsBySql)) if (sql.includes(key)) return { rows: rowsBySql[key], rowCount: rowsBySql[key].length };
      if (sql.includes('UPDATE shots SET')) return { rows: updateRows || [], rowCount: updateRows ? updateRows.length : 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const responses = [];
  const api = createStudioShotApi({
    pg: { connect: async () => client },
    sendJSON: async (_res, status, body) => { responses.push({ status, body }); },
    sessionUser: () => ({ id: 'u1', role: 'admin' }),
    parseBody: async (req) => req._body || {},
  });
  return { api, calls, responses };
}

const SHOT_ROW = {
  id: 's1', episode_id: 'e1', canvas_node_id: 'n1', seq: 1, asset_id: 'a1', duration_seconds: 30,
  note: 'x', title: 'Opening shot', story_intent: { synopsis: 'intro' }, cinematography: { lens: '35mm' },
  context: { scene: 1 }, generation_meta: { model: 'm1' }, output: { url: 'o1' }, commerce: { sku: 'SKU1' },
  version: 2, created_at: '2026-01-01T00:00:00Z',
};

test('FORMAT_SHOT exposes W1-09 fields + version', () => {
  const { api } = makeDeps();
  const fmt = api.FORMAT_SHOT(SHOT_ROW);
  assert.equal(fmt.title, 'Opening shot');
  assert.deepEqual(fmt.storyIntent, { synopsis: 'intro' });
  assert.equal(fmt.version, 2);
  assert.ok(fmt.cinematography && fmt.commerce && fmt.generationMeta);
});

test('PATCH rejects locked fields (generationMeta/output/commerce)', async () => {
  const { api, responses } = makeDeps();
  await api.handle({ _body: { generationMeta: { x: 1 } } }, undefined, '/api/v2/projects/p1/episodes/e1/shots/s1', 'PATCH');
  const r = responses.at(-1);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'LOCKED_FIELD');
});

test('PATCH optimistic version mismatch -> 409 STALE_SHOT_VERSION', async () => {
  const { api, responses } = makeDeps({ updateRows: [] }); // UPDATE returns 0 rows => stale
  await api.handle({ _body: { title: 'x', version: 99 } }, undefined, '/api/v2/projects/p1/episodes/e1/shots/s1', 'PATCH');
  const r = responses.at(-1);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'STALE_SHOT_VERSION');
});

test('PATCH allowed field update bumps version', async () => {
  const { api, responses, calls } = makeDeps({ updateRows: [{ ...SHOT_ROW, title: 'New', version: 3 }] });
  await api.handle({ _body: { title: 'New' } }, undefined, '/api/v2/projects/p1/episodes/e1/shots/s1', 'PATCH');
  const r = responses.at(-1);
  assert.equal(r.status, 200);
  assert.ok(r.body.shot && r.body.shot.title === 'New');
  const upd = calls.find((c) => c.sql.includes('UPDATE shots SET'));
  assert.ok(upd, 'an UPDATE ran');
  assert.ok(upd.sql.includes('version = version + 1'), 'version bumped in SQL');
});
