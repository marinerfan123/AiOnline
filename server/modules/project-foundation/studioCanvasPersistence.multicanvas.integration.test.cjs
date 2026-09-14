'use strict';
// W6 多画布 — 真实 PG 集成测试（本地 PG 5441，socket ~/pg-local/sock）。
// 覆盖：GET /canvases 列表 · POST /canvases 建副画布 · POST /canvases/:id/set-primary 切主 · GET /canvas/:id 按 id 读。
// 环境：PGHOST(=socket dir)/PGPORT/PGUSER/PGDATABASE/PGPASSWORD（PGSSLMODE=disable）。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createStudioCanvasPersistence } = require('./studioCanvasPersistence.cjs');

const ADMIN = { id: 'u-local-admin', role: 'admin' };

let pool;
let proj;
const created = { project: null };

before(async () => {
  pool = new Pool({
    host: process.env.PGHOST || '/home/dministrator/pg-local/sock',
    port: Number(process.env.PGPORT || 5441),
    user: process.env.PGUSER || 'moling',
    database: process.env.PGDATABASE || 'moling',
    password: process.env.PGPASSWORD || '',
    ssl: false,
  });
  proj = `prj-itest-${Date.now()}`;
  await pool.query(`INSERT INTO projects (id, workspace_id, owner_id, name, description, project_type) VALUES ($1,'ws-local-1','u-local-admin','itest','itest','general')`, [proj]);
  created.project = proj;
});

after(async () => {
  try { await pool.query('DELETE FROM projects WHERE id=$1', [created.project]); } catch (_) {}
  await pool.end();
});

function makeModule() {
  let lastStatus = 0;
  let lastBody = null;
  const sendJSON = (res, status, body) => { lastStatus = status; lastBody = body; };
  const req = {};
  const p = createStudioCanvasPersistence({
    pg: pool,
    sessionUser: () => ADMIN,
    sendJSON,
    parseBody: async () => ({}),
    logEvent: null,
  });
  const call = async (urlPath, method, body) => {
    lastStatus = 0; lastBody = null;
    // inject a body via a per-call parseBody override is not possible post-construction;
    // handlers only read body.name for create-secondary — use a second module instance for that.
    const handled = await p.handle({ ...req, _body: body }, res, urlPath, method);
    return { handled, status: lastStatus, body: lastBody };
  };
  return { p, call, get: () => ({ status: lastStatus, body: lastBody }) };
}

// create-secondary needs parseBody to return the name — build a variant module for POST /canvases.
function makeModuleWithBody(name) {
  let lastStatus = 0; let lastBody = null;
  const sendJSON = (res, status, body) => { lastStatus = status; lastBody = body; };
  const p = createStudioCanvasPersistence({
    pg: pool,
    sessionUser: () => ADMIN,
    sendJSON,
    parseBody: async () => ({ name }),
    logEvent: null,
  });
  return { p, get: () => ({ status: lastStatus, body: lastBody }) };
}

test('W6 多画布: 列表 → 建副画布 → 切主 → 按 id 读（真实 PG）', async () => {
  const list = makeModule();
  await list.p.handle({}, {}, `/api/v2/projects/${proj}/studio/canvases`, 'GET');
  assert.equal(list.get().status, 200);
  assert.deepEqual(list.get().body.canvases, [], '新项目初始无画布');

  // 建副画布 A、B
  const createA = makeModuleWithBody('Canvas A');
  await createA.p.handle({}, {}, `/api/v2/projects/${proj}/studio/canvases`, 'POST');
  assert.equal(createA.get().status, 201);
  const idA = createA.get().body.canvas.id;
  assert.ok(idA.startsWith('canvas-'), '副画布 id 形如 canvas-<uuid>');

  const createB = makeModuleWithBody('Canvas B');
  await createB.p.handle({}, {}, `/api/v2/projects/${proj}/studio/canvases`, 'POST');
  const idB = createB.get().body.canvas.id;

  // 列表：两个副画布，均非主
  const list2 = makeModule();
  await list2.p.handle({}, {}, `/api/v2/projects/${proj}/studio/canvases`, 'GET');
  const names = list2.get().body.canvases.map((c) => c.name).sort();
  assert.deepEqual(names, ['Canvas A', 'Canvas B']);
  assert.ok(list2.get().body.canvases.every((c) => c.isPrimary === false), '初始均非主');

  // 切 A 为主
  const setP = makeModule();
  await setP.p.handle({}, {}, `/api/v2/projects/${proj}/studio/canvases/${idA}/set-primary`, 'POST');
  assert.equal(setP.get().status, 200);
  assert.equal(setP.get().body.canvas.id, idA);

  // 列表：A 主、B 非主
  const list3 = makeModule();
  await list3.p.handle({}, {}, `/api/v2/projects/${proj}/studio/canvases`, 'GET');
  const byName = Object.fromEntries(list3.get().body.canvases.map((c) => [c.name, c.isPrimary]));
  assert.equal(byName['Canvas A'], true, 'A 已切主');
  assert.equal(byName['Canvas B'], false, 'B 仍非主');

  // 按 id 读 B（副画布图）
  const readB = makeModule();
  await readB.p.handle({}, {}, `/api/v2/projects/${proj}/studio/canvas/${idB}`, 'GET');
  assert.equal(readB.get().status, 200);
  assert.equal(readB.get().body.canvas.id, idB);
  assert.deepEqual(readB.get().body.nodes, []);

  // 404：读不存在的画布
  const read404 = makeModule();
  await read404.p.handle({}, {}, `/api/v2/projects/${proj}/studio/canvas/canvas-nonexistent`, 'GET');
  assert.equal(read404.get().status, 404);
});
