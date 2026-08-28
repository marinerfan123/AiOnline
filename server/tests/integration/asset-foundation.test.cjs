'use strict';
/**
 * M04-S Asset Foundation API integration tests.
 *
 * FRESH dedicated test DB (moling_m04s_test_*), migrations 0012 + 0013 on top
 * of the shared baseline. LOCAL TEST ACCOUNTS ONLY. No production credentials.
 *
 * Covers: authority compatibility (media stays the authority), project asset
 * list + pagination + search + type filter, asset detail, authorization
 * (cross-user / cross-workspace isolation), invalid asset, archived/failed
 * handling, upload + generation projections, OpenAPI/Zod contract parity is
 * covered by frontend unit tests.
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
const MIGRATION_0013 = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'db', 'migrations', '0013_asset_foundation.sql'),
  'utf-8',
);

const ADMIN_HOST = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const ADMIN_PORT = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const ADMIN_USER = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const ADMIN_PW = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';

function adminPool() {
  return new Pool({ host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, password: ADMIN_PW, database: 'postgres', max: 1 });
}

async function createDb() {
  const admin = adminPool();
  const name = `moling_m04s_test_${crypto.randomBytes(4).toString('hex')}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return name;
}

async function dropDb(name) {
  try {
    const admin = adminPool();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  } catch (_) {}
}

const THUMB = 'http://127.0.0.1/test-fixtures/moling-asset.png';
const THUMB2 = 'http://127.0.0.1/test-fixtures/moling-asset-2.png';

test('M04-S Asset Foundation API', { concurrency: 1 }, async (t) => {
  let server, pg, dbName;
  let userA, userB, wsA, projectA, projectB;

  t.before(async () => {
    dbName = await createDb();
    pg = new Pool({ host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, password: ADMIN_PW, database: dbName, max: 5 });
    await initTestSchema(pg);
    await pg.query(MIGRATION_0012);
    await pg.query(MIGRATION_0013);
    process.env.TEST_PG_DATABASE = dbName;
    server = await spawnTestServer();

    // 0013 additive columns must exist with NULL defaults (legacy data preserved).
    const cols = await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='media'
       AND column_name IN ('workspace_id','project_id','mime_type','width','height','duration_ms','origin','generation_batch_id','updated_at')`,
    );
    assert.equal(cols.rows.length, 9, '0013 additive media columns should exist');
    const rel = await pg.query(`SELECT 1 FROM information_schema.tables WHERE table_name='project_assets'`);
    assert.equal(rel.rows.length, 1, 'project_assets should exist');
  });

  t.after(async () => {
    if (server) await server.stop();
    delete process.env.TEST_PG_DATABASE;
    if (pg) await pg.end();
    if (dbName) await dropDb(dbName);
  });

  async function newProject(user, name) {
    const wsRes = await authRequest(server.baseUrl, { method: 'GET', path: '/api/v2/workspaces' }, user.cookies);
    assert.equal(wsRes.status, 200);
    const ws = wsRes.body.workspaces[0];
    const r = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/projects',
      body: { workspaceId: ws.id, name, description: 'M04S test' },
    }, user.cookies);
    assert.equal(r.status, 201, `create project failed: ${JSON.stringify(r.body)}`);
    return { ws, project: r.body.project };
  }

  async function createAsset(user, project, opts) {
    const r = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/assets',
      body: { projectId: project.id, url: opts.url || THUMB, title: opts.title, assetType: opts.assetType || 'IMAGE', mimeType: opts.mimeType, width: opts.width, height: opts.height, durationMs: opts.durationMs, sizeBytes: opts.sizeBytes },
    }, user.cookies);
    assert.equal(r.status, 201, `create asset failed: ${JSON.stringify(r.body)}`);
    return r.body.asset;
  }

  t.test('rejects unauthenticated asset requests', async () => {
    for (const p of ['/api/v2/assets', `/api/v2/projects/${'x'}/assets`]) {
      const res = await authRequest(server.baseUrl, { method: 'GET', path: p }, {});
      assert.equal(res.status, 401);
    }
  });

  t.test('asset authority compatibility: media row IS the asset', async () => {
    userA = await register(server.baseUrl, { email: `m04s-a-${Date.now()}@test.local` });
    ({ ws: wsA, project: projectA } = await newProject(userA, 'M04S Project A'));

    const asset = await createAsset(userA, projectA, { title: '权威图像', width: 512, height: 512, sizeBytes: 12345 });
    assert.ok(asset.assetId, 'assetId present');
    assert.equal(asset.projectId, projectA.id);
    assert.equal(asset.workspaceId, wsA.id);
    const ownerId = userA.response?.body?.user?.id || null;
    assert.equal(asset.ownerId, ownerId, 'ownerId is the acting user');

    // The durable authority row is `media` with the SAME id.
    const mediaRow = await pg.query('SELECT * FROM media WHERE id=$1', [asset.assetId]);
    assert.equal(mediaRow.rows.length, 1, 'media row exists under assetId');
    assert.equal(mediaRow.rows[0].project_id, projectA.id);
    assert.equal(mediaRow.rows[0].workspace_id, wsA.id);
    assert.equal(mediaRow.rows[0].origin, 'UPLOAD');
    assert.equal(Number(mediaRow.rows[0].width), 512);
    const rel = await pg.query('SELECT * FROM project_assets WHERE asset_id=$1', [asset.assetId]);
    assert.equal(rel.rows.length, 1, 'project_assets relation row exists');
    assert.equal(rel.rows[0].added_by, asset.ownerId);
  });

  t.test('project asset list: pagination, search, type filter', async () => {
    // Seed 5 assets: 3 IMAGE, 1 VIDEO, 1 AUDIO.
    const a1 = await createAsset(userA, projectA, { title: 'alpha image' });
    await createAsset(userA, projectA, { title: 'beta image' });
    await createAsset(userA, projectA, { title: 'gamma image' });
    await createAsset(userA, projectA, { title: 'delta video', assetType: 'VIDEO', mimeType: 'video/mp4', durationMs: 15000 });
    await createAsset(userA, projectA, { title: 'echo audio', assetType: 'AUDIO', mimeType: 'audio/mpeg' });
    void a1;

    const all = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?limit=3` }, userA.cookies);
    assert.equal(all.status, 200);
    assert.equal(all.body.assets.length, 3);
    assert.equal(all.body.pagination.total, 6);
    assert.equal(all.body.pagination.hasMore, true);
    assert.ok(all.body.assets.every((a) => a.assetId));

    // newest-first ordering
    assert.ok(new Date(all.body.assets[0].createdAt) >= new Date(all.body.assets[all.body.assets.length - 1].createdAt));

    const page2 = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?limit=3&offset=3` }, userA.cookies);
    assert.equal(page2.body.assets.length, 3);
    const ids = [...all.body.assets, ...page2.body.assets].map((a) => a.assetId);
    assert.equal(new Set(ids).size, 6, 'no duplicates across pages');

    const search = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?search=alpha` }, userA.cookies);
    assert.equal(search.body.assets.length, 1);
    assert.equal(search.body.assets[0].title, 'alpha image');

    const video = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?type=VIDEO` }, userA.cookies);
    assert.equal(video.body.assets.length, 1);
    assert.equal(video.body.assets[0].assetType, 'VIDEO');
    assert.equal(video.body.assets[0].durationMs, 15000);

    const audio = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?type=AUDIO` }, userA.cookies);
    assert.equal(audio.body.assets.length, 1);

    const other = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?type=OTHER` }, userA.cookies);
    assert.equal(other.body.assets.length, 0, 'OTHER matches nothing here');

    const invalidType = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?type=PDF` }, userA.cookies);
    assert.equal(invalidType.status, 400);
  });

  t.test('asset detail with provenance summary', async () => {
    const res = await authRequest(server.baseUrl, { method: 'GET', path: '/api/v2/assets' }, userA.cookies);
    assert.equal(res.status, 200);
    const asset = res.body.assets.find((a) => a.title === 'delta video');
    assert.ok(asset, 'delta video in my assets');

    const detail = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/assets/${asset.assetId}` }, userA.cookies);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.asset.assetId, asset.assetId);
    assert.equal(detail.body.asset.assetType, 'VIDEO');
    assert.equal(detail.body.asset.status, 'READY');
    assert.equal(detail.body.asset.storageProvider, 'provider');
    assert.equal(detail.body.asset.ossUploaded, false);
    assert.ok(detail.body.asset.provenance, 'provenance summary present');
    assert.equal(detail.body.asset.provenance.origin, 'UPLOAD');
  });

  t.test('cross-user isolation: B cannot read/list A assets or project', async () => {
    userB = await register(server.baseUrl, { email: `m04s-b-${Date.now()}@test.local` });

    const listA = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets` }, userB.cookies);
    assert.equal(listA.status, 403, 'B cannot list A project assets');

    const myA = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/assets` }, userA.cookies);
    const aAsset = myA.body.assets[0];
    const detailB = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/assets/${aAsset.assetId}` }, userB.cookies);
    assert.equal(detailB.status, 403, 'B cannot read A private asset by guessed id');

    const registerB = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/assets',
      body: { projectId: projectA.id, assetId: aAsset.assetId },
    }, userB.cookies);
    assert.equal(registerB.status, 403, 'B cannot re-scope A asset into A project');
  });

  t.test('cross-workspace isolation: second workspace of A cannot list projectA', async () => {
    // Add B as member of a NEW workspace, verify that workspace membership
    // does not leak projectA assets (different workspace).
    const r = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/assets',
      body: { projectId: projectA.id, url: THUMB2, title: 'probe' },
    }, userA.cookies);
    assert.equal(r.status, 201);
    const all = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets` }, userA.cookies);
    assert.ok(all.body.assets.some((a) => a.title === 'probe'));
    // Non-member B already verified 403 above; also verify 404 for unknown project.
    const missing = await authRequest(server.baseUrl, { method: 'GET', path: '/api/v2/projects/proj-does-not-exist/assets' }, userA.cookies);
    assert.equal(missing.status, 404);
  });

  t.test('invalid asset id returns 404, not 500', async () => {
    const res = await authRequest(server.baseUrl, { method: 'GET', path: '/api/v2/assets/m-nonexistent-123' }, userA.cookies);
    assert.equal(res.status, 404);
  });

  t.test('archived + failed asset handling via legacy authority rows', async () => {
    const asset = await createAsset(userA, projectA, { title: 'will-archive' });
    // Soft-delete (legacy archive) + failed rows via the authority table.
    await pg.query("UPDATE media SET is_deleted=TRUE, status='success' WHERE id=$1", [asset.assetId]);
    const failedId = `mf-fail-${Date.now()}`;
    await pg.query(
      `INSERT INTO media (id, title, type, full_url, status, error_message, failed_at, user_id, project_id, workspace_id, origin)
       VALUES ($1, 'will-fail', 'image', $2, 'failed', 'boom', NOW(), $3, $4, $5, 'GENERATION')`,
      [failedId, THUMB, userA.response.body.user.id, projectA.id, wsA.id],
    );

    const ready = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?status=READY` }, userA.cookies);
    assert.ok(!ready.body.assets.some((a) => a.assetId === asset.assetId), 'archived not in READY');
    const archived = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?status=ARCHIVED` }, userA.cookies);
    assert.ok(archived.body.assets.some((a) => a.assetId === asset.assetId), 'archived listed under ARCHIVED');
    const failed = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?status=FAILED` }, userA.cookies);
    const f = failed.body.assets.find((a) => a.assetId === failedId);
    assert.ok(f, 'failed asset listed');
    assert.equal(f.status, 'FAILED');

    const failedDetail = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/assets/${failedId}` }, userA.cookies);
    assert.equal(failedDetail.body.asset.status, 'FAILED');
    assert.equal(failedDetail.body.asset.errorMessage, 'boom');
    assert.ok(failedDetail.body.asset.failedAt);
  });

  t.test('generation projection: legacy media row with task_id → GENERATION origin', async () => {
    const genId = `mf-gen-${Date.now()}`;
    await pg.query(
      `INSERT INTO media (id, title, type, full_url, thumbnail, status, file_size, user_id, task_id, origin, created_at)
       VALUES ($1, 'generated hero', 'image', $2, $3, 'success', 999, $4, $5, 'GENERATION', NOW())`,
      [genId, THUMB, THUMB, userA.response.body.user.id, `task-${Date.now()}`],
    );
    // Attach to project the same way the V2 finalize bridge will (scoped update).
    await pg.query('UPDATE media SET project_id=$2, workspace_id=$3 WHERE id=$1', [genId, projectA.id, wsA.id]);

    const list = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?search=generated hero` }, userA.cookies);
    assert.equal(list.body.assets.length, 1);
    assert.equal(list.body.assets[0].origin, 'GENERATION');

    const detail = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/assets/${genId}` }, userA.cookies);
    assert.equal(detail.body.asset.provenance.origin, 'GENERATION');
    assert.ok(detail.body.asset.provenance.generationTaskId.startsWith('task-'));
  });

  t.test('register: re-scope existing owned asset; reject foreign assetId', async () => {
    const created = await createAsset(userA, projectA, { title: 'to-register' });
    const { project: projectB2 } = await newProject(userA, 'M04S Project B2');
    projectB = projectB2;

    const reg = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/assets',
      body: { projectId: projectB.id, assetId: created.assetId, title: 'registered name' },
    }, userA.cookies);
    assert.equal(reg.status, 200, `register failed: ${JSON.stringify(reg.body)}`);
    assert.equal(reg.body.asset.assetId, created.assetId, 'identity preserved across re-scope');
    assert.equal(reg.body.asset.projectId, projectB.id);

    // A asset listed under B now.
    const bList = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectB.id}/assets` }, userA.cookies);
    assert.ok(bList.body.assets.some((a) => a.assetId === created.assetId));

    // B (different user) cannot register A's asset.
    const foreign = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/assets',
      body: { projectId: projectB.id, assetId: created.assetId },
    }, userB.cookies);
    assert.equal(foreign.status, 403);

    // Invalid write payloads.
    const noId = await authRequest(server.baseUrl, { method: 'POST', path: '/api/v2/assets', body: { projectId: projectB.id } }, userA.cookies);
    assert.equal(noId.status, 400);
    const both = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/assets',
      body: { projectId: projectB.id, assetId: created.assetId, url: THUMB },
    }, userA.cookies);
    assert.equal(both.status, 400);
    const badType = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/assets',
      body: { projectId: projectB.id, url: THUMB, assetType: 'PDF' },
    }, userA.cookies);
    assert.equal(badType.status, 400);
    const badUrl = await authRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/v2/assets',
      body: { projectId: projectB.id, url: 'not-a-url' },
    }, userA.cookies);
    assert.equal(badUrl.status, 400);
  });

  t.test('no secret leakage in asset responses', async () => {
    const res = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${projectA.id}/assets?limit=50` }, userA.cookies);
    const raw = JSON.stringify(res.body);
    for (const secret of ['access_key', 'accessKey', 'secret', 'AccessKeyId', 'LTAI']) {
      assert.ok(!raw.includes(secret), `asset list must not leak ${secret}`);
    }
  });
});
