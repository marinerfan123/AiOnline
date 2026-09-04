'use strict';
/**
 * L32 §88: max_cost_authorized 重估闸 tests.
 * 运行：
 *   # 纯函数部分（无需 DB）
 *   node --test --test-concurrency=1 server/billing-max-cost.test.cjs
 *   # 真实 PG 部分（cap+adjust / 余额门顺序），需本地 PG（默认 5432，可 TEST_PG_PORT 覆盖）
 *   TEST_PG_PORT=5433 TEST_PG_PASSWORD='0.0.1abcd' node --test --test-concurrency=1 server/billing-max-cost.test.cjs
 *
 * Coverage (全绿目标):
 *   T1 预扣闸拦截        — expected > max_cost_authorized → COST_EXCEEDS_MAX（带 expected/max）
 *   T2 边界等于放行      — expected == max → 放行（仅严格 > 拦截）
 *   T3 结算 cap+adjust   — actual 超 authorized → user_charge 封顶、差额记 cap_adjust（§89 actual 保留）
 *   T4 与余额门顺序/不双算 — resolvePayment 先过、闸只读、拦截后余额不变无账
 *   附：fail-open（无规则/custom_ref/不可计量）+ operation/usage/max 解析推导
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const billing = require('./billing.cjs');

// ════════════════════════════════════════════════════════════════════════
// Part A — 纯函数（无 DB）
// ════════════════════════════════════════════════════════════════════════

const HOUR = 3600 * 1000;
// 注：resolveRule 在未显式传 atMs 时用 Date.now()，故规则 effective_from 用 now-HOUR
// 确保当前始终生效（不依赖测试机系统时钟是否 == 2026-09-05）。
const NOW = Date.now();

function mkRule(overrides = {}) {
  return Object.assign({
    rule_id: 'pr-1',
    model_id: 'video.seedance-2.5',
    operation_code: 'video.text_to_video',
    rule_version: 1,
    effective_from: NOW - HOUR,
    effective_to: null,
    formula_kind: 'fixed',
    params: { amount: 100 },
    status: 'ACTIVE',
    created_at: new Date(NOW - HOUR),
  }, overrides);
}

function makeRulePool(rules) {
  return {
    async query(text, params = []) {
      const sql = String(text).toUpperCase();
      if (sql.includes('PRICING_RULES')) {
        const modelId = params[0];
        const opCode = params[1];
        const atMs = params[2] instanceof Date ? params[2].getTime() : Number(params[2]);
        const matches = (rules || [])
          .filter((r) => r.model_id === modelId && r.operation_code === opCode && r.status === 'ACTIVE')
          .filter((r) => r.effective_from <= atMs && (r.effective_to == null || r.effective_to > atMs))
          .sort((a, b) => b.rule_version - a.rule_version);
        return { rows: matches.slice(0, 1) };
      }
      return { rows: [] };
    },
  };
}

// ── T1 预扣闸拦截 ──────────────────────────────────────────────────────
test('T1 预扣闸：expected(45) > max(40) → COST_EXCEEDS_MAX（带 expected/max）', () => {
  const r = billing.checkMaxCostAuthorized({ expected: 45, maxCostAuthorized: 40 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'COST_EXCEEDS_MAX');
  assert.equal(r.expected, 45);
  assert.equal(r.max, 40);
});

test('T1 预扣闸：estimateExpectedCost(rate_per_second) → applied + expected 命中', async () => {
  const pg = makeRulePool([mkRule({ formula_kind: 'rate_per_second', params: { rate: 7.5 } })]);
  const est = await billing.estimateExpectedCost(pg, {
    modelId: 'video.seedance-2.5', operationCode: 'video.text_to_video', usage: { seconds: 6 },
  });
  assert.equal(est.applied, true);
  assert.equal(est.expected, 45); // 7.5 * 6
  const gate = billing.checkMaxCostAuthorized({ expected: est.expected, maxCostAuthorized: 40 });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'COST_EXCEEDS_MAX');
});

// ── T2 边界等于放行 ────────────────────────────────────────────────────
test('T2 边界：expected(40) == max(40) → 放行（仅严格 > 拦截）', () => {
  const r = billing.checkMaxCostAuthorized({ expected: 40, maxCostAuthorized: 40 });
  assert.equal(r.ok, true);
  assert.equal(r.expected, 40);
  assert.equal(r.max, 40);
});

test('T2 边界：expected(39) < max(40) → 放行', () => {
  assert.equal(billing.checkMaxCostAuthorized({ expected: 39, maxCostAuthorized: 40 }).ok, true);
});

// ── fail-open：无 cap / 不可计量 / 无规则 / custom_ref ────────────────
test('fail-open：无 cap（null）→ 放行；不可计量（NaN/负）→ 放行', () => {
  assert.equal(billing.checkMaxCostAuthorized({ expected: 999, maxCostAuthorized: null }).ok, true);
  assert.equal(billing.checkMaxCostAuthorized({ expected: null, maxCostAuthorized: 40 }).ok, true);
  assert.equal(billing.checkMaxCostAuthorized({ expected: NaN, maxCostAuthorized: 40 }).ok, true);
});

test('fail-open：estimateExpectedCost 无规则 → applied:false（不阻断生成）', async () => {
  const est = await billing.estimateExpectedCost(makeRulePool([]), {
    modelId: 'x', operationCode: 'y', usage: { seconds: 6 },
  });
  assert.equal(est.applied, false);
  assert.equal(est.reason, 'no_rule');
});

test('fail-open：estimateExpectedCost custom_ref → applied:false（引用不执行）', async () => {
  const pg = makeRulePool([mkRule({ formula_kind: 'custom_ref', params: { ref: 'video.seedance2_5.v1' } })]);
  const est = await billing.estimateExpectedCost(pg, { modelId: 'video.seedance-2.5', operationCode: 'video.text_to_video', usage: {} });
  assert.equal(est.applied, false);
  assert.equal(est.reason, 'custom_ref');
});

// ── 解析推导（operation / usage / max）────────────────────────────────
test('resolveGenerateOperation：显式 operationCode 优先；缺省按 contentType+referenceImages 推导', () => {
  assert.equal(billing.resolveGenerateOperation({ operationCode: 'video.first_last_frame' }), 'video.first_last_frame');
  assert.equal(billing.resolveGenerateOperation({ contentType: 'video', referenceImages: ['a'] }), 'video.image_to_video');
  assert.equal(billing.resolveGenerateOperation({ contentType: 'video' }), 'video.text_to_video');
  assert.equal(billing.resolveGenerateOperation({}), 'image.generate');
});

test('resolveGenerateUsage：视频 duration→seconds、duration*24fps→frames；图像 frames=count', () => {
  assert.deepEqual(billing.resolveGenerateUsage({ contentType: 'video', duration: 8 }), { seconds: 8, frames: 192 });
  assert.deepEqual(billing.resolveGenerateUsage({ contentType: 'image', count: 4 }), { seconds: 0, frames: 4 });
  assert.deepEqual(billing.resolveGenerateUsage({ contentType: 'video', duration: 5, frames: 120 }), { seconds: 5, frames: 120 });
});

test('resolveMaxCostAuthorized：用户设优先，缺省回退默认 100', () => {
  assert.equal(billing.resolveMaxCostAuthorized({ maxCostAuthorized: 40 }), 40);
  assert.equal(billing.resolveMaxCostAuthorized({ max_cost_authorized: '40' }), 40);
  assert.equal(billing.resolveMaxCostAuthorized({}), billing.DEFAULT_MAX_COST_AUTHORIZED);
  assert.equal(billing.resolveMaxCostAuthorized({ maxCostAuthorized: 'abc' }), billing.DEFAULT_MAX_COST_AUTHORIZED);
});

// ════════════════════════════════════════════════════════════════════════
// Part B — 真实 PG（cap+adjust / 余额门顺序 / 不双算）
//   沿用 billing-three-phase 的 migrate harness；需本地 PG。
// ════════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');
const { migrate } = require('./db/migrate.cjs');

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';
const pgUrl = `postgresql://${pgUser}:${pgPass}@${pgHost}:${pgPort}/postgres`;

const adminPool = new Pool({ connectionString: pgUrl, max: 1 });

function randomSuffix() { return crypto.randomBytes(4).toString('hex'); }

async function createTestDb(suffix) {
  const dbName = `moling_maxcost_${suffix}`;
  await adminPool.query('DROP DATABASE IF EXISTS ' + dbName);
  await adminPool.query('CREATE DATABASE ' + dbName);
  return dbName;
}

async function dropTestDb(dbName) {
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await adminPool.query('DROP DATABASE IF EXISTS ' + dbName);
  } catch (_) {}
}

function createPool(dbName) {
  return new Pool({ host: pgHost, port: pgPort, user: pgUser, password: pgPass, database: dbName, max: 8 });
}

async function setupDb(pg) {
  await migrate(pg);
  await pg.query(`
    INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits)
    VALUES ($1, 'maxcost@test.local', 'MaxCost', '$2b$10$fakehash', 0, 1000)
  `, ['u-maxcost']);
  // 供 estimateExpectedCost 命中的 pricing rule：rate_per_second 7.5 → 6s = 45
  await pg.query(`
    INSERT INTO pricing_rules (rule_id, model_id, operation_code, rule_version, effective_from, formula_kind, params, status)
    VALUES ('pr-maxcost-1', 'video.seedance-2.5', 'video.text_to_video', 1, NOW() - INTERVAL '1 day', 'rate_per_second', '{"rate": 7.5}'::jsonb, 'ACTIVE')
  `);
}

test.after(async () => { await adminPool.end(); });

// ── T3 结算 cap+adjust ────────────────────────────────────────────────
test('T3 结算 cap+adjust：actual(45) > authorized(40) → charge 封顶 40，差额 5 记 cap_adjust，actual 保留', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupDb(pg);

    await billing.reserveCreditsV2(pg, { userId: 'u-maxcost', estimated: 40, ref: 'cap-job', pool: 'recharge' });
    const r = await billing.commitCreditsV2(pg, {
      userId: 'u-maxcost', actual: 45, maxCostAuthorized: 40, estimated: 40, ref: 'cap-job', pool: 'recharge',
    });
    assert.equal(r.idempotent, false);
    assert.equal(r.capped, true);
    assert.equal(r.overage, 5);
    assert.equal(r.userCharge, 40, 'user_charge 封顶到 authorized');
    assert.equal(r.actual, 45, 'actual_provider_cost 全量保留（§89）');

    // 余额：1000 - 40(reserve) + 0(delta=40-40) = 960；overage 5 不动余额（平台吸收）
    const bal = await pg.query('SELECT recharge_credits FROM users WHERE id=$1', ['u-maxcost']);
    assert.equal(Number(bal.rows[0].recharge_credits), 960);

    // commit 行：actual 45 / user_charge 40（三段不混）
    const commit = await pg.query(
      `SELECT amount, actual_amount, user_charge_amount FROM credit_transactions WHERE ref=$1 AND kind='commit'`, ['cap-job']);
    assert.equal(Number(commit.rows[0].actual_amount), 45);
    assert.equal(Number(commit.rows[0].user_charge_amount), 40);
    assert.equal(Number(commit.rows[0].amount), 40);

    // cap_adjust 行：差额 5 记账，actual 45 保留、user_charge 40
    const adj = await pg.query(
      `SELECT amount, actual_amount, user_charge_amount FROM credit_transactions WHERE ref=$1 AND kind='cap_adjust'`, ['cap-job']);
    assert.equal(adj.rows.length, 1, '恰好一行 cap_adjust（差额记账）');
    assert.equal(Number(adj.rows[0].amount), 5);
    assert.equal(Number(adj.rows[0].actual_amount), 45);
    assert.equal(Number(adj.rows[0].user_charge_amount), 40);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// ── T3b 结算 cap+adjust 幂等 ──────────────────────────────────────────
test('T3b 结算 cap+adjust 幂等：二次 commit no-op，单 commit 行 + 单 cap_adjust 行', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupDb(pg);
    await billing.reserveCreditsV2(pg, { userId: 'u-maxcost', estimated: 40, ref: 'cap-job2', pool: 'recharge' });
    const opts = { userId: 'u-maxcost', actual: 45, maxCostAuthorized: 40, estimated: 40, ref: 'cap-job2', pool: 'recharge' };
    const r1 = await billing.commitCreditsV2(pg, opts);
    const r2 = await billing.commitCreditsV2(pg, opts);
    assert.equal(r1.idempotent, false);
    assert.equal(r2.idempotent, true, '二次 commit 幂等');
    const cnt = await pg.query(
      `SELECT kind, COUNT(*) c FROM credit_transactions WHERE ref='cap-job2' GROUP BY kind ORDER BY kind`);
    const m = Object.fromEntries(cnt.rows.map((x) => [x.kind, Number(x.c)]));
    assert.equal(m.commit, 1);
    assert.equal(m.cap_adjust, 1);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// ── T4 与余额门顺序 / 幂等不双算 ──────────────────────────────────────
test('T4 与余额门顺序：resolvePayment 先过 → 闸拦截 → 余额不变、无账（只读不双算）', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupDb(pg);

    // 1) 余额门先过（与 server.js 顺序一致：resolvePayment → estimate → gate）
    const pay = await billing.resolvePayment(pg, 'u-maxcost', { supportsReward: false, creditCost: 45 });
    assert.equal(pay.pool, 'recharge');
    assert.equal(pay.amount, 45);

    // 2) 重估闸：expected 45 > authorized 40 → 拦截
    const est = await billing.estimateExpectedCost(pg, {
      modelId: 'video.seedance-2.5', operationCode: 'video.text_to_video', usage: { seconds: 6 },
    });
    assert.equal(est.applied, true);
    assert.equal(est.expected, 45);
    const gate = billing.checkMaxCostAuthorized({ expected: est.expected, maxCostAuthorized: 40 });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'COST_EXCEEDS_MAX');

    // 3) 幂等不双算：闸只读，拦截后余额不变、无任何 credit_transactions 账
    const bal = await pg.query('SELECT recharge_credits, reward_credits FROM users WHERE id=$1', ['u-maxcost']);
    assert.equal(Number(bal.rows[0].recharge_credits), 1000, '余额门 + 重估闸都不动余额');
    const txCount = await pg.query('SELECT COUNT(*) c FROM credit_transactions WHERE user_id=$1', ['u-maxcost']);
    assert.equal(Number(txCount.rows[0].c), 0, '拦截前无任何扣账/reserve（不双算）');

    // 4) 边界放行：expected == max 时闸通过（随后 reserve 才是唯一扣款点）
    const gate2 = billing.checkMaxCostAuthorized({ expected: 45, maxCostAuthorized: 45 });
    assert.equal(gate2.ok, true);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });
