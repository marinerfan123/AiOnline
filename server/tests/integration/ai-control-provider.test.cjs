'use strict';
/**
 * M02-B — Provider + Key Pool V2 API integration tests.
 *
 * Uses a FRESH, DEDICATED test database (moling_mig-style, created + dropped
 * by this file) so it cannot collide with the shared moling_test DB used by
 * all.test.cjs / asset tests when node --test globs the directory.
 *
 * Exercises /api/v2/ai-control/* end to end against the real server:
 * admin authorization, masked-only reads, key add/dedupe, metadata update,
 * delete, cooldown, legacy-fallback credential classification, no-secret.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { spawnTestServer, request, getCookies, buildCookieHeader } = require('../helpers/test-app.cjs');
const { initTestSchema } = require('../helpers/test-db.cjs');

const ADMIN_PW = 'InitPass123!';
const USER_PW = 'TestPass123!';

function cookieHeader(res) {
  return buildCookieHeader(getCookies(res.cookies));
}

async function createDb() {
  const admin = new Pool({
    host: process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost',
    port: Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432'),
    user: process.env.TEST_PG_USER || process.env.PG_USER || 'postgres',
    password: process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd',
    database: 'postgres',
    max: 1,
  });
  const name = `moling_m02b_test_${crypto.randomBytes(4).toString('hex')}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return name;
}

async function dropDb(name) {
  try {
    const admin = new Pool({
      host: process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost',
      port: Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432'),
      user: process.env.TEST_PG_USER || process.env.PG_USER || 'postgres',
      password: process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd',
      database: 'postgres',
      max: 1,
    });
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  } catch (_) {}
}

test('M02-B AI Control Plane provider/key-pool API', { concurrency: 1 }, async (t) => {
  let server, pg, dbName, adminCookie, userCookie;
  const provId = 'v2prov-' + Date.now().toString(36);
  const legacyProvId = 'v2provlegacy-' + Date.now().toString(36);
  const legacyKey = 'legacy-agnes-key-' + Math.random().toString(36).slice(2, 10);

  t.before(async () => {
    dbName = await createDb();
    pg = new Pool({
      host: process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost',
      port: Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432'),
      user: process.env.TEST_PG_USER || process.env.PG_USER || 'postgres',
      password: process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd',
      database: dbName,
      max: 5,
    });
    await initTestSchema(pg);
    process.env.TEST_PG_DATABASE = dbName;
    server = await spawnTestServer();
  });

  t.after(async () => {
    if (server) await server.stop();
    delete process.env.TEST_PG_DATABASE;
    if (pg) await pg.end();
    if (dbName) await dropDb(dbName);
  });

  // ── auth setup (fresh DB → setup wizard unlocked) ──
  t.test('setup: admin + normal user sessions', async () => {
    const adminEmail = `v2admin${Date.now()}@t.com`;
    const si = await request(server.baseUrl, { method: 'POST', path: '/api/setup/init', body: { adminEmail, adminPassword: ADMIN_PW } });
    assert.equal(si.status, 200, 'setup/init on fresh db: ' + JSON.stringify(si.body));
    const lr = await request(server.baseUrl, { method: 'POST', path: '/api/auth/login', body: { email: adminEmail, password: ADMIN_PW } });
    assert.equal(lr.status, 200, 'admin login');
    adminCookie = cookieHeader(lr);

    const userEmail = `v2user${Date.now()}@t.com`;
    const reg = await request(server.baseUrl, { method: 'POST', path: '/api/auth/register', body: { email: userEmail, password: USER_PW } });
    assert.ok(reg.status === 200 || reg.status === 201, 'user register: ' + JSON.stringify(reg.body));
    const ul = await request(server.baseUrl, { method: 'POST', path: '/api/auth/login', body: { email: userEmail, password: USER_PW } });
    assert.equal(ul.status, 200, 'user login');
    userCookie = cookieHeader(ul);
  });

  t.test('anon GET /providers → 401', async () => {
    const r = await request(server.baseUrl, { method: 'GET', path: '/api/v2/ai-control/providers' });
    assert.equal(r.status, 401);
  });

  t.test('normal user GET /providers → 403', async () => {
    const r = await request(server.baseUrl, { method: 'GET', path: '/api/v2/ai-control/providers', headers: { Cookie: userCookie } });
    assert.equal(r.status, 403);
  });

  t.test('normal user POST /providers → 403', async () => {
    const r = await request(server.baseUrl, { method: 'POST', path: '/api/v2/ai-control/providers', headers: { Cookie: userCookie }, body: { id: 'x', name: 'x' } });
    assert.equal(r.status, 403);
  });

  t.test('admin create provider (with legacy api_key)', async () => {
    const r = await request(server.baseUrl, {
      method: 'POST', path: '/api/v2/ai-control/providers', headers: { Cookie: adminCookie },
      body: { id: provId, name: 'V2 Agnes', baseUrl: 'https://api.agnes-ai.cn/v1', protocol: 'openai-compatible', apiKey: legacyKey },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.provider.id, provId);
    // no full secret in response
    assert.ok(!JSON.stringify(r.body).includes(legacyKey), 'create response must not contain full key');
  });

  t.test('admin get provider → masked legacy + credential_source LEGACY_FALLBACK (empty pool)', async () => {
    const r = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}`, headers: { Cookie: adminCookie } });
    assert.equal(r.status, 200);
    const v = r.body.provider;
    assert.equal(v.credential.has_legacy_key, true);
    assert.ok(v.credential.masked_legacy_key.endsWith(legacyKey.slice(-4)), 'masked shows last4');
    assert.ok(!JSON.stringify(v).includes(legacyKey), 'no full secret');
    assert.equal(v.credential_source.source, 'LEGACY_FALLBACK');
    assert.equal(v.credential_source.pool_count, 0);
    assert.equal(v.key_pool_count, 0);
  });

  t.test('admin list providers (search + filter)', async () => {
    const all = await request(server.baseUrl, { method: 'GET', path: '/api/v2/ai-control/providers', headers: { Cookie: adminCookie } });
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.body.providers));
    assert.ok(all.body.providers.some((p) => p.id === provId));
    const searched = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers?q=${provId}`, headers: { Cookie: adminCookie } });
    assert.equal(searched.status, 200);
    assert.ok(searched.body.providers.every((p) => p.id === provId));
    assert.ok(JSON.stringify(searched.body).length < 1_000_000, 'sanity');
  });

  t.test('admin add key → pool count 1, source POOL', async () => {
    const r = await request(server.baseUrl, {
      method: 'POST', path: `/api/v2/ai-control/providers/${provId}/keys`, headers: { Cookie: adminCookie },
      body: { apiKey: 'sk-newpoolkey111', label: 'pool-1', weight: 120 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.added, 1, 'single key added');
    assert.equal(r.body.skipped, 0);
    assert.equal(r.body.total, 1);
    assert.ok(!JSON.stringify(r.body).includes('sk-newpoolkey111'), 'add response masks key');
    const added = r.body.keys.find((k) => k.masked.endsWith('y111'));
    assert.ok(added, 'added key present, masked');
    assert.ok(added.masked.length < 'sk-newpoolkey111'.length, 'masked is shorter than full key');
    const g = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}`, headers: { Cookie: adminCookie } });
    assert.equal(g.body.provider.key_pool_count, 1);
    assert.equal(g.body.provider.credential_source.source, 'POOL');
    assert.equal(g.body.provider.active_key_count, 1);
  });

  t.test('admin batch add keys with dedupe (array + multiline string)', async () => {
    const r1 = await request(server.baseUrl, {
      method: 'POST', path: `/api/v2/ai-control/providers/${provId}/keys`, headers: { Cookie: adminCookie },
      body: { apiKeys: ['sk-batchA11111', 'sk-batchB22222', 'sk-newpoolkey111'] }, // last = existing → dedupe
    });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.added, 2, 'two new');
    assert.equal(r1.body.skipped, 1, 'one duplicate');
    assert.equal(r1.body.total, 3);
    // multiline string form
    const r2 = await request(server.baseUrl, {
      method: 'POST', path: `/api/v2/ai-control/providers/${provId}/keys`, headers: { Cookie: adminCookie },
      body: { keys: 'sk-batchC33333\nsk-batchA11111' },
    });
    assert.equal(r2.status, 201);
    assert.equal(r2.body.added, 1);
    assert.equal(r2.body.skipped, 1);
    assert.equal(r2.body.total, 4);
  });

  t.test('admin keys GET → masked-only list + no secret', async () => {
    const r = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}/keys`, headers: { Cookie: adminCookie } });
    assert.equal(r.status, 200);
    assert.equal(r.body.keys.length, 4);
    for (const k of r.body.keys) {
      assert.ok(k.masked, 'masked present');
      assert.ok(!k.masked.includes('sk-'), 'masked must not reveal prefix');
    }
    const raw = JSON.stringify(r.body);
    for (const secret of ['sk-newpoolkey111', 'sk-batchA11111', 'sk-batchB22222', 'sk-batchC33333', legacyKey]) {
      assert.ok(!raw.includes(secret), `response must not contain ${secret.slice(0, 6)}...`);
    }
  });

  t.test('admin update key metadata (label/weight/status/rpm)', async () => {
    const keys = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}/keys`, headers: { Cookie: adminCookie } });
    const target = keys.body.keys[0];
    const r = await request(server.baseUrl, {
      method: 'PATCH', path: `/api/v2/ai-control/providers/${provId}/keys/${target.id}`, headers: { Cookie: adminCookie },
      body: { label: 'renamed', weight: 55, status: 'active', rpm: 10 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.key.label, 'renamed');
    assert.equal(r.body.key.weight, 55);
    assert.equal(r.body.key.rpm, 10);
    // disable
    const r2 = await request(server.baseUrl, {
      method: 'PATCH', path: `/api/v2/ai-control/providers/${provId}/keys/${target.id}`, headers: { Cookie: adminCookie },
      body: { status: 'disabled' },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.key.enabled, false);
  });

  t.test('admin key cooldown set/clear', async () => {
    const keys = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}/keys`, headers: { Cookie: adminCookie } });
    const target = keys.body.keys[0];
    const r = await request(server.baseUrl, {
      method: 'POST', path: `/api/v2/ai-control/providers/${provId}/keys/${target.id}/cooldown`, headers: { Cookie: adminCookie },
      body: { cooldownMs: 60000 },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.cooldown_until, 'cooldown_until set');
    const r2 = await request(server.baseUrl, {
      method: 'POST', path: `/api/v2/ai-control/providers/${provId}/keys/${target.id}/cooldown`, headers: { Cookie: adminCookie },
      body: { cooldownMs: 0 },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.cooldown_until, null, 'cooldown cleared');
  });

  t.test('provider optimistic-lock PATCH (name + revision)', async () => {
    const g = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}`, headers: { Cookie: adminCookie } });
    const rev = g.body.provider.revision;
    const r = await request(server.baseUrl, {
      method: 'PATCH', path: `/api/v2/ai-control/providers/${provId}`, headers: { Cookie: adminCookie },
      body: { name: 'V2 Agnes Renamed', revision: rev },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.name, 'V2 Agnes Renamed');
    assert.equal(r.body.revision, rev + 1);
    // stale revision → 409
    const r409 = await request(server.baseUrl, {
      method: 'PATCH', path: `/api/v2/ai-control/providers/${provId}`, headers: { Cookie: adminCookie },
      body: { name: 'stale', revision: rev },
    });
    assert.equal(r409.status, 409);
  });

  t.test('provider enable/disable', async () => {
    const g = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}`, headers: { Cookie: adminCookie } });
    const rev = g.body.provider.revision;
    const off = await request(server.baseUrl, {
      method: 'POST', path: `/api/v2/ai-control/providers/${provId}/enable`, headers: { Cookie: adminCookie },
      body: { enabled: false, revision: rev },
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.provider.enabled, false);
    const on = await request(server.baseUrl, {
      method: 'POST', path: `/api/v2/ai-control/providers/${provId}/enable`, headers: { Cookie: adminCookie },
      body: { enabled: true, revision: off.body.revision },
    });
    assert.equal(on.status, 200);
    assert.equal(on.body.provider.enabled, true);
  });

  t.test('legacy provider with NO pool key → LEGACY_FALLBACK; add pool key → POOL', async () => {
    const c = await request(server.baseUrl, {
      method: 'POST', path: '/api/v2/ai-control/providers', headers: { Cookie: adminCookie },
      body: { id: legacyProvId, name: 'Legacy Only', baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: legacyKey },
    });
    assert.equal(c.status, 201);
    let g = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${legacyProvId}`, headers: { Cookie: adminCookie } });
    assert.equal(g.body.provider.credential_source.source, 'LEGACY_FALLBACK');
    assert.equal(g.body.provider.credential_source.has_legacy_key, true);
    const a = await request(server.baseUrl, {
      method: 'POST', path: `/api/v2/ai-control/providers/${legacyProvId}/keys`, headers: { Cookie: adminCookie },
      body: { apiKey: 'sk-legacypromoted1' },
    });
    assert.equal(a.status, 201);
    g = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${legacyProvId}`, headers: { Cookie: adminCookie } });
    assert.equal(g.body.provider.credential_source.source, 'POOL');
    // legacy still visible alongside pool (B10: do not hide the fallback)
    assert.equal(g.body.provider.credential.has_legacy_key, true);
  });

  t.test('admin delete key', async () => {
    const keys = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}/keys`, headers: { Cookie: adminCookie } });
    const target = keys.body.keys[0];
    const r = await request(server.baseUrl, { method: 'DELETE', path: `/api/v2/ai-control/providers/${provId}/keys/${target.id}`, headers: { Cookie: adminCookie } });
    assert.equal(r.status, 200);
    const after = await request(server.baseUrl, { method: 'GET', path: `/api/v2/ai-control/providers/${provId}/keys`, headers: { Cookie: adminCookie } });
    assert.equal(after.body.keys.length, keys.body.keys.length - 1);
    const again = await request(server.baseUrl, { method: 'DELETE', path: `/api/v2/ai-control/providers/${provId}/keys/${target.id}`, headers: { Cookie: adminCookie } });
    assert.equal(again.status, 404);
  });

  t.test('placeholder/short apiKey rejected on create', async () => {
    const r = await request(server.baseUrl, {
      method: 'POST', path: '/api/v2/ai-control/providers', headers: { Cookie: adminCookie },
      body: { id: 'v2provph' + Date.now().toString(36), name: 'PH', baseUrl: 'https://x', apiKey: '***' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.provider.credential.has_legacy_key, false, 'placeholder key stored as empty');
  });
});
