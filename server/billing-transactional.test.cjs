'use strict';
/**
 * P1-01: Legacy billing transactionality tests.
 *
 * Proves that without transactional guarantees:
 * - reserve+transaction insert is not atomic (crash window)
 * - concurrent commit/release can double-post (check-then-act race)
 * - duplicate retry is not idempotent at DB level
 *
 * Then verifies the fix makes all operations atomic + idempotent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const crypto = require('crypto');

const billing = require('./billing.cjs');
const { migrate } = require('./db/migrate.cjs');

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';
const pgDb = process.env.TEST_PG_DATABASE || process.env.PG_DATABASE || 'moling_test';
const pgUrl = `postgresql://${pgUser}:${encodeURIComponent(pgPass)}@${pgHost}:${pgPort}/postgres`;

const adminPool = new Pool({ connectionString: pgUrl, max: 1 });

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

async function createTestDb(suffix) {
  const dbName = `moling_bill_test_${suffix}`;
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
    database: dbName, max: 5,
  });
}

async function setupBillingDb(pg) {
  await migrate(pg);
  // Create a test user with known balance
  await pg.query(`
    INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits)
    VALUES ($1, 'billtest@test.local', 'BillTest', '$2b$10$fakehash', 1000, 1000)
  `, ['u-billtest']);
}

// === B1: reserveCredits balance + transaction are atomic ===
test('B1: reserveCredits deducts balance and inserts transaction atomically', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    await billing.reserveCredits(pg, 'u-billtest', 100, 'b1-reserve', 'recharge');

    // Balance should be deducted
    const user = await pg.query('SELECT recharge_credits FROM users WHERE id = $1', ['u-billtest']);
    assert.equal(Number(user.rows[0].recharge_credits), 900);

    // Transaction should exist
    const tx = await pg.query('SELECT kind, amount, ref, pool FROM credit_transactions WHERE ref = $1 AND kind = $2', ['b1-reserve', 'reserve']);
    assert.equal(tx.rows.length, 1, 'transaction should exist');
    assert.equal(tx.rows[0].kind, 'reserve');
    assert.equal(Number(tx.rows[0].amount), 100);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 30000 });

// === B2: commitCredits is idempotent ===
test('B2: commitCredits is idempotent - duplicate call does not double record', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    // First commit
    await billing.commitCredits(pg, 'u-billtest', 100, 'b2-commit', 'recharge');
    // Duplicate commit
    await billing.commitCredits(pg, 'u-billtest', 100, 'b2-commit', 'recharge');

    const txs = await pg.query("SELECT COUNT(*) AS cnt FROM credit_transactions WHERE ref = 'b2-commit' AND kind = 'commit'");
    assert.equal(Number(txs.rows[0].cnt), 1, 'should only have 1 commit transaction, not 2');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 30000 });

// === B3: releaseCredits is idempotent ===
test('B3: releaseCredits is idempotent - duplicate release does not double refund', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    // First release
    await billing.releaseCredits(pg, 'u-billtest', 100, 'b3-release', 'recharge');
    const after1 = await pg.query('SELECT recharge_credits FROM users WHERE id = $1', ['u-billtest']);
    const bal1 = Number(after1.rows[0].recharge_credits);
    // Duplicate release
    await billing.releaseCredits(pg, 'u-billtest', 100, 'b3-release', 'recharge');
    const after2 = await pg.query('SELECT recharge_credits FROM users WHERE id = $1', ['u-billtest']);
    const bal2 = Number(after2.rows[0].recharge_credits);
    assert.equal(bal1, bal2, 'duplicate release should not change balance');

    const txs = await pg.query("SELECT COUNT(*) AS cnt FROM credit_transactions WHERE ref = 'b3-release' AND kind = 'release'");
    assert.equal(Number(txs.rows[0].cnt), 1, 'should only have 1 release transaction');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 30000 });

// === B4: reserve+transaction atomicity via DB constraint ===
test('B4: credit_transactions has unique constraint on (ref, kind) for DB-level idempotency', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    // Insert directly
    await pg.query(
      "INSERT INTO credit_transactions (user_id, kind, amount, ref, pool) VALUES ('u-billtest', 'reserve', 50, 'b4-unique', 'recharge')"
    );
    // Second insert with same ref+kind should fail
    let threw = false;
    try {
      await pg.query(
        "INSERT INTO credit_transactions (user_id, kind, amount, ref, pool) VALUES ('u-billtest', 'reserve', 50, 'b4-unique', 'recharge')"
      );
    } catch (e) {
      threw = true;
      assert.ok(e.code === '23505', `expect unique violation, got ${e.code}`);
    }
    assert.ok(threw, 'duplicate (ref, kind) insert should fail');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 30000 });

// === B5: concurrent reserve does not go negative ===
test('B5: concurrent reserve does not overspend (balance stays >= 0)', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    // User has 1000 recharge_credits. Try 20 concurrent reserves of 100 each.
    const promises = [];
    let successCount = 0;
    for (let i = 0; i < 20; i++) {
      const p = billing.reserveCredits(pg, 'u-billtest', 100, `b5-concurrent-${i}`, 'recharge')
        .then(() => { successCount++; })
        .catch(() => {});
      promises.push(p);
    }
    await Promise.all(promises);
    assert.equal(successCount, 10, 'should have exactly 10 successful reserves out of 20');

    const user = await pg.query('SELECT recharge_credits FROM users WHERE id = $1', ['u-billtest']);
    assert.equal(Number(user.rows[0].recharge_credits), 0, 'balance should be exactly 0');

    const txs = await pg.query("SELECT COUNT(*) AS cnt FROM credit_transactions WHERE kind = 'reserve'");
    assert.equal(Number(txs.rows[0].cnt), 10, 'should have exactly 10 transaction records');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 30000 });

// === B6: concurrent commit/release does not double-post ===
test('B6: concurrent commit calls are idempotent', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    // Fire 5 concurrent commits with same ref
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(billing.commitCredits(pg, 'u-billtest', 100, 'b6-commit', 'recharge'));
    }
    await Promise.all(promises);

    const txs = await pg.query("SELECT COUNT(*) AS cnt FROM credit_transactions WHERE ref = 'b6-commit' AND kind = 'commit'");
    assert.equal(Number(txs.rows[0].cnt), 1, 'concurrent commits should still produce exactly 1 record');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 30000 });

// === B7: concurrent release does not double refund ===
test('B7: concurrent release calls are idempotent', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await setupBillingDb(pg);
    // Fire 5 concurrent releases with same ref
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(billing.releaseCredits(pg, 'u-billtest', 100, 'b7-release', 'recharge'));
    }
    await Promise.all(promises);

    const txs = await pg.query("SELECT COUNT(*) AS cnt FROM credit_transactions WHERE ref = 'b7-release' AND kind = 'release'");
    assert.equal(Number(txs.rows[0].cnt), 1, 'concurrent releases should still produce exactly 1 record');

    const user = await pg.query('SELECT recharge_credits FROM users WHERE id = $1', ['u-billtest']);
    assert.equal(Number(user.rows[0].recharge_credits), 1100, 'balance should only be refunded once');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 30000 });

// Cleanup
test.after(async () => {
  await adminPool.end();
});
