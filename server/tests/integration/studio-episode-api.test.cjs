'use strict';
/**
 * M05-E — Studio Episode API integration tests (LOCAL TEST DB ONLY).
 * Spawns the real server against a fresh test DB and exercises:
 *   - POST /episodes (create from canvas)
 *   - GET  /episodes (list, paginated)
 *   - GET  /episodes/:epId (detail with shots)
 *   - PATCH /episodes/:epId (update title/status)
 *   - POST /episodes/:epId/publish (draft -> published, no reverse)
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

async function bootstrapEpDb() {
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
  const r = await authRequest(baseUrl, { method: 'POST', path: '/api/v2/projects', body: { workspaceId: ws.id, name: 'Episode API', projectType: 'studio' } }, user.cookies);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { workspace: ws, project: r.body.project };
}

test('M05-E Studio Episode API: create/list/detail/update/publish', { concurrency: 1 }, async (t) => {
  let server, pg, dbName, user, project, canvasId;

  t.before(async () => {
    ({ dbName, pg } = await bootstrapEpDb());
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

  await t.test('setup: user + project + canvas', async () => {
    user = await register(base, { email: `m05e-ep-${Date.now()}@test.local` });
    const created = await newWorkspaceProject(base, user);
    workspace = created.workspace; project = created.project;
    const c = await authRequest(base, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas`, body: { name: 'Primary' } }, user.cookies);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    canvasId = c.body.canvas.id;
  });

  let epId;
  await t.test('POST create episode -> 201', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes`,
      body: { canvasId, title: 'Episode 1' },
    }, user.cookies);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.ok(r.body.episode.id.startsWith('ep-'));
    assert.equal(r.body.episode.projectId, project.id);
    assert.equal(r.body.episode.canvasId, canvasId);
    assert.equal(r.body.episode.seq, 1);
    assert.equal(r.body.episode.title, 'Episode 1');
    assert.equal(r.body.episode.status, 'draft');
    assert.equal(r.body.episode.publishedAt, null);
    epId = r.body.episode.id;
  });

  await t.test('POST create second episode -> seq=2', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes`,
      body: { canvasId, title: 'Episode 2' },
    }, user.cookies);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.episode.seq, 2);
    assert.equal(r.body.episode.title, 'Episode 2');
  });

  await t.test('GET list episodes -> paginated, ordered by seq', async () => {
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/episodes` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.episodes.length >= 2);
    assert.equal(r.body.pagination.total, r.body.episodes.length);
    // ordered by seq ASC
    assert.equal(r.body.episodes[0].seq, 1);
    assert.equal(r.body.episodes[1].seq, 2);
  });

  await t.test('GET episode detail -> includes empty shots array', async () => {
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/episodes/${epId}` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.episode.id, epId);
    assert.ok(Array.isArray(r.body.shots));
    assert.equal(r.body.shots.length, 0);
  });

  await t.test('GET foreign episode -> 404', async () => {
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/episodes/ep-fake-id` }, user.cookies);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  await t.test('PATCH update title -> 200', async () => {
    const r = await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/episodes/${epId}`,
      body: { title: 'Updated Episode 1' },
    }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.episode.title, 'Updated Episode 1');
  });

  await t.test('PATCH update meta -> 200', async () => {
    const r = await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/episodes/${epId}`,
      body: { meta: { customKey: 'customValue' } },
    }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.episode.meta, { customKey: 'customValue' });
  });

  await t.test('POST publish -> 200 draft->published', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/publish`,
      body: {},
    }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.episode.status, 'published');
    assert.ok(r.body.episode.publishedAt != null);
  });

  await t.test('POST publish again -> 400 INVALID_TRANSITION', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes/${epId}/publish`,
      body: {},
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'INVALID_TRANSITION');
  });

  await t.test('unauthenticated -> 401', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes`,
      body: { canvasId },
    }, {});
    assert.equal(r.status, 401);
  });

  // Create second user to test 403
  await t.test('second user cannot access first user episode -> 403', async () => {
    const userB = await register(base, { email: `m05e-ep-b-${Date.now()}@test.local` });
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/episodes/${epId}` }, userB.cookies);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  await t.test('create episode with invalid canvasId -> 404', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes`,
      body: { canvasId: 'canvas-fake-id', title: 'Bad Canvas' },
    }, user.cookies);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  await t.test('create episode without canvasId -> 400', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/episodes`,
      body: { title: 'No Canvas' },
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'CANVAS_ID_REQUIRED');
  });
});
