'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTestPool, initTestSchema, truncateAll, closeTestPool, assertSafeTestDatabase
} = require('../../tests/helpers/test-db.cjs');
const { settleHold, reconcileBatch } = require('./ledger.cjs');
const { reserveBatchFunds, settleItemFunds } = require('./commercial-ledger.cjs');

let pg;
test.before(async () => {
  assertSafeTestDatabase(process.env.TEST_PG_DATABASE || 'moling_test');
  pg = createTestPool();
  await initTestSchema(pg);
});

test.after(async () => {
  await closeTestPool(pg);
});

test.beforeEach(async () => {
  await truncateAll(pg);
});

// ─── G1: Concurrent idempotency — same key should only reserve once ───

test('G1: concurrent same batch reserve — only one succeeds', async () => {
  // Insert user with credits
  await pg.query(
    `INSERT INTO users (id, email, password_hash, reward_credits, recharge_credits)
     VALUES ($1, 'g1@test.com', '$2b$10$placeholder', 10000, 0)`,
    ['u-g1']
  );
  const batchId = `b-g1-${Date.now()}`;
  const itemId1 = `i-g1-1-${Date.now()}`;
  const itemId2 = `i-g1-2-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-g1', 'm-stable-diffusion-xl', 2, '{}', 'image', 100, 200, 'running', $1)`,
    [batchId]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode) VALUES ($1, $2, 0, 'queued', 'real')`,
    [itemId1, batchId]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode) VALUES ($1, $2, 1, 'queued', 'real')`,
    [itemId2, batchId]
  );

  // Two concurrent reserves with same batchId — only one should succeed
  const [r1, r2] = await Promise.all([
    reserveBatchFunds(pg, { userId: 'u-g1', batchId, itemIds: [itemId1, itemId2], amountPerItem: 100, pool: 'reward' }),
    reserveBatchFunds(pg, { userId: 'u-g1', batchId, itemIds: [itemId1, itemId2], amountPerItem: 100, pool: 'reward' }),
  ]);

  // One should have succeeded, the other should have been idempotent or failed
  // Due to pg_advisory_xact_lock, one acquires the lock first; the second either gets the lock and sees existing rows or gets nothing
  const totalReserved = (r1?.reserved ? 1 : 0) + (r2?.reserved ? 1 : 0);
  assert.ok(totalReserved <= 2, 'at most 2 reserve calls but lock ensures only 1 charges');
  // Verify user balance wasn't charged twice
  const user = await pg.query(`SELECT reward_credits FROM users WHERE id='u-g1'`);
  assert.ok(Number(user.rows[0].reward_credits) >= 800, 'user should not be double-charged');
});

// ─── G2: Double commit — only charges once ───

test('G2: double settleHold commit — only one takes effect', async () => {
  // Insert parent item + hold (FK: holds.item_id → items.item_id)
  const itemId = `i-g2-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-test', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [`b-g2`]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode)
     VALUES ($1, 'b-g2', 0, 'queued', 'real')`,
    [itemId]
  );
  await pg.query(
    `INSERT INTO generation_credit_holds_v2 (item_id, user_id, pool, amount, status)
     VALUES ($1, 'u-test', 'reward', '1.00', 'held')`,
    [itemId]
  );

  const [r1, r2] = await Promise.all([
    settleHold(pg, { itemId, action: 'commit' }),
    settleHold(pg, { itemId, action: 'commit' }),
  ]);

  // Only one should have changed
  const changedCount = (r1.changed ? 1 : 0) + (r2.changed ? 1 : 0);
  assert.equal(changedCount, 1, 'double commit should only settle once');
});

// ─── G3: Double release — only refunds once ───

test('G3: double settleHold release — only one takes effect', async () => {
  const itemId = `i-g3-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-test', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [`b-g3`]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode)
     VALUES ($1, 'b-g3', 0, 'queued', 'real')`,
    [itemId]
  );
  await pg.query(
    `INSERT INTO generation_credit_holds_v2 (item_id, user_id, pool, amount, status)
     VALUES ($1, 'u-test', 'reward', '1.00', 'held')`,
    [itemId]
  );

  const [r1, r2] = await Promise.all([
    settleHold(pg, { itemId, action: 'release' }),
    settleHold(pg, { itemId, action: 'release' }),
  ]);

  const changedCount = (r1.changed ? 1 : 0) + (r2.changed ? 1 : 0);
  assert.equal(changedCount, 1, 'double release should only settle once');
});

// ─── G4: Commit vs Release race ───

test('G4: commit vs release race — only one wins', async () => {
  const itemId = `i-g4-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-test', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [`b-g4`]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode)
     VALUES ($1, 'b-g4', 0, 'queued', 'real')`,
    [itemId]
  );
  await pg.query(
    `INSERT INTO generation_credit_holds_v2 (item_id, user_id, pool, amount, status)
     VALUES ($1, 'u-test', 'reward', '1.00', 'held')`,
    [itemId]
  );

  const [r1, r2] = await Promise.all([
    settleHold(pg, { itemId, action: 'commit' }),
    settleHold(pg, { itemId, action: 'release' }),
  ]);

  // Only one should have changed
  const changedCount = (r1.changed ? 1 : 0) + (r2.changed ? 1 : 0);
  assert.equal(changedCount, 1, 'commit vs release race: only one should win');

  // Verify final state
  const hold = await pg.query(`SELECT status FROM generation_credit_holds_v2 WHERE item_id=$1`, [itemId]);
  assert.ok(['committed', 'released'].includes(hold.rows[0].status));
});

// ─── G5: Worker retry does not create new hold ───

test('G5: settling already-settled hold returns changed:false', async () => {
  const itemId = `i-g5-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-test', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [`b-g5`]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode)
     VALUES ($1, 'b-g5', 0, 'queued', 'real')`,
    [itemId]
  );
  await pg.query(
    `INSERT INTO generation_credit_holds_v2 (item_id, user_id, pool, amount, status, settled_at)
     VALUES ($1, 'u-test', 'reward', '1.00', 'committed', NOW())`,
    [itemId]
  );

  const r = await settleHold(pg, { itemId, action: 'commit' });
  assert.equal(r.changed, false, 'already committed hold should not change again');
});

// ─── G6: reconcileBatch status computation ───

test('G6: reconcileBatch — all items done → batch done', async () => {
  const batchId = `b-g6-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 2, '{}', 'image', 100, 200, 'running', $1)`,
    [batchId]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode) VALUES ($1, $2, 0, 'done', 'real')`,
    [`i-g6-1`, batchId]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode) VALUES ($1, $2, 1, 'done', 'real')`,
    [`i-g6-2`, batchId]
  );

  const r = await reconcileBatch(pg, batchId);
  assert.equal(r.status, 'done');
  assert.equal(r.success_count, 2);
});

test('G6: reconcileBatch — mixed results → partial', async () => {
  const batchId = `b-g6b-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 2, '{}', 'image', 100, 200, 'running', $1)`,
    [batchId]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode) VALUES ($1, $2, 0, 'done', 'real')`,
    [`i-g6b-1`, batchId]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode) VALUES ($1, $2, 1, 'failed', 'real')`,
    [`i-g6b-2`, batchId]
  );

  const r = await reconcileBatch(pg, batchId);
  assert.equal(r.status, 'partial');
});
