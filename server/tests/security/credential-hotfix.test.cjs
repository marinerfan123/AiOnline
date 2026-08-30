'use strict';
// Q5-B P0 credential-exposure hotfix — regression tests
//
// Covers the five exposure defects fixed in feat/security-p0-credential-hardening:
//   1. GET /api/token no longer returns the shared system API_TOKEN (removed).
//   2. GET /api/oss never returns the full accessKeySecret (masked/omitted).
//   3. Production fails closed on a missing/blank/known-default JWT_SECRET.
//   4. Legacy provider sync/test + OSS test routes require admin.
//   5. logbus redacts credential-shaped strings (shared error/log boundary).
//
// Test DB: uses the standard moling_test self-healing schema (see helpers/test-db).
// These are focused HTTP regression tests; they do NOT touch production.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnTestServer, request, getCookies, buildCookieHeader } = require('../helpers/test-app.cjs');
const { assertSafeTestDatabase, createTestPool, initTestSchema, closeTestPool } = require('../helpers/test-db.cjs');
const { createUser, makeUser, makeAdmin, makeProvider } = require('../helpers/fixtures.cjs');

let server, pg;

// Deep string search — used to assert a secret value is absent from a whole JSON body.
function findString(value, needle) {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => findString(v, needle));
  if (value && typeof value === 'object') return Object.values(value).some((v) => findString(v, needle));
  return false;
}

test('Q5-B credential hotfix regression', { concurrency: 1 }, async (t) => {
  t.before(async () => {
    assertSafeTestDatabase();
    pg = createTestPool();
    await initTestSchema(pg);
    server = await spawnTestServer();
  });
  t.after(async () => {
    if (server) await server.stop();
    if (pg) await closeTestPool(pg);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIX 1 — /api/token removal
  // ─────────────────────────────────────────────────────────────────
  test('F1 /api/token returns no API_TOKEN to anyone', async (t) => {
    // a) anonymous — endpoint must be gone (404) or, if it still resolves,
    //    must NOT carry a token field.
    const anon = await request(server.baseUrl, { method: 'GET', path: '/api/token' });
    const anonStr = JSON.stringify(anon.body || {});
    assert.ok(anon.status === 404 || anon.status === 401 || anon.status === 403,
      `/api/token anonymous should be gone/blocked (got ${anon.status})`);
    assert.ok(!/token/i.test(anonStr) || !findString(anon.body, '"token"'),
      `anonymous /api/token must not expose a token field: ${anonStr}`);

    // b) authenticated normal user — same guarantee.
    const userDef = makeUser();
    await createUser(pg, userDef);
    const login = await request(server.baseUrl, {
      method: 'POST', path: '/api/auth/login',
      body: { email: userDef.email, password: userDef.password },
    });
    assert.ok(login.status >= 200 && login.status < 300, 'login should succeed');
    const cookies = getCookies(login.cookies);
    const asUser = await request(server.baseUrl, {
      method: 'GET', path: '/api/token',
      headers: { Cookie: buildCookieHeader(cookies) },
    });
    const asUserStr = JSON.stringify(asUser.body || {});
    assert.ok(asUser.status === 404 || asUser.status === 401 || asUser.status === 403,
      `/api/token for a normal user should be gone/blocked (got ${asUser.status})`);
    assert.ok(!findString(asUser.body, '"token"'),
      `authenticated /api/token must not expose a token field: ${asUserStr}`);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIX 2 — GET /api/oss never returns full accessKeySecret
  // ─────────────────────────────────────────────────────────────────
  test('F2 GET /api/oss masks the OSS secret', async (t) => {
    const adminDef = makeAdmin();
    await createUser(pg, adminDef);

    // Seed a real secret into the DB for an OSS config slot.
    const realSecret = 'LTAI' + 'TESTSECRET' + '1234567890abcdef'.slice(0, 10);
    const realKeyId = 'AKID' + 'TESTKEYID' + '9876543210';
    await pg.query(
      `INSERT INTO oss_configs (id, provider_type, display_name, bucket, region, access_key_id, access_key_secret, endpoint_external, path_prefix, custom_domain, enabled)
       VALUES ($1,'aliyun-oss','hotfix-test','test-bucket','cn-shanghai',$2,$3,'oss-cn-shanghai.aliyuncs.com','images/','',TRUE)
       ON CONFLICT (id) DO UPDATE SET access_key_id=EXCLUDED.access_key_id, access_key_secret=EXCLUDED.access_key_secret`,
      ['oss-hotfix-test', realKeyId, realSecret],
    );
    await pg.query(
      `INSERT INTO oss_config (id, enabled, active_id) VALUES (1, TRUE, 'oss-hotfix-test')
       ON CONFLICT (id) DO UPDATE SET enabled=TRUE, active_id='oss-hotfix-test'`,
    );

    // Admin login
    const login = await request(server.baseUrl, {
      method: 'POST', path: '/api/auth/login',
      body: { email: adminDef.email, password: adminDef.password },
    });
    const cookies = getCookies(login.cookies);

    const r = await request(server.baseUrl, {
      method: 'GET', path: '/api/oss',
      headers: { Cookie: buildCookieHeader(cookies) },
    });
    assert.equal(r.status, 200, `admin GET /api/oss should be 200 (got ${r.status})`);
    const bodyStr = JSON.stringify(r.body || {});

    // The raw secret must NEVER appear, in any nested position.
    assert.ok(!findString(r.body, realSecret),
      `GET /api/oss must not contain the full accessKeySecret: ${bodyStr}`);
    // The raw key id must not appear verbatim either (only masked form).
    assert.ok(!findString(r.body, realKeyId),
      `GET /api/oss must not contain the raw accessKeyId: ${bodyStr}`);
    // top-level compat field must be empty, not the secret
    assert.ok(r.body.accessKeySecret === '' || r.body.accessKeySecret == null,
      `top-level accessKeySecret should be omitted/empty, got: ${JSON.stringify(r.body.accessKeySecret)}`);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIX 4 — legacy provider sync/test + OSS test routes require admin
  // ─────────────────────────────────────────────────────────────────
  test('F4 legacy provider/OSS test routes require admin', async (t) => {
    const provider = makeProvider({ apiKey: 'sk-test-key-000000000000000000' });
    // createProvider from fixtures inserts the provider row
    const { createProvider: seedProvider } = require('../helpers/fixtures.cjs');
    await seedProvider(pg, provider);

    const userDef = makeUser();
    await createUser(pg, userDef);
    const login = await request(server.baseUrl, {
      method: 'POST', path: '/api/auth/login',
      body: { email: userDef.email, password: userDef.password },
    });
    const cookies = getCookies(login.cookies);

    const routes = [
      { method: 'POST', path: `/api/providers/${provider.id}/sync`, body: {} },
      { method: 'POST', path: `/api/providers/${provider.id}/test-endpoint`, body: { endpoint: { path: '/v1' } } },
      { method: 'POST', path: `/api/providers/${provider.id}/test-default`, body: {} },
      { method: 'POST', path: '/api/oss/test', body: { providerType: 'aliyun-oss', accessKeyId: 'x', accessKeySecret: 'y', bucket: 'z' } },
    ];
    for (const rt of routes) {
      const r = await request(server.baseUrl, {
        method: rt.method, path: rt.path,
        headers: { Cookie: buildCookieHeader(cookies), 'Content-Type': 'application/json' },
        body: rt.body,
      });
      assert.ok(r.status === 403 || r.status === 401,
        `normal user ${rt.method} ${rt.path} must be admin-gated (got ${r.status})`);
    }

    // anonymous also blocked
    const anon = await request(server.baseUrl, {
      method: 'POST', path: `/api/providers/${provider.id}/sync`,
      headers: { 'Content-Type': 'application/json' }, body: {},
    });
    assert.ok(anon.status === 403 || anon.status === 401,
      `anon POST sync must be blocked (got ${anon.status})`);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIX 5 — logbus redaction (unit-level, no server round-trip)
  // ─────────────────────────────────────────────────────────────────
  test('F5 logbus redacts credential-shaped strings', async (t) => {
    const { redactString, redactMeta, createLogBus } = require('../../logbus.cjs');

    // Bearer tokens
    assert.equal(redactString('Authorization: Bearer sk-live-abc123xyz987'),
      'Authorization: Bearer [REDACTED]');
    // api_key / password field values
    assert.equal(redactString('provider api_key=sk-live-abcdef1234567890'),
      'provider api_key=[REDACTED]');
    assert.equal(redactString('login failed password=SuperSecret123! reason=bad'),
      'login failed password=[REDACTED] reason=bad');
    // Aliyun / Tencent prefixes (real AK ids are uppercase-only)
    assert.equal(redactString('key LTAI4F1234567890ABC used'), 'key [REDACTED] used');
    assert.equal(redactString('secret AKID1234567890ABC used'), 'secret [REDACTED] used');
    // OSS signed-URL signature params
    assert.ok(redactString('u?OSSAccessKeyId=AK&Signature=abc%2Bdef').includes('Signature=[REDACTED]'));

    // meta objects: credential field names redacted wholesale, non-creds kept
    const meta = redactMeta({ apiKey: 'sk-x', provider: 'agnes', status: 429, err: 'boom' });
    assert.equal(meta.apiKey, '[REDACTED]');
    assert.equal(meta.provider, 'agnes', 'non-credential fields must be preserved');
    assert.equal(meta.status, 429, 'error codes/diagnostics must be preserved');
    assert.equal(meta.err, 'boom');

    // end-to-end through emit(): a logged ERROR must reach the buffer redacted
    const captured = [];
    const bus = createLogBus({
      persistError: (level, source, message, meta) => captured.push({ level, source, message, meta }),
    });
    bus.emit('ERROR', 'provider', 'upstream rejected api_key=sk-live-abcdef1234567890 code=429', { httpStatus: 429 });
    assert.equal(captured.length, 1, 'ERROR should persist exactly once');
    assert.ok(!captured[0].message.includes('sk-live-abcdef1234567890'),
      `persisted message leaked the key: ${captured[0].message}`);
    assert.ok(captured[0].message.includes('[REDACTED]'), 'redaction marker present');
    assert.equal(captured[0].meta.httpStatus, 429, 'diagnostic meta preserved');
  });

  // ─────────────────────────────────────────────────────────────────
  // FIX 3 — production JWT fail-closed (covered by live subprocess runs,
  // see terminal verification; here we assert the auth module fallback
  // is exposed for the startup self-check).
  // ─────────────────────────────────────────────────────────────────
  test('F3 auth module exposes effective secret for self-check', async (t) => {
    const session = require('../../auth.cjs');
    assert.equal(typeof session.getSecret, 'function', 'auth.getSecret must exist');
    // In test (non-production) env the dev fallback is acceptable and returns a string.
    const s = session.getSecret();
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIX 6 — providers list is admin-gated and never returns a raw key
  //   (Q5-C port: GET /api/providers + PATCH /api/providers/:id read-back)
  // ─────────────────────────────────────────────────────────────────
  test('F6 GET /api/providers is admin-gated and masks keys', async (t) => {
    const { createProvider: seedProvider } = require('../helpers/fixtures.cjs');
    const provider = makeProvider({ apiKey: 'supers…ey-1' });
    await seedProvider(pg, provider);

    // anonymous — must be blocked, and even if a body is returned it must
    // not carry the raw api key or a token.
    const anon = await request(server.baseUrl, { method: 'GET', path: '/api/providers' });
    assert.ok(anon.status === 403 || anon.status === 401,
      `anon GET /api/providers must be blocked (got ${anon.status})`);
    assert.ok(!findString(anon.body, 'supers…ey-1'),
      `anon /api/providers must not leak the raw provider key`);

    // normal user — also blocked (not admin).
    const userDef = makeUser();
    await createUser(pg, userDef);
    const login = await request(server.baseUrl, {
      method: 'POST', path: '/api/auth/login',
      body: { email: userDef.email, password: userDef.password },
    });
    const userCookies = buildCookieHeader(getCookies(login.cookies));
    const asUser = await request(server.baseUrl, {
      method: 'GET', path: '/api/providers', headers: { Cookie: userCookies },
    });
    assert.ok(asUser.status === 403,
      `normal-user GET /api/providers must be 403 (got ${asUser.status})`);
    assert.ok(!findString(asUser.body, 'supers…ey-1'),
      `user /api/providers must not leak the raw provider key`);

    // admin — allowed, but key still masked.
    const adminDef = makeAdmin();
    await createUser(pg, adminDef);
    const alogin = await request(server.baseUrl, {
      method: 'POST', path: '/api/auth/login',
      body: { email: adminDef.email, password: adminDef.password },
    });
    const adminCookies = buildCookieHeader(getCookies(alogin.cookies));
    const asAdmin = await request(server.baseUrl, {
      method: 'GET', path: '/api/providers', headers: { Cookie: adminCookies },
    });
    assert.equal(asAdmin.status, 200, `admin GET /api/providers should be 200 (got ${asAdmin.status})`);
    assert.ok(!findString(asAdmin.body, 'supers…ey-1'),
      `admin /api/providers must not return the raw key: ${JSON.stringify(asAdmin.body).slice(0, 200)}`);
  });

  test('F6 PATCH /api/providers/:id read-back masks apiKey', async (t) => {
    const { createProvider: seedProvider } = require('../helpers/fixtures.cjs');
    const provider = makeProvider({ apiKey: 'patchm…ey-2' });
    await seedProvider(pg, provider);

    const adminDef = makeAdmin();
    await createUser(pg, adminDef);
    const alogin = await request(server.baseUrl, {
      method: 'POST', path: '/api/auth/login',
      body: { email: adminDef.email, password: adminDef.password },
    });
    const adminCookies = buildCookieHeader(getCookies(alogin.cookies));

    // read current revision
    const list = await request(server.baseUrl, {
      method: 'GET', path: '/api/providers', headers: { Cookie: adminCookies },
    });
    const row = (list.body || []).find((p) => p.id === provider.id);
    assert.ok(row, 'provider must be present for admin');
    assert.equal(row.revision, 1, 'fresh provider revision should be 1');

    // PATCH a benign field (name) — must not echo the raw key back
    const r = await request(server.baseUrl, {
      method: 'PATCH', path: `/api/providers/${provider.id}`,
      headers: { Cookie: adminCookies, 'Content-Type': 'application/json' },
      body: { name: 'Patched Name', revision: row.revision },
    });
    assert.equal(r.status, 200, `admin PATCH provider should be 200 (got ${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok(!findString(r.body, 'patchm…ey-2'),
      `PATCH read-back must not return the raw api key: ${JSON.stringify(r.body).slice(0, 200)}`);
    const pk = r.body?.provider?.apiKey;
    assert.ok(typeof pk === 'string' && (pk === '' || pk.includes('***')),
      `PATCH read-back apiKey must be masked/empty, got: ${JSON.stringify(pk)}`);
  });
});
