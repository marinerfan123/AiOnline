'use strict';
/**
 * 0067 Quota Scope + Certification — 真实 PostgreSQL 表约束 / FK / 联读字段 验证。
 * 运行：QUOTA_CERT_PG_PORT=<port> node --test server/modules/modelhub/quota-cert-table.test.cjs
 *
 * 连接配置（均可用 QUOTA_CERT_PG_* 覆盖，回退 TEST_PG_* / PG_*）：
 *   - 目标集群需 trust 或密码可达（连 postgres 维护库建 throwaway DB 后应用 0001 + 0067）。
 *   - 若集群不可达或无权建库 → 测试 SKIP（绝不硬失败，也不虚报 PASS）。
 *
 * 覆盖：表存在性 / kind CHECK / fidelity_class CHECK / cert_status CHECK /
 *   UNIQUE(provider_id, scope_code) / UNIQUE(provider_id, model_code) /
 *   provider_model_bindings.quota_scope_id + cert_id 列 + FK 强制 + ON DELETE SET NULL /
 *   capacity NOT NULL 默认 '{}'。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const HOST = process.env.QUOTA_CERT_PG_HOST || process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const PORT = Number(process.env.QUOTA_CERT_PG_PORT || process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const USER = process.env.QUOTA_CERT_PG_USER || process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const PASS = process.env.QUOTA_CERT_PG_PASSWORD || process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '';

const MIG_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');
const M0001 = fs.readFileSync(path.join(MIG_DIR, '0001_baseline_legacy_schema.sql'), 'utf8');
const M0067 = fs.readFileSync(path.join(MIG_DIR, '0067_quota_cert.sql'), 'utf8');

let reachable = null;

async function canReach() {
  const admin = new Pool({ host: HOST, port: PORT, user: USER, password: PASS, database: 'postgres', max: 1 });
  try {
    await admin.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e.message };
  } finally {
    await admin.end().catch(() => {});
  }
}

async function expectErr(pg, fn, code) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, `expected an error (${code}) but none thrown`);
  if (code) assert.strictEqual(threw.code, code, `expected SQLSTATE ${code}, got ${threw.code}: ${threw.message}`);
  return threw;
}

test('0067 表约束 / FK / 绑定联读字段（真实 PG）', async (t) => {
  if (reachable === null) reachable = await canReach();
  if (!reachable.ok) {
    t.skip(`no reachable PostgreSQL at ${HOST}:${PORT} (${reachable.err})`);
    return;
  }

  const dbName = `quota_cert_0067_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Pool({ host: HOST, port: PORT, user: USER, password: PASS, database: 'postgres', max: 1 });
  let pg;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } catch (e) {
    await admin.end().catch(() => {});
    t.skip(`cannot create throwaway DB (${e.message})`);
    return;
  }
  await admin.end();

  pg = new Pool({ host: HOST, port: PORT, user: USER, password: PASS, database: dbName, max: 2 });
  try {
    await pg.query(M0001);
    await pg.query(M0067);

    // ── 表存在性 ──
    const tbl = await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('provider_quota_scopes','provider_certifications') ORDER BY table_name`,
    );
    assert.deepStrictEqual(tbl.rows.map((r) => r.table_name), ['provider_certifications', 'provider_quota_scopes']);

    // ── kind CHECK（global/endpoint/model/operation）──
    await pg.query(`INSERT INTO providers (id, name) VALUES ('p1', 'P1')`);
    await pg.query(`INSERT INTO provider_quota_scopes (scope_id, provider_id, scope_code, kind, capacity)
                    VALUES ('qs-1', 'p1', 'acct', 'model', '{"limit_type":"DAILY_REQUESTS"}'::jsonb)`);
    await expectErr(pg, () => pg.query(
      `INSERT INTO provider_quota_scopes (scope_id, provider_id, scope_code, kind) VALUES ('qs-x', 'p1', 'x', 'bogus')`,
    ), '23514'); // check_violation
    const kinds = await pg.query(`SELECT kind FROM provider_quota_scopes WHERE scope_id='qs-1'`);
    assert.strictEqual(kinds.rows[0].kind, 'model');

    // ── UNIQUE(provider_id, scope_code) ──
    await expectErr(pg, () => pg.query(
      `INSERT INTO provider_quota_scopes (scope_id, provider_id, scope_code, kind) VALUES ('qs-2', 'p1', 'acct', 'global')`,
    ), '23505'); // unique_violation

    // ── capacity NOT NULL 默认 '{}' ──
    const cap = await pg.query(`SELECT capacity FROM provider_quota_scopes WHERE scope_id='qs-1'`);
    assert.deepStrictEqual(cap.rows[0].capacity, { limit_type: 'DAILY_REQUESTS' });

    // ── fidelity_class CHECK（EXACT/COMPATIBLE/SIMILAR/UNKNOWN）──
    await pg.query(`INSERT INTO provider_certifications (cert_id, provider_id, model_code, fidelity_class, cert_status)
                    VALUES ('cert-1', 'p1', 'veo3.1', 'EXACT', 'certified')`);
    await expectErr(pg, () => pg.query(
      `INSERT INTO provider_certifications (cert_id, provider_id, fidelity_class) VALUES ('cert-x', 'p1', 'PARTIAL')`,
    ), '23514');

    // ── cert_status CHECK（uncertified/certified/revoked）──
    await expectErr(pg, () => pg.query(
      `INSERT INTO provider_certifications (cert_id, provider_id, fidelity_class, cert_status) VALUES ('cert-y', 'p1', 'EXACT', 'drifting')`,
    ), '23514');

    // ── UNIQUE(provider_id, model_code) ──
    await expectErr(pg, () => pg.query(
      `INSERT INTO provider_certifications (cert_id, provider_id, model_code, fidelity_class, cert_status) VALUES ('cert-2', 'p1', 'veo3.1', 'COMPATIBLE', 'certified')`,
    ), '23505');

    // ── provider_model_bindings 扩展列存在 + FK 强制 ──
    const pmbCols = await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name IN ('quota_scope_id','cert_id') ORDER BY column_name`,
    );
    assert.deepStrictEqual(pmbCols.rows.map((r) => r.column_name), ['cert_id', 'quota_scope_id']);

    await expectErr(pg, () => pg.query(
      `INSERT INTO provider_model_bindings (model_id, provider_id, quota_scope_id) VALUES ('m1', 'p1', 'qs-nope')`,
    ), '23503'); // foreign_key_violation

    // 有效引用 → 成功
    await pg.query(
      `INSERT INTO provider_model_bindings (model_id, provider_id, quota_scope_id, cert_id) VALUES ('m1', 'p1', 'qs-1', 'cert-1')`,
    );
    const b = await pg.query(`SELECT quota_scope_id, cert_id FROM provider_model_bindings WHERE model_id='m1'`);
    assert.strictEqual(b.rows[0].quota_scope_id, 'qs-1');
    assert.strictEqual(b.rows[0].cert_id, 'cert-1');

    // ── ON DELETE SET NULL：删 scope → 绑定引用置空（不级联删绑定）──
    await pg.query(`DELETE FROM provider_quota_scopes WHERE scope_id='qs-1'`);
    const b2 = await pg.query(`SELECT quota_scope_id, cert_id FROM provider_model_bindings WHERE model_id='m1'`);
    assert.strictEqual(b2.rows[0].quota_scope_id, null);
    assert.strictEqual(b2.rows[0].cert_id, 'cert-1'); // cert 未删，不受影响
  } finally {
    await pg.end().catch(() => {});
    const cleanup = new Pool({ host: HOST, port: PORT, user: USER, password: PASS, database: 'postgres', max: 1 });
    await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]).catch(() => {});
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
    await cleanup.end().catch(() => {});
  }
}, { timeout: 60000 });
