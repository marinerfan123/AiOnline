'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTestPool, initTestSchema, truncateAll, closeTestPool, assertSafeTestDatabase
} = require('../../tests/helpers/test-db.cjs');
const { claimItems, transitionItem, reapExpiredLeases } = require('./lease.cjs');
const { processItem } = require('./generation-worker.cjs');
const { claimReconciling, resolveReconcilingItem } = require('./reconciler.cjs');
const { FakeProvider } = require('./fake-provider.cjs');
const { createProviderAdapter } = require('./provider-adapter.cjs');
const { FaultInjector } = require('./fault-injection.cjs');

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

// ─── C1: Queue → Worker claim → Success path ───

test('C1: item moves queued -> leased -> generating -> generated', async () => {
  // Insert a queued item
  const batchId = `b-c1-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-c1-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, priority)
     VALUES ($1, $2, 0, 'queued', 'real', 0)`,
    [itemId, batchId]
  );

  // Claim
  const claimed = await claimItems(pg, { workerId: 'w1', limit: 10 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, 'leased');

  // Process with success provider — createProviderAdapter normalizes the result
  const fp = new FakeProvider({ defaultOutcome: 'success' });
  const providerGenerate = createProviderAdapter({ dispatchSingle: fp.dispatchSingle.bind(fp) });

  const r = await processItem(pg, claimed[0], { providerGenerate });
  assert.equal(r.status, 'generated');
});

// ─── C2: Worker crash → lease expiry → reaper reclaims ───

test('C2: expired lease is reaped back to queued/retry_wait', async () => {
  const batchId = `b-c2-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-c2-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, lease_owner,
      lease_expires_at, lease_version, priority)
     VALUES ($1, $2, 0, 'leased', 'real', 'crashed-worker', NOW() - INTERVAL '5 minutes', 1, 0)`,
    [itemId, batchId]
  );

  // Verify item is expired
  const before = await pg.query(`SELECT status FROM generation_items_v2 WHERE item_id=$1`, [itemId]);
  assert.equal(before.rows[0].status, 'leased');

  // Reaper runs
  const reaped = await reapExpiredLeases(pg, { limit: 10 });
  assert.ok(reaped.length >= 1, 'reaper should find expired lease');

  // Verify item is reclaimed
  const after = await pg.query(`SELECT status FROM generation_items_v2 WHERE item_id=$1`, [itemId]);
  assert.ok(['queued', 'retry_wait'].includes(after.rows[0].status),
    `reaped item should be queued or retry_wait, got: ${after.rows[0].status}`);
});

// ─── C3: Worker crashes during generating → reaper → reconciling ───

test('C3: item stuck in generating is reaped to reconciling', async () => {
  const batchId = `b-c3-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-c3-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, lease_owner,
      lease_expires_at, lease_version, priority)
     VALUES ($1, $2, 0, 'generating', 'real', 'crashed-worker', NOW() - INTERVAL '5 minutes', 1, 0)`,
    [itemId, batchId]
  );

  // Reaper
  const reaped = await reapExpiredLeases(pg, { limit: 10 });
  assert.ok(reaped.length >= 1);

  // Should move to reconciling (not permanent generating)
  const after = await pg.query(`SELECT status FROM generation_items_v2 WHERE item_id=$1`, [itemId]);
  assert.equal(after.rows[0].status, 'reconciling');
});

// ─── C4: Concurrent workers — only one claims the item ───

test('C4: two workers racing — only one claims the item', async () => {
  const batchId = `b-c4-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-c4-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, priority)
     VALUES ($1, $2, 0, 'queued', 'real', 0)`,
    [itemId, batchId]
  );

  // Both workers claim in same transaction batch
  const [claimedA, claimedB] = await Promise.all([
    claimItems(pg, { workerId: 'wa', limit: 10 }),
    claimItems(pg, { workerId: 'wb', limit: 10 }),
  ]);

  // Only one should get it
  const total = claimedA.length + claimedB.length;
  assert.equal(total, 1, 'FOR UPDATE SKIP LOCKED should ensure only one worker claims');
});

// ─── Reconciler tests ───

test('D2: reconciler queries provider — success -> generated', async () => {
  const batchId = `b-d2-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-d2-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, lease_owner,
      lease_expires_at, lease_version, provider_request_id, priority)
     VALUES ($1, $2, 0, 'reconciling', 'real', 'wr', NULL, 1, 'pr-123', 0)`,
    [itemId, batchId]
  );

  // Claim reconciling items
  const items = await claimReconciling(pg, { workerId: 'wr' });
  assert.equal(items.length, 1);

  // Resolve with provider success
  const result = await resolveReconcilingItem(pg, items[0], {
    queryProviderStatus: async () => ({ status: 'success', providerUrl: 'https://fake.test/recovered.png' }),
  });
  assert.equal(result.status, 'generated');
});

test('D2: reconciler queries provider — unknown -> review_required', async () => {
  const batchId = `b-d2b-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-d2b-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, lease_owner,
      lease_expires_at, lease_version, provider_request_id, priority)
     VALUES ($1, $2, 0, 'reconciling', 'real', 'wr', NULL, 1, 'pr-456', 0)`,
    [itemId, batchId]
  );

  const items = await claimReconciling(pg, { workerId: 'wr' });
  const result = await resolveReconcilingItem(pg, items[0], {
    queryProviderStatus: async () => ({ status: 'unknown', error: 'provider timeout' }),
  });
  assert.equal(result.status, 'review_required');
});

test('D2: reconciler queries provider — failed -> retry_wait', async () => {
  const batchId = `b-d2c-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-d2c-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, lease_owner,
      lease_expires_at, lease_version, provider_request_id, priority)
     VALUES ($1, $2, 0, 'reconciling', 'real', 'wr', NULL, 1, 'pr-789', 0)`,
    [itemId, batchId]
  );

  const items = await claimReconciling(pg, { workerId: 'wr' });
  const result = await resolveReconcilingItem(pg, items[0], {
    queryProviderStatus: async () => ({ status: 'failed', error: 'provider error' }),
  });
  assert.equal(result.status, 'retry_wait');
});

test('D2: reconciler queries provider — exception -> review_required', async () => {
  const batchId = `b-d2d-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-d2d-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, lease_owner,
      lease_expires_at, lease_version, provider_request_id, priority)
     VALUES ($1, $2, 0, 'reconciling', 'real', 'wr', NULL, 1, 'pr-err', 0)`,
    [itemId, batchId]
  );

  const items = await claimReconciling(pg, { workerId: 'wr' });
  const result = await resolveReconcilingItem(pg, items[0], {
    queryProviderStatus: async () => { throw new Error('network error'); },
  });
  assert.equal(result.status, 'review_required');
});

test('D2: reconciler stale_lease protection', async () => {
  const batchId = `b-d2e-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-test', 'm-stable-diffusion-xl', 1, '{}', 'image', 100, 100, 'running', $1)`,
    [batchId]
  );
  const itemId = `i-d2e-${Date.now()}`;
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, lease_owner,
      lease_expires_at, lease_version, provider_request_id, priority)
     VALUES ($1, $2, 0, 'reconciling', 'real', 'wr', NULL, 2, 'pr-stale', 0)`,
    [itemId, batchId]
  );

  // Claim with wrong lease_version
  const result = await resolveReconcilingItem(pg, { item_id: itemId, lease_version: 1, provider_request_id: 'pr-stale' }, {
    queryProviderStatus: async () => ({ status: 'success', providerUrl: 'u' }),
  });
  assert.equal(result.status, 'stale_lease');
});
