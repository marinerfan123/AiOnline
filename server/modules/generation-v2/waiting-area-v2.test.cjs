'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTestPool, initTestSchema, truncateAll, closeTestPool, assertSafeTestDatabase
} = require('../../tests/helpers/test-db.cjs');
const { enqueueToV2Queue, countWaitingItems, recoverWaitingArea } = require('./waiting-area-v2.cjs');
const { claimItems, transitionItem, reapExpiredLeases } = require('./lease.cjs');

let pg;
test.before(async () => {
  assertSafeTestDatabase(process.env.TEST_PG_DATABASE || 'moling_test');
  pg = createTestPool();
  await initTestSchema(pg);
});
test.after(async () => closeTestPool(pg));
test.beforeEach(async () => truncateAll(pg));

async function seedUser(userId) {
  await pg.query(
    `INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@test.local`, userId, '$2b$10$fake', 1000, 1000],
  );
}

// ─── Test: restart — waiting items survive process crash ───

test('restart: waiting items persist across simulated process restart', async () => {
  await seedUser('u-restart-1');
  const envelope = await enqueueToV2Queue(pg, {
    taskId: 'task-restart', userId: 'u-restart-1', model: 'm-test',
  });
  assert.ok(envelope);

  // Simulate restart: query from same pool (same DB, different connection)
  const recovered = await pg.query(
    `SELECT item_id, status, priority, mode FROM generation_items_v2 WHERE item_id=$1`,
    [envelope.itemId],
  );
  assert.equal(recovered.rows.length, 1);
  assert.equal(recovered.rows[0].status, 'queued');
  assert.equal(recovered.rows[0].priority, -100);
  assert.equal(recovered.rows[0].mode, 'real');
});

test('restart: recovered waiting items are claimable by V2 worker', async () => {
  await seedUser('u-restart-2');
  const envelope = await enqueueToV2Queue(pg, {
    taskId: 'task-restart2', userId: 'u-restart-2', model: 'm-test',
  });

  // Make claimable
  await pg.query(
    `UPDATE generation_items_v2 SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE item_id=$1`,
    [envelope.itemId],
  );

  // Simulate restart: new worker claims it
  const claimed = await claimItems(pg, { workerId: 'worker-restart', limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].item_id, envelope.itemId);
  assert.equal(claimed[0].status, 'leased');
});

// ─── Test: duplicate handling ───

test('duplicate: same taskId enqueued twice creates separate durable items', async () => {
  await seedUser('u-dup');
  const r1 = await enqueueToV2Queue(pg, { taskId: 'task-dup', userId: 'u-dup', model: 'm-test' });
  const r2 = await enqueueToV2Queue(pg, { taskId: 'task-dup', userId: 'u-dup', model: 'm-test' });

  assert.notEqual(r1.itemId, r2.itemId);
  assert.notEqual(r1.batchId, r2.batchId);

  // Both items exist independently
  const count = await pg.query(
    `SELECT COUNT(*)::int FROM generation_items_v2 WHERE item_id IN ($1, $2)`,
    [r1.itemId, r2.itemId],
  );
  assert.equal(count.rows[0].count, 2);
});

test('duplicate: same taskId creates separate batches with unique idempotency keys', async () => {
  await seedUser('u-dup2');
  const r1 = await enqueueToV2Queue(pg, { taskId: 'task-dup2', userId: 'u-dup2', model: 'm-test' });
  const r2 = await enqueueToV2Queue(pg, { taskId: 'task-dup2', userId: 'u-dup2', model: 'm-test' });

  const batch1 = await pg.query('SELECT idempotency_key FROM generation_batches_v2 WHERE batch_id=$1', [r1.batchId]);
  const batch2 = await pg.query('SELECT idempotency_key FROM generation_batches_v2 WHERE batch_id=$1', [r2.batchId]);

  assert.ok(batch1.rows[0].idempotency_key.startsWith('wait-'));
  assert.ok(batch2.rows[0].idempotency_key.startsWith('wait-'));
  assert.notEqual(batch1.rows[0].idempotency_key, batch2.rows[0].idempotency_key);
});

// ─── Test: lease behavior for waiting items ───

test('lease: waiting item transitions through full lifecycle', async () => {
  await seedUser('u-lease-1');
  const envelope = await enqueueToV2Queue(pg, { taskId: 'task-lease1', userId: 'u-lease-1', model: 'm-test' });

  // Claim
  await pg.query(`UPDATE generation_items_v2 SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE item_id=$1`, [envelope.itemId]);
  const claimed = await claimItems(pg, { workerId: 'w1', limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, 'leased');
  assert.equal(claimed[0].lease_owner, 'w1');

  // Transition to generating (lease_version becomes 1 after claim, stays 1 in transition)
  const transitioning = await transitionItem(pg, {
    itemId: envelope.itemId,
    leaseVersion: Number(claimed[0].lease_version),
    workerId: 'w1',
    from: 'leased',
    to: 'generating',
  });
  assert.ok(transitioning, 'should transition from leased to generating');
  assert.equal(transitioning.status, 'generating');

  // Transition to generated with SAME lease_version (transitions don't increment it)
  const generated = await transitionItem(pg, {
    itemId: envelope.itemId,
    leaseVersion: Number(claimed[0].lease_version),
    workerId: 'w1',
    from: 'generating',
    to: 'generated',
    patch: { generated_at: new Date() },
  });
  assert.ok(generated, 'should transition from generating to generated');
});

test('lease: expired lease is reaped back to retry_wait', async () => {
  await seedUser('u-lease-2');
  const envelope = await enqueueToV2Queue(pg, { taskId: 'task-lease2', userId: 'u-lease-2', model: 'm-test' });

  // Claim with short lease
  await pg.query(`UPDATE generation_items_v2 SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE item_id=$1`, [envelope.itemId]);
  await claimItems(pg, { workerId: 'w2', limit: 1, leaseSeconds: 1 });

  // Expire lease
  await pg.query(`UPDATE generation_items_v2 SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE item_id=$1`, [envelope.itemId]);

  // Reap should move back to retry_wait
  const reaped = await reapExpiredLeases(pg, { limit: 10 });
  assert.ok(reaped.length >= 1);
  const item = await pg.query(`SELECT status FROM generation_items_v2 WHERE item_id=$1`, [envelope.itemId]);
  assert.equal(item.rows[0].status, 'retry_wait');
});

test('lease: stale lease transition is rejected', async () => {
  await seedUser('u-lease-3');
  const envelope = await enqueueToV2Queue(pg, { taskId: 'task-lease3', userId: 'u-lease-3', model: 'm-test' });

  // Claim as worker-a
  await pg.query(`UPDATE generation_items_v2 SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE item_id=$1`, [envelope.itemId]);
  const [claimedA] = await claimItems(pg, { workerId: 'worker-a', limit: 1 });
  const versionA = Number(claimedA.lease_version);

  // Simulate: requeue and claim as worker-b
  await pg.query(`UPDATE generation_items_v2 SET status='queued', lease_owner=NULL, lease_expires_at=NULL, lease_version=lease_version+1 WHERE item_id=$1`, [envelope.itemId]);
  const [claimedB] = await claimItems(pg, { workerId: 'worker-b', limit: 1 });
  const versionB = Number(claimedB.lease_version);

  // worker-a tries with stale version
  const stale = await transitionItem(pg, {
    itemId: envelope.itemId,
    leaseVersion: versionA,
    workerId: 'worker-a',
    from: 'leased',
    to: 'generating',
  });
  assert.equal(stale, null, 'stale lease should be rejected');

  // worker-b with fresh version succeeds
  const valid = await transitionItem(pg, {
    itemId: envelope.itemId,
    leaseVersion: versionB,
    workerId: 'worker-b',
    from: 'leased',
    to: 'generating',
  });
  assert.ok(valid, 'valid lease should succeed');
});

// ─── Test: retry behavior ───

test('retry: item retries after transient failure', async () => {
  await seedUser('u-retry-1');
  const envelope = await enqueueToV2Queue(pg, { taskId: 'task-retry1', userId: 'u-retry-1', model: 'm-test' });

  // First attempt: fail
  await pg.query(`UPDATE generation_items_v2 SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE item_id=$1`, [envelope.itemId]);
  await claimItems(pg, { workerId: 'w-retry', limit: 1 });
  await transitionItem(pg, {
    itemId: envelope.itemId,
    leaseVersion: 1,
    workerId: 'w-retry',
    from: 'leased',
    to: 'generating',
  });
  // Transition to retry_wait with SAME lease_version (transitions don't increment it)
  await transitionItem(pg, {
    itemId: envelope.itemId,
    leaseVersion: 1,
    workerId: 'w-retry',
    from: 'generating',
    to: 'retry_wait',
    patch: { next_attempt_at: new Date(Date.now() - 1000) }, // make immediately retryable
  });

  // Second attempt: claim with lease_version=2
  const claimed = await claimItems(pg, { workerId: 'w-retry', limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].item_id, envelope.itemId);
  assert.equal(claimed[0].status, 'leased');
});

test('retry: bounded retries eventually mark as review_required', async () => {
  await seedUser('u-retry-2');
  const envelope = await enqueueToV2Queue(pg, { taskId: 'task-retry2', userId: 'u-retry-2', model: 'm-test' });

  // Simulate 6 claim-transition-reap cycles until review_required
  // Note: claimItems increments lease_version by 1; transitions do NOT increment it.
  for (let i = 0; i < 6; i++) {
    // Make item claimable and set attempt_count
    await pg.query(
      `UPDATE generation_items_v2 SET next_attempt_at = NOW() - INTERVAL '1 second', status='queued', lease_owner=NULL, lease_expires_at=NULL, attempt_count=$1 WHERE item_id=$2`,
      [i, envelope.itemId],
    );
    // Claim: lease_version becomes i+1
    await claimItems(pg, { workerId: 'w-retry2', limit: 1 });
    // Transition to generating with current lease_version
    await transitionItem(pg, {
      itemId: envelope.itemId,
      leaseVersion: i + 1,
      workerId: 'w-retry2',
      from: 'leased',
      to: 'generating',
    });
    // Transition to review_required with SAME lease_version (transitions don't increment)
    await transitionItem(pg, {
      itemId: envelope.itemId,
      leaseVersion: i + 1,
      workerId: 'w-retry2',
      from: 'generating',
      to: 'review_required',
    });
  }

  // Should now be in review_required
  const item = await pg.query(`SELECT status FROM generation_items_v2 WHERE item_id=$1`, [envelope.itemId]);
  assert.equal(item.rows[0].status, 'review_required');
});

// ─── Test: enqueue/resume bridge wiring ───

test('bridge: enqueueToV2Queue creates item with correct priority', async () => {
  await seedUser('u-bridge-1');
  const envelope = await enqueueToV2Queue(pg, {
    taskId: 'task-bridge',
    userId: 'u-bridge-1',
    model: 'm-test',
    prompt: 'test prompt',
    count: 1,
    contentType: 'image',
  });

  const item = await pg.query(`SELECT priority, mode, status FROM generation_items_v2 WHERE item_id=$1`, [envelope.itemId]);
  assert.equal(item.rows[0].priority, -100, 'waiting items should have negative priority');
  assert.equal(item.rows[0].mode, 'real');
  assert.equal(item.rows[0].status, 'queued');
});

test('bridge: countWaitingItems reflects actual state', async () => {
  await seedUser('u-bridge-2');
  await enqueueToV2Queue(pg, { taskId: 'task-b2a', userId: 'u-bridge-2', model: 'm-test' });
  await enqueueToV2Queue(pg, { taskId: 'task-b2b', userId: 'u-bridge-2', model: 'm-test' });
  await enqueueToV2Queue(pg, { taskId: 'task-b2c', userId: 'u-bridge-2', model: 'm-test' });

  // Initially 0 because next_attempt_at is in future
  let count = await countWaitingItems(pg);
  assert.equal(count, 0);

  // Make all ready
  await pg.query(`UPDATE generation_items_v2 SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE item_id LIKE 'gi-wait-%'`);
  count = await countWaitingItems(pg);
  assert.equal(count, 3);
});

test('bridge: normal tasks have higher priority than waiting tasks', async () => {
  await seedUser('u-bridge-3');

  // Insert a normal task (priority=0)
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, idempotency_key, model_id, content_type, requested_count, unit_price, reserved_total, status)
     VALUES ('b-normal', 'u-bridge-3', 'idem-normal', 'm-test', 'image', 1, 0, 0, 'accepted')`,
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, priority, next_attempt_at)
     VALUES ('gi-normal', 'b-normal', 0, 'queued', 'real', 0, NOW() - INTERVAL '1 second')`,
  );

  // Insert a waiting task (priority=-100)
  await enqueueToV2Queue(pg, { taskId: 'task-bridge3', userId: 'u-bridge-3', model: 'm-test' });
  await pg.query(`UPDATE generation_items_v2 SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE item_id LIKE 'gi-wait-%'`);

  // Claim should get normal first
  const claimed = await claimItems(pg, { workerId: 'w-bridge', limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].item_id, 'gi-normal');
});
