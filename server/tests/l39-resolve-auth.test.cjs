'use strict';
/**
 * L39 — Resolve / dry-run HTTP 集成测试（鉴权挂载 + 成功信封 + 候选空，真库真服务器）。
 * 运行（需本地 PG，默认 5433，可 TEST_PG_PORT 覆盖）：
 *   TEST_PG_PORT=5433 TEST_PG_PASSWORD='0.0.1abcd' PG_HOST=127.0.0.1 \
 *     node --test --test-concurrency=1 server/tests/l39-resolve-auth.test.cjs
 *
 * 覆盖：
 *   1) 鉴权挂载：未鉴权 POST /api/v2/generation/resolve → 401（appGateway 拦截）
 *   2) 成功信封：鉴权后 → 200 {ok:true, decision:{model,binding,score,reasons}}
 *   3) 候选空：mediaType 无匹配 → 200 {ok:false, code:NO_ROUTABLE_MODEL}
 */
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { spawnTestServer, request, getCookies, buildCookieHeader } = require('./helpers/test-app.cjs');

const REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS logical_models (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, media_type TEXT NOT NULL,
    display_name TEXT NOT NULL, vendor_family TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS model_revisions (
    id TEXT PRIMARY KEY, logical_model_id TEXT NOT NULL, revision_code TEXT NOT NULL,
    upstream_vendor TEXT, upstream_model_family TEXT, released_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'ACTIVE', metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS model_operations (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, media_type TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'ATOMIC', display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE');
  CREATE TABLE IF NOT EXISTS model_operation_revisions (
    id TEXT PRIMARY KEY, model_revision_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    revision INTEGER NOT NULL, input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_schema JSONB NOT NULL DEFAULT '{}'::jsonb, ui_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    semantic_map JSONB NOT NULL DEFAULT '{}'::jsonb, capability_descriptor JSONB NOT NULL DEFAULT '{}'::jsonb,
    schema_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), activated_at TIMESTAMPTZ);
`;

/** 幂等播种：建 registry 表 + 清旧种子 + 插入可路由候选（1 logical model + 1 binding）。 */
async function seedRegistry(pg) {
  await pg.query(REGISTRY_DDL);
  await pg.query(`
    DELETE FROM model_operation_revisions WHERE model_revision_id = 'mr-resolve-1';
    DELETE FROM model_revisions WHERE id = 'mr-resolve-1';
    DELETE FROM model_operations WHERE id = 'mo-resolve-t2v';
    DELETE FROM logical_models WHERE id = 'lm-resolve-1';
    DELETE FROM provider_model_bindings WHERE model_id = 'video.test-resolve-1';
    DELETE FROM models WHERE model_id = 'video.test-resolve-1';
    DELETE FROM providers WHERE id = 'prov-resolve-1';
  `);
  await pg.query(`
    INSERT INTO providers (id, name, type, base_url, api_key, enabled)
      VALUES ('prov-resolve-1', 'ResolveTestProvider', 'official', 'https://example.com/v1', 'sk-resolve-123456', TRUE);
    INSERT INTO models (id, model_id, display_name, type, provider_id, enabled, credit_cost)
      VALUES ('m-resolve-1', 'video.test-resolve-1', 'Resolve Test Model', 'video', 'prov-resolve-1', TRUE, 1);
    INSERT INTO provider_model_bindings (id, model_id, provider_id, upstream_model_name, enabled, priority, weight)
      VALUES ('pmb-resolve-1', 'video.test-resolve-1', 'prov-resolve-1', 'video.test-resolve-1', TRUE, 0, 0);
    INSERT INTO logical_models (id, code, media_type, display_name, vendor_family, status)
      VALUES ('lm-resolve-1', 'video.test-resolve-1', 'video', 'Resolve Test Model', 'test', 'ACTIVE');
    INSERT INTO model_revisions (id, logical_model_id, revision_code, upstream_vendor, upstream_model_family, status, metadata)
      VALUES ('mr-resolve-1', 'lm-resolve-1', 'v1', 'test', 'test', 'ACTIVE',
              '{"quality":0.9,"reliability":0.9,"cost":1,"latencyMs":500}'::jsonb);
    INSERT INTO model_operations (id, code, media_type, kind, display_name, status)
      VALUES ('mo-resolve-t2v', 'video.text_to_video', 'video', 'ATOMIC', 'Text to Video', 'ACTIVE');
    INSERT INTO model_operation_revisions (id, model_revision_id, operation_id, revision, input_schema, schema_hash, status)
      VALUES ('mor-resolve-1', 'mr-resolve-1', 'mo-resolve-t2v', 1,
              '{"type":"object","properties":{"prompt":{"type":"string"}}}'::jsonb, 'test-hash', 'ACTIVE');
  `);
}

async function newAuthCookie(baseUrl) {
  const email = `res${Date.now()}${Math.floor(Math.random() * 1e6)}@t.com`;
  await request(baseUrl, { method: 'POST', path: '/api/auth/register', body: { email, password: 'TestPass123!' } });
  const lr = await request(baseUrl, { method: 'POST', path: '/api/auth/login', body: { email, password: 'TestPass123!' } });
  return buildCookieHeader(getCookies(lr.cookies));
}

let server, pg;

before(async () => {
  pg = new Pool({
    host: process.env.TEST_PG_HOST || process.env.PG_HOST || '127.0.0.1',
    port: Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5433'),
    database: process.env.TEST_PG_DATABASE || process.env.PG_DATABASE || 'moling_test',
    user: process.env.TEST_PG_USER || process.env.PG_USER || 'postgres',
    password: process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd',
    max: 2,
  });
  await seedRegistry(pg);
  server = await spawnTestServer();
});

after(async () => {
  if (server) await server.stop();
  if (pg) {
    // 清理本测试播种的种子数据（唯一 ID），避免污染共享测试库
    await pg.query(`
      DELETE FROM model_operation_revisions WHERE model_revision_id = 'mr-resolve-1';
      DELETE FROM model_revisions WHERE id = 'mr-resolve-1';
      DELETE FROM model_operations WHERE id = 'mo-resolve-t2v';
      DELETE FROM logical_models WHERE id = 'lm-resolve-1';
      DELETE FROM provider_model_bindings WHERE model_id = 'video.test-resolve-1';
      DELETE FROM models WHERE model_id = 'video.test-resolve-1';
      DELETE FROM providers WHERE id = 'prov-resolve-1';
    `).catch(() => {});
    await pg.end();
  }
});

test('鉴权挂载：未鉴权 POST /api/v2/generation/resolve → 401', async () => {
  const r = await request(server.baseUrl, {
    method: 'POST', path: '/api/v2/generation/resolve',
    body: { mediaType: 'video', operationCode: 'video.text_to_video' },
  });
  assert.equal(r.status, 401);
});

test('成功信封：鉴权后 → 200 {ok:true, decision{model,binding,score,reasons}}', async () => {
  const cookie = await newAuthCookie(server.baseUrl);
  const r = await request(server.baseUrl, {
    method: 'POST', path: '/api/v2/generation/resolve', headers: { Cookie: cookie },
    body: { mediaType: 'video', operationCode: 'video.text_to_video' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.decision && r.body.decision.model, 'decision.model 存在');
  assert.equal(r.body.decision.model.logicalModelCode, 'video.test-resolve-1');
  assert.ok(r.body.decision.binding, 'decision.binding 存在');
  assert.equal(r.body.decision.binding.bindingId, 'pmb-resolve-1');
  assert.ok(typeof r.body.decision.score === 'number');
  assert.ok(Array.isArray(r.body.decision.reasons) && r.body.decision.reasons.length > 0);
});

test('候选空：mediaType 无匹配 → 200 {ok:false, code:NO_ROUTABLE_MODEL}', async () => {
  const cookie = await newAuthCookie(server.baseUrl);
  const r = await request(server.baseUrl, {
    method: 'POST', path: '/api/v2/generation/resolve', headers: { Cookie: cookie },
    body: { mediaType: 'audio', operationCode: 'audio.tts' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'NO_ROUTABLE_MODEL');
  assert.ok(Array.isArray(r.body.decision.reasons) && r.body.decision.reasons.length > 0);
});
