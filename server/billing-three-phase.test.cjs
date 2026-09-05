'use strict';
/**
 * L30 §84-90: Billing 三段分离（estimated / actual / user_charge）tests.
 *
 * Coverage (全绿目标):
 *   T1 三段记录        — reserve 落 estimated；commit 落 actual + user_charge（列各归其位，绝不混）
 *   T2 actual 校准     — pricing.cjs calculate 得出 actual → commit 校准差额（退多扣）
 *   T3 校准补扣        — actual > estimated → 补扣差额（§88 前由调用方把关 max_cost）
 *   T4 失败退款幂等    — §89 provider 已收费但失败 → refund 退 user_charge、actual 仍记账；重复退款幂等
 *   T5 并发 settle 单次 — §90 ledger 幂等 settle:{attempt_id} → 并发 settle 只记一行
 *
 * Uses the MIGRATION path (migrate) so 0066 段 B 列真实存在。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const crypto = require('crypto');

const billing = require('./billing.cjs');
const { settleByAttempt } = require('./modules/generation-v2/ledger.cjs');
const { calculate } = require('./modules/modelhub/pricing.cjs');
const { migrate } = require('./db/migrate.cjs');

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';
const pgUrl = `postgresql://${pgUser}:***@${pgHost}:${pgPort}/postgres`;

const adminPool = new Pool({ connectionString: pgUrl, max: 1 });

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

async function createTestDb(suffix) {
  const dbName = `moling_bill3_${suffix}`;
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
  return new Pool({
    host: pgHost, port: pgPort,
    user: pgUser, password: pgPass,
    database: dbName, max: 8,
  });
}

async function setupBillingDb(pg) {
  await migrate(pg);
  await pg.query(`
    INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits)
    VALUES ($1, 'bill3@test.local', 'Bill3', '$2b$10$fakehash', 1000, 1000)
  `, ['u-bill3']);
}

test.after(async () => {
  await adminPool.end();
});

// ─── T1: 三段记录 — reserve 落 estimated，commit 落 actual + user_charge ───
test('T1: three-phase columns recorded separately (estimated/actual/user_charge never mixed)', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);

    // migration sanity: three columns exist
    const cols = await pg.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='credit_transactions'
        AND column_name IN ('estimated_amount','actual_amount','user_charge_amount')`);
    assert.equal(cols.rows.length, 3, 'credit_transactions should have the three §84 columns');

    await billing.reserveCreditsV2(pg, { userId: 'u-bill3', estimated: 100, ref: 't1-job', pool: 'recharge' });
    await billing.commitCreditsV2(pg, {
      userId: 'u-bill3', actual: 90, userCharge: 90, estimated: 100, ref: 't1-job', pool: 'recharge',
    });

    const reserve = await pg.query(
      `SELECT amount, estimated_amount, actual_amount, user_charge_amount FROM credit_transactions WHERE ref=$1 AND kind='reserve'`, ['t1-job']);
    assert.equal(Number(reserve.rows[0].estimated_amount), 100, 'reserve row carries estimated_amount');
    assert.equal(Number(reserve.rows[0].user_charge_amount), 100, 'reserve row carries preliminary user_charge');
    assert.equal(reserve.rows[0].actual_amount, null, 'reserve row has no actual yet (§84 never mixed)');

    const commit = await pg.query(
      `SELECT amount, estimated_amount, actual_amount, user_charge_amount FROM credit_transactions WHERE ref=$1 AND kind='commit'`, ['t1-job']);
    assert.equal(Number(commit.rows[0].actual_amount), 90, 'commit row carries actual_amount');
    assert.equal(Number(commit.rows[0].user_charge_amount), 90, 'commit row carries final user_charge_amount');
    assert.equal(Number(commit.rows[0].amount), 90, 'commit amount == user_charge (finance consumed metric)');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// ─── T2: actual 校准 — pricing.cjs calculate 得出 actual，差额退回 ───
test('T2: commit calibrates with actual (pricing.cjs calculate), refunds over-reserve', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);

    // pricing.cjs read-only: fixed rule computes actual=80 (provider cost)
    const { amount: actual, computed } = calculate({ rule: { formula_kind: 'fixed', params: { amount: 80 } }, usage: {} });
    assert.equal(computed, true);
    assert.equal(actual, 80);

    // reserve 100 (estimate), commit with actual 80 → user_charge 80 → refund 20
    await billing.reserveCreditsV2(pg, { userId: 'u-bill3', estimated: 100, ref: 't2-job', pool: 'recharge' });
    const before = await pg.query('SELECT recharge_credits FROM users WHERE id=$1', ['u-bill3']);
    assert.equal(Number(before.rows[0].recharge_credits), 900, '100 reserved');

    const r = await billing.commitCreditsV2(pg, {
      userId: 'u-bill3', actual, userCharge: actual, estimated: 100, ref: 't2-job', pool: 'recharge',
    });
    assert.equal(r.idempotent, false);
    assert.equal(r.delta, -20);

    const after = await pg.query('SELECT recharge_credits FROM users WHERE id=$1', ['u-bill3']);
    assert.equal(Number(after.rows[0].recharge_credits), 920, '20 refunded (100-80)');

    const commit = await pg.query(
      `SELECT actual_amount, user_charge_amount FROM credit_transactions WHERE ref=$1 AND kind='commit'`, ['t2-job']);
    assert.equal(Number(commit.rows[0].actual_amount), 80, 'actual 80 recorded');
    assert.equal(Number(commit.rows[0].user_charge_amount), 80, 'user_charge 80 recorded');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// ─── T3: 校准补扣 — actual > estimated 时补扣差额 ───
test('T3: commit under-reserve (actual > estimated) deducts the delta', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    await billing.reserveCreditsV2(pg, { userId: 'u-bill3', estimated: 100, ref: 't3-job', pool: 'recharge' });
    const r = await billing.commitCreditsV2(pg, {
      userId: 'u-bill3', actual: 130, userCharge: 130, estimated: 100, ref: 't3-job', pool: 'recharge',
    });
    assert.equal(r.delta, 30);
    const after = await pg.query('SELECT recharge_credits FROM users WHERE id=$1', ['u-bill3']);
    assert.equal(Number(after.rows[0].recharge_credits), 870, '100 + 30 extra deducted');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// ─── T4: 失败退款幂等 — §89 退 user_charge、actual 仍记账、重复退款幂等 ───
test('T4: failure refund idempotent — user_charge refunded, actual kept, duplicate refund no-op', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    // provider charged 100 (actual), task failed → refund user_charge 100
    const r1 = await billing.refundUserCharge(pg, {
      userId: 'u-bill3', userCharge: 100, actual: 100, ref: 't4-job', pool: 'recharge',
    });
    assert.equal(r1.idempotent, false);
    assert.equal(r1.refunded, 100);
    assert.equal(r1.actualKept, 100);

    const bal1 = await pg.query('SELECT recharge_credits FROM users WHERE id=$1', ['u-bill3']);
    assert.equal(Number(bal1.rows[0].recharge_credits), 1100, 'user_charge refunded back');

    // duplicate refund — idempotent
    const r2 = await billing.refundUserCharge(pg, {
      userId: 'u-bill3', userCharge: 100, actual: 100, ref: 't4-job', pool: 'recharge',
    });
    assert.equal(r2.idempotent, true, 'duplicate refund is idempotent');

    const bal2 = await pg.query('SELECT recharge_credits FROM users WHERE id=$1', ['u-bill3']);
    assert.equal(Number(bal2.rows[0].recharge_credits), 1100, 'balance not double-refunded');

    const rows = await pg.query(`SELECT COUNT(*) AS c, MAX(actual_amount) AS a FROM credit_transactions WHERE ref=$1 AND kind='refund'`, ['t4-job']);
    assert.equal(Number(rows.rows[0].c), 1, 'exactly one refund row');
    assert.equal(Number(rows.rows[0].a), 100, 'actual_amount kept (§89 cost not erased)');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// ─── T5: 并发 settle 单次 — §90 settle:{attempt_id} 幂等 ───
test('T5: concurrent settleByAttempt (same attempt_id) writes exactly one commit row', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    const batchId = `t5-batch`;
    const itemId = `t5-item`;
    const attemptId = 42;
    await pg.query(
      `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id) VALUES ($1, 'u-bill3', 'm-test')`, [batchId]);
    await pg.query(
      `INSERT INTO generation_items_v2 (item_id, batch_id, item_index) VALUES ($1, $2, 0)`, [itemId, batchId]);
    await pg.query(
      `INSERT INTO generation_credit_holds_v2 (item_id, user_id, amount, status, pool) VALUES ($1, 'u-bill3', 100, 'held', 'recharge')`, [itemId]);

    // 5 concurrent settles with same attempt_id
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      settleByAttempt(pg, { itemId, attemptId, action: 'commit', userCharge: 100, actual: 90 })));

    const changed = results.filter(r => r.changed).length;
    assert.equal(changed, 1, 'exactly one settle takes effect (hold CAS)');

    const settleRows = await pg.query(
      `SELECT COUNT(*) AS c, MAX(actual_amount) AS a FROM credit_transactions WHERE ref=$1 AND kind='commit'`, ['commit:42']);
    assert.equal(Number(settleRows.rows[0].c), 1, 'exactly one settle:{attempt_id} ledger row (§90)');
    assert.equal(Number(settleRows.rows[0].a), 90, 'actual 90 recorded on settle');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// ─── T6: 并发 reserveCreditsV2（同 ref）只扣一次（幂等声明先占唯一键）───
test('T6: concurrent reserveCreditsV2 (same ref) deducts exactly once', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    const ref = 't6-job';
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      billing.reserveCreditsV2(pg, { userId: 'u-bill3', estimated: 100, ref, pool: 'recharge' })));
    const nonIdem = results.filter(r => !r.idempotent).length;
    assert.equal(nonIdem, 1, 'exactly one reserve takes effect (idempotent claim first)');

    const bal = await pg.query('SELECT recharge_credits FROM users WHERE id=$1', ['u-bill3']);
    assert.equal(Number(bal.rows[0].recharge_credits), 900, 'balance deducted exactly once (1000-100)');

    const rows = await pg.query(`SELECT COUNT(*) AS c FROM credit_transactions WHERE ref=$1 AND kind='reserve'`, [ref]);
    assert.equal(Number(rows.rows[0].c), 1, 'exactly one reserve row');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// ─── T7: 并发 commitCreditsV2（同 ref，delta>0）补扣差额只应用一次 ───
test('T7: concurrent commitCreditsV2 (same ref, delta>0) applies delta exactly once', async () => {
  const dbName = await createTestDb(randomSuffix());
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    const ref = 't7-job';
    await billing.reserveCreditsV2(pg, { userId: 'u-bill3', estimated: 100, ref, pool: 'recharge' }); // 1000 -> 900
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      billing.commitCreditsV2(pg, { userId: 'u-bill3', actual: 130, userCharge: 130, estimated: 100, ref, pool: 'recharge' })));
    const nonIdem = results.filter(r => !r.idempotent).length;
    assert.equal(nonIdem, 1, 'exactly one commit applies the delta');

    const bal = await pg.query('SELECT recharge_credits FROM users WHERE id=$1', ['u-bill3']);
    assert.equal(Number(bal.rows[0].recharge_credits), 870, 'delta applied exactly once (100 reserve + 30 extra)');

    const rows = await pg.query(`SELECT COUNT(*) AS c FROM credit_transactions WHERE ref=$1 AND kind='commit'`, [ref]);
    assert.equal(Number(rows.rows[0].c), 1, 'exactly one commit row');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });
