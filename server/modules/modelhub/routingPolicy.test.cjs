'use strict';
/**
 * L40 (G11) — Routing Policy 版本化 + 决策快照 tests (§34/§35).
 *
 * 纯单元（无 DB）: 快照不可变 / recordRoutingDecision SQL / listByVersion。
 * DB 集成: 0068 迁移产物 + 策略激活版本唯一 / 快照不可变(触发器) / 决策落 audit。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');

const {
  buildPolicySnapshot,
  recordRoutingDecision,
  listByVersion,
} = require('./routingAudit.cjs');
const { migrate } = require('../../db/migrate.cjs');

// ── 纯单元测试（无 DB 依赖） ────────────────────────────────────────────────

test('buildPolicySnapshot: shape {policyVersion,model,binding,score,reasons[]}', () => {
  const s = buildPolicySnapshot({ policyVersion: 3, model: 'kling-x', binding: 'b-1', score: 0.82, reasons: ['score:0.82'] });
  assert.equal(s.policyVersion, 3);
  assert.equal(s.model, 'kling-x');
  assert.equal(s.binding, 'b-1');
  assert.equal(s.score, 0.82);
  assert.deepEqual(s.reasons, ['score:0.82']);
});

test('buildPolicySnapshot: frozen (runtime mutation forbidden)', () => {
  const s = buildPolicySnapshot({ policyVersion: 1, model: 'm', binding: 'b', score: 0.5, reasons: ['r'] });
  assert.equal(Object.isFrozen(s), true, 'snapshot must be frozen');
  assert.throws(() => { 'use strict'; s.model = 'hacked'; }, TypeError);
});

test('buildPolicySnapshot: deep-copies reasons (input array not aliased)', () => {
  const reasons = ['a'];
  const s = buildPolicySnapshot({ policyVersion: 1, reasons });
  reasons.push('b');
  assert.deepEqual(s.reasons, ['a']);
  assert.deepEqual(s.reasons, Object.freeze(['a']));
});

test('buildPolicySnapshot: throws without policyVersion', () => {
  assert.throws(() => buildPolicySnapshot({ model: 'm' }), /policyVersion required/);
});

test('buildPolicySnapshot: non-finite / undefined score → null (safe)', () => {
  assert.equal(buildPolicySnapshot({ policyVersion: 1, score: -Infinity }).score, null);
  assert.equal(buildPolicySnapshot({ policyVersion: 1, score: undefined }).score, null);
  assert.equal(buildPolicySnapshot({ policyVersion: 1, score: 0 }).score, 0);
});

test('recordRoutingDecision: INSERT-only into ai_routing_decisions with policy_snapshot', async () => {
  let sql = '';
  const client = { query: async (s) => { sql = s; return { rows: [] }; } };
  const id = await recordRoutingDecision(client, {
    modelId: 'm1', selectedBindingId: 'b1', selectedProviderId: 'p1',
    policySnapshot: { policyVersion: 2, model: 'm1', binding: 'b1', score: 0.9, reasons: ['score:0.90'] },
  });
  assert.ok(id.startsWith('rd-'));
  assert.ok(sql.includes('INSERT INTO ai_routing_decisions'), 'must insert into ai_routing_decisions (0010)');
  assert.ok(sql.includes('policy_snapshot'), 'must persist policy_snapshot');
  assert.ok(!/update/i.test(sql), 'no UPDATE path — history is insert-only');
  assert.ok(!sql.toLowerCase().includes('commit'), 'no COMMIT (caller transaction)');
});

test('listByVersion: filters ai_routing_decisions by snapshot policyVersion', async () => {
  let sql = '';
  let params = null;
  const client = { query: async (s, p) => { sql = s; params = p; return { rows: [{ id: 'rd-x' }] }; } };
  const rows = await listByVersion(client, 7);
  assert.deepEqual(rows, [{ id: 'rd-x' }]);
  assert.ok(sql.includes("policy_snapshot->>'policyVersion'"), 'must filter on snapshot policyVersion');
  assert.deepEqual(params, ['7']);
});

// ── DB 集成测试（真实 Postgres，经迁移链） ───────────────────────────────────

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = process.env.TEST_PG_PORT || process.env.PG_PORT || '5432';
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';

function adminPool() {
  return new Pool({ host: pgHost, port: Number(pgPort), user: pgUser, password: pgPass, database: 'postgres', max: 1 });
}

describe('routing policy DB invariants (0068)', () => {
  let admin;
  let pg;
  let dbName;

  before(async () => {
    admin = adminPool();
    dbName = `moling_rp_test_${crypto.randomBytes(4).toString('hex')}`;
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await admin.query('DROP DATABASE IF EXISTS ' + dbName);
    await admin.query('CREATE DATABASE ' + dbName);
    pg = new Pool({ host: pgHost, port: Number(pgPort), user: pgUser, password: pgPass, database: dbName, max: 1 });
    const result = await migrate(pg);
    assert.ok(result.applied > 0, 'migrations should apply');
  });

  after(async () => {
    try { await pg.end(); } catch (_) {}
    try {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
      await admin.query('DROP DATABASE IF EXISTS ' + dbName);
    } catch (_) {}
    try { await admin.end(); } catch (_) {}
  });

  test('0068: routing_policies 表 + ai_routing_decisions.policy_snapshot 列存在', async () => {
    const t = await pg.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'routing_policies'`);
    assert.equal(t.rows.length, 1, 'routing_policies should exist');
    const c = await pg.query(`SELECT 1 FROM information_schema.columns WHERE table_name='ai_routing_decisions' AND column_name='policy_snapshot'`);
    assert.equal(c.rows.length, 1, 'policy_snapshot column should exist');
  });

  test('策略激活版本唯一：同 policy_id 仅一个 active，跨 policy_id 可并存', async () => {
    await pg.query(`INSERT INTO routing_policies (policy_id, policy_version, media_type, rules, status) VALUES ('auto-video-router', 1, 'video', '[]'::jsonb, 'active')`);
    await pg.query(`INSERT INTO routing_policies (policy_id, policy_version, media_type, rules, status) VALUES ('auto-video-router', 2, 'video', '[]'::jsonb, 'deprecated')`);
    // 第二个 active（同 policy_id）违反部分唯一索引
    await assert.rejects(
      pg.query(`INSERT INTO routing_policies (policy_id, policy_version, media_type, rules, status) VALUES ('auto-video-router', 3, 'video', '[]'::jsonb, 'active')`),
      /uq_routing_policies_active|duplicate key/i,
    );
    // 不同 policy_id 的 active 可并存
    await pg.query(`INSERT INTO routing_policies (policy_id, policy_version, media_type, rules, status) VALUES ('image-router', 4, 'image', '[]'::jsonb, 'active')`);
    // policy_version 全局唯一（PK）
    await assert.rejects(
      pg.query(`INSERT INTO routing_policies (policy_id, policy_version, status) VALUES ('image-router', 4, 'draft')`),
      /duplicate key/i,
    );
  });

  test('快照不可变：UPDATE policy_snapshot 被触发器拒绝', async () => {
    const id = `rd-${crypto.randomBytes(8).toString('hex')}`;
    await pg.query(
      `INSERT INTO ai_routing_decisions (id, model_id, policy_snapshot) VALUES ($1,$2,$3::jsonb)`,
      [id, 'm1', JSON.stringify({ policyVersion: 9, model: 'm1', binding: 'b1', score: 0.9, reasons: ['score:0.90'] })],
    );
    await assert.rejects(
      pg.query(`UPDATE ai_routing_decisions SET policy_snapshot = '{"policyVersion":10}'::jsonb WHERE id = $1`, [id]),
      /immutable/i,
    );
    // 不改快照列的更新仍允许（其它列无快照约束）
    await pg.query(`UPDATE ai_routing_decisions SET reason = 'updated' WHERE id = $1`, [id]);
  });

  test('决策落 audit：recordRoutingDecision 落库 + listByVersion 回溯', async () => {
    const client = await pg.connect();
    try {
      const snap = { policyVersion: 11, model: 'm1', binding: 'b1', score: 0.9, reasons: ['score:0.90'] };
      const id = await recordRoutingDecision(client, {
        modelId: 'm1', capability: 'video', selectedBindingId: 'b1', selectedProviderId: 'p1',
        reason: 'score:0.90', policySnapshot: snap,
      });
      const rows = await listByVersion(client, 11);
      assert.equal(rows.length, 1, 'decision should land in ai_routing_decisions');
      assert.equal(rows[0].id, id);
      assert.deepEqual(rows[0].policy_snapshot, snap);
      // 别的版本不匹配
      assert.equal((await listByVersion(client, 999)).length, 0);
    } finally {
      client.release();
    }
  });
});
