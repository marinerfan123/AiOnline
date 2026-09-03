'use strict';
/**
 * M05-E — Studio Shot API integration tests (LOCAL TEST DB ONLY).
 * Exercises:
 *   - POST /episodes/:epId/shots (bulk create from canvas nodes)
 *   - GET  /episodes/:epId/shots (timeline ordered by seq)
 *   - PATCH /episodes/:epId/shots/:shotId (update seq/duration/note)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { spawnTestServer } = require('../helpers/test-app.cjs');
const { register, authRequest } = require('../helpers/auth.cjs');
const { initTestSchema } = require('../helpers/test-db.cjs');

const MIGRATIONS = [
  '0012_project_workspace_foundation.sql',
  '0013_asset_foundation.sql',
  '0014_studio_canvas_persistence.sql',
  '0016_episodes.sql',
  '0017_shots.sql',
];

const ADMIN_HOST = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const ADMIN_PORT = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const ADMIN_USER = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const ADMIN_PW = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || process.env.PGPASSWORD || '0.0.1abcd';

function poolConfig(database, max = 8) {
  return { host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, password: ADMIN_PW, database, max };
}

async function createDb() {
  const admin = new Pool(poolConfig('postgres', 1));
  const name = `moling_m05e_test_${crypto.randomBytes(4).toString('hex')}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return name;
}

async function dropDb(name) {
  try {
    const admin = new Pool(poolConfig('postgres', 1));
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  } catch (_) {}
}

async function bootstrapShotDb() {
  const dbName = await createDb();
  const pg = new Pool(poolConfig(dbName));
  await initTestSchema(pg);
  for (const m of MIGRATIONS) {
    await pg.query(fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'migrations', m), 'utf8'));
  }
  return { dbName, pg };
}

async function newWorkspaceProject(baseUrl, user) {
  const wsRes = await authRequest(baseUrl, { method: 'GET', path: '/api/v2/workspaces' }, user.cookies);
  assert.equal(wsRes.status, 200);
  const ws = wsRes.body.workspaces[0];
  const r = await authRequest(baseUrl, { method: 'POST', path: '/api/v2/projects', body: { workspaceId: ws.id, name: 'Shot API', projectType: 'studio' } }, user.cookies);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { workspace: ws, project: r.body.project };
}

const promptNode = (id) => ({
  nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1,
  position: { x: 1, y: 2 }, size: { width: 260, height: 120 }, zIndex: 1,
  data: { nodeKind: 'prompt', nodeType: 'prompt', schemaVersion: 1, title: 'P', status: 'READY', parameters: { prompt: 'hello' }, prompt: 'hello' },
});

test('M05-E Studio Shot API: bulk create/list/update', { concurrency: 1 }, async (t) => {
  let server, pg, dbName, user, project, canvasId, epId;

  t.before(async () => {
    ({ dbName, pg } = await bootstrapShotDb());
    process.env.TEST_PG_DATABASE = dbName;
    server = await spawnTestServer();
  });
  t.after(async () => {
    if (server) await server.stop();
    delete process.env.TEST_PG_DATABASE;
    if (pg) await pg.end();
    if (dbName) await dropDb(dbName);
  });

  const base = server.baseUrl;

  await t.test('setup: user + project + canvas with nodes', async () => {
    user = await register(base, { email: `m05e-shot-${Date.now()}@test.local` });
    const created = await newWorkspaceProject(base, user);
    workspace = created.workspace; project = created.project;
    const c = await authRequest(base, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas`, body: { name: 'Primary' } }, user.cookies);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    canvasId = c.body.canvas.id;
    // add 3 prompt nodes via patch (revision 1 -> 2)
    const p = await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/studio/canvas`,
      body: {
        baseRevision: 1,
        clientMutationId: `mut-${crypto.randomBytes(4).toString('hex')}`,
        upsertNodes: [promptNode('node1'), promptNode('node2'), promptNode('node3')],
        upsertEdges: [],
      },
    }, user.cookies);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.canvas.revision, 2);

    // create an episode linked to this canvas
    const ep = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes`,
      body: { canvasId, title: 'Test Episode' },
    }, user.cookies);
    assert.equal(ep.status, 201, JSON.stringify(ep.body));
    epId = ep.body.episode.id;
  });

  await t.test('GET empty shots timeline -> 200 with empty array', async () => {
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/episodes/${epId}/shots` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.shots));
    assert.equal(r.body.shots.length, 0);
  });

  await t.test('POST bulk create 3 shots -> 201', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/shots`,
      body: {
        nodes: [
          { canvasNodeId: 'node1', durationSeconds: 5, note: 'First shot' },
          { canvasNodeId: 'node2', durationSeconds: 10, note: 'Second shot' },
          { canvasNodeId: 'node3', note: 'Third shot no duration' },
        ],
      },
    }, user.cookies);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.shots.length, 3);
    assert.equal(r.body.shots[0].seq, 1);
    assert.equal(r.body.shots[1].seq, 2);
    assert.equal(r.body.shots[2].seq, 3);
    assert.equal(r.body.shots[0].durationSeconds, 5);
    assert.equal(r.body.shots[1].durationSeconds, 10);
    assert.equal(r.body.shots[2].durationSeconds, null);
  });

  await t.test('GET shots timeline -> ordered by seq', async () => {
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/episodes/${epId}/shots` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.shots.length, 3);
    assert.equal(r.body.shots[0].seq, 1);
    assert.equal(r.body.shots[1].seq, 2);
    assert.equal(r.body.shots[2].seq, 3);
  });

  let shot1Id;
  await t.test('PATCH update shot seq/duration/note -> 200', async () => {
    // get first shot id
    const listR = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/episodes/${epId}/shots` }, user.cookies);
    shot1Id = listR.body.shots[0].id;
    const r = await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/shots/${shot1Id}`,
      body: { seq: 10, durationSeconds: 8, note: 'Updated note' },
    }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.shot.seq, 10);
    assert.equal(r.body.shot.durationSeconds, 8);
    assert.equal(r.body.shot.note, 'Updated note');
  });

  await t.test('GET after patch -> seq reordered by seq column', async () => {
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/episodes/${epId}/shots` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // shot1 now has seq=10, so it's last
    const shotById = r.body.shots.find(s => s.id === shot1Id);
    assert.equal(shotById.seq, 10);
  });

  await t.test('PATCH shot on non-existent episode -> 404', async () => {
    const r = await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/episodes/ep-fake/shots/${shot1Id}`,
      body: { seq: 1 },
    }, user.cookies);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  await t.test('PATCH shot with invalid seq -> 400', async () => {
    const r = await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/shots/${shot1Id}`,
      body: { seq: 0 },
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'INVALID_SEQ');
  });

  await t.test('PATCH shot with invalid duration -> 400', async () => {
    const r = await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/shots/${shot1Id}`,
      body: { durationSeconds: -1 },
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'INVALID_DURATION');
  });

  await t.test('bulk create with invalid node -> 400', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/shots`,
      body: { nodes: [{ canvasNodeId: 'ghost-node' }] },
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'INVALID_NODE_IDS');
  });

  await t.test('bulk create empty nodes -> 400', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/shots`,
      body: { nodes: [] },
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'NODES_REQUIRED');
  });

  await t.test('unauthenticated -> 401', async () => {
    const r = await authRequest(base, {
      method: 'GET',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/shots`,
    }, {});
    assert.equal(r.status, 401);
  });

  await t.test('create shots on archived episode -> 400', async () => {
    // archive the episode first
    await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/episodes/${epId}`,
      body: { status: 'archived' },
    }, user.cookies);
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/shots`,
      body: { nodes: [{ canvasNodeId: 'node1' }] },
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'EPISODE_ARCHIVED');
  });
});
