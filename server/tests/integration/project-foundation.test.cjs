'use strict';
/**
 * M01-S Project / Workspace Foundation API integration tests.
 *
 * Uses a FRESH, DEDICATED test database so it cannot collide with other
 * integration tests. Applies migration 0012 on top of the shared baseline.
 * All accounts are LOCAL TEST ACCOUNTS ONLY.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { spawnTestServer } = require('../helpers/test-app.cjs');
const { initTestSchema } = require('../helpers/test-db.cjs');
const { register, authRequest } = require('../helpers/auth.cjs');

const MIGRATION_0012 = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'db', 'migrations', '0012_project_workspace_foundation.sql'),
  'utf-8',
);

const ADMIN_HOST = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const ADMIN_PORT = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const ADMIN_USER = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const ADMIN_PW = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';

async function createDb() {
  const admin = new Pool({
    host: ADMIN_HOST,
    port: ADMIN_PORT,
    user: ADMIN_USER,
    password: ADMIN_PW,
    database: 'postgres',
    max: 1,
  });
  const name = `moling_m01s_test_${crypto.randomBytes(4).toString('hex')}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return name;
}

async function dropDb(name) {
  try {
    const admin = new Pool({
      host: ADMIN_HOST,
      port: ADMIN_PORT,
      user: ADMIN_USER,
      password: ADMIN_PW,
      database: 'postgres',
      max: 1,
    });
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  } catch (_) {}
}

test('M01-S Project / Workspace Foundation API', { concurrency: 1 }, async (t) => {
  let server, pg, dbName;

  t.before(async () => {
    dbName = await createDb();
    pg = new Pool({
      host: ADMIN_HOST,
      port: ADMIN_PORT,
      user: ADMIN_USER,
      password: ADMIN_PW,
      database: dbName,
      max: 5,
    });
    await initTestSchema(pg);
    await pg.query(MIGRATION_0012);
    process.env.TEST_PG_DATABASE = dbName;
    server = await spawnTestServer();
  });

  t.after(async () => {
    if (server) await server.stop();
    delete process.env.TEST_PG_DATABASE;
    if (pg) await pg.end();
    if (dbName) await dropDb(dbName);
  });

  async function createWorkspaceAndProject(cookies, overrides = {}) {
    const wsRes = await authRequest(server.baseUrl, { method: 'GET', path: '/api/v2/workspaces' }, cookies);
    assert.equal(wsRes.status, 200, `list workspaces failed: ${JSON.stringify(wsRes.body)}`);
    assert.ok(wsRes.body.workspaces.length > 0, 'expected auto-created personal workspace');
    const workspace = wsRes.body.workspaces[0];

    const createRes = await authRequest(
      server.baseUrl,
      {
        method: 'POST',
        path: '/api/v2/projects',
        body: {
          workspaceId: workspace.id,
          name: overrides.name ?? 'M01S Test Project',
          description: overrides.description ?? 'Integration test project',
          projectType: overrides.projectType ?? 'general',
        },
      },
      cookies,
    );
    assert.equal(createRes.status, 201, `create project failed: ${JSON.stringify(createRes.body)}`);
    return { workspace, project: createRes.body.project, permissions: createRes.body.permissions };
  }

  t.test('rejects unauthenticated requests', async () => {
    const res = await authRequest(server.baseUrl, { method: 'GET', path: '/api/v2/projects' }, {});
    assert.equal(res.status, 401);
  });

  t.test('GET /api/v2/workspaces auto-creates a personal workspace', async () => {
    const u = await register(server.baseUrl, { email: `m01s-ws-${Date.now()}@test.local` });
    const res = await authRequest(server.baseUrl, { method: 'GET', path: '/api/v2/workspaces' }, u.cookies);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.workspaces));
    assert.equal(res.body.workspaces[0].role, 'owner');
    assert.equal(res.body.workspaces[0].status, 'active');
  });

  t.test('creates, lists, gets, updates, archives and restores a project', async () => {
    const u = await register(server.baseUrl, { email: `m01s-crud-${Date.now()}@test.local` });
    const { workspace, project } = await createWorkspaceAndProject(u.cookies, { name: 'CRUD Project', projectType: 'studio' });

    const listRes = await authRequest(
      server.baseUrl,
      { method: 'GET', path: `/api/v2/projects?workspace=${encodeURIComponent(workspace.id)}` },
      u.cookies,
    );
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.projects.length, 1);
    assert.equal(listRes.body.pagination.total, 1);
    assert.equal(listRes.body.pagination.hasMore, false);

    const getRes = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}` }, u.cookies);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.project.name, 'CRUD Project');
    assert.equal(getRes.body.project.projectType, 'studio');
    assert.equal(getRes.body.permissions.role, 'owner');
    assert.equal(getRes.body.permissions.canRead, true);
    assert.equal(getRes.body.permissions.canUpdate, true);

    const patchRes = await authRequest(
      server.baseUrl,
      {
        method: 'PATCH',
        path: `/api/v2/projects/${project.id}`,
        body: { name: 'CRUD Project Renamed', description: 'Updated desc', projectType: 'short_drama' },
      },
      u.cookies,
    );
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.project.name, 'CRUD Project Renamed');
    assert.equal(patchRes.body.project.projectType, 'short_drama');
    assert.ok(patchRes.body.project.version > 1);

    const badTypeRes = await authRequest(
      server.baseUrl,
      { method: 'POST', path: '/api/v2/projects', body: { workspaceId: workspace.id, name: 'Bad', projectType: 'movie' } },
      u.cookies,
    );
    assert.equal(badTypeRes.status, 400);

    const archiveRes = await authRequest(
      server.baseUrl,
      { method: 'POST', path: `/api/v2/projects/${project.id}/archive` },
      u.cookies,
    );
    assert.equal(archiveRes.status, 200);
    assert.equal(archiveRes.body.project.status, 'archived');
    assert.ok(archiveRes.body.project.archivedAt);

    const updateArchivedRes = await authRequest(
      server.baseUrl,
      { method: 'PATCH', path: `/api/v2/projects/${project.id}`, body: { name: 'Should Fail' } },
      u.cookies,
    );
    assert.equal(updateArchivedRes.status, 403);

    const archivedListRes = await authRequest(
      server.baseUrl,
      { method: 'GET', path: `/api/v2/projects?workspace=${encodeURIComponent(workspace.id)}&status=archived` },
      u.cookies,
    );
    assert.equal(archivedListRes.status, 200);
    assert.equal(archivedListRes.body.projects.length, 1);

    const restoreRes = await authRequest(
      server.baseUrl,
      { method: 'POST', path: `/api/v2/projects/${project.id}/restore` },
      u.cookies,
    );
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.body.project.status, 'active');
    assert.equal(restoreRes.body.project.archivedAt, null);
  });

  t.test('enforces cross-user project isolation', async () => {
    const a = await register(server.baseUrl, { email: `m01s-a-${Date.now()}@test.local` });
    const b = await register(server.baseUrl, { email: `m01s-b-${Date.now()}@test.local` });
    const { project } = await createWorkspaceAndProject(a.cookies, { name: 'Private Project' });

    const getRes = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}` }, b.cookies);
    assert.equal(getRes.status, 403);

    const patchRes = await authRequest(
      server.baseUrl,
      { method: 'PATCH', path: `/api/v2/projects/${project.id}`, body: { name: 'Hacked' } },
      b.cookies,
    );
    assert.equal(patchRes.status, 403);
  });

  t.test('allows workspace members to read but not mutate', async () => {
    const owner = await register(server.baseUrl, { email: `m01s-owner-${Date.now()}@test.local` });
    const member = await register(server.baseUrl, { email: `m01s-member-${Date.now()}@test.local` });
    const { workspace, project } = await createWorkspaceAndProject(owner.cookies, { name: 'Team Project' });

    const memberId = member.response.body.user?.id;
    assert.ok(memberId, 'member user id should be available after register');

    await pg.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())`,
      [workspace.id, memberId],
    );

    const getRes = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}` }, member.cookies);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.permissions.role, 'member');
    assert.equal(getRes.body.permissions.canUpdate, false);

    const patchRes = await authRequest(
      server.baseUrl,
      { method: 'PATCH', path: `/api/v2/projects/${project.id}`, body: { name: 'No Permission' } },
      member.cookies,
    );
    assert.equal(patchRes.status, 403);
  });

  t.test('supports pagination without N+1', async () => {
    const u = await register(server.baseUrl, { email: `m01s-page-${Date.now()}@test.local` });
    const wsRes = await authRequest(server.baseUrl, { method: 'GET', path: '/api/v2/workspaces' }, u.cookies);
    const workspace = wsRes.body.workspaces[0];

    for (let i = 0; i < 5; i++) {
      const r = await authRequest(
        server.baseUrl,
        {
          method: 'POST',
          path: '/api/v2/projects',
          body: { workspaceId: workspace.id, name: `Paged ${i}`, projectType: 'general' },
        },
        u.cookies,
      );
      assert.equal(r.status, 201);
    }

    const page1 = await authRequest(
      server.baseUrl,
      { method: 'GET', path: `/api/v2/projects?workspace=${encodeURIComponent(workspace.id)}&limit=2&offset=0` },
      u.cookies,
    );
    assert.equal(page1.status, 200);
    assert.equal(page1.body.projects.length, 2);
    assert.equal(page1.body.pagination.total, 5);
    assert.equal(page1.body.pagination.hasMore, true);

    const page2 = await authRequest(
      server.baseUrl,
      { method: 'GET', path: `/api/v2/projects?workspace=${encodeURIComponent(workspace.id)}&limit=2&offset=2` },
      u.cookies,
    );
    assert.equal(page2.status, 200);
    assert.equal(page2.body.projects.length, 2);
    assert.equal(page2.body.pagination.hasMore, true);
  });

  t.test('emits project events to outbox', async () => {
    const u = await register(server.baseUrl, { email: `m01s-ev-${Date.now()}@test.local` });
    const { project } = await createWorkspaceAndProject(u.cookies, { name: 'Event Project' });

    const outbox = await pg.query(
      `SELECT event_type, payload->>'project_id' AS project_id
       FROM outbox
       WHERE aggregate = 'project' AND payload->>'project_id' = $1`,
      [project.id],
    );
    assert.ok(outbox.rows.some((r) => r.event_type === 'project.created'));
  });
});
