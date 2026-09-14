'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createTestPool, initTestSchema, truncateAll, closeTestPool, assertSafeTestDatabase
} = require('../../tests/helpers/test-db.cjs');
const { claimItems, transitionItem } = require('./lease.cjs');
const { finalizeUploadedItem } = require('./upload-finalize.cjs');

let pg;
test.before(async () => {
  assertSafeTestDatabase(process.env.TEST_PG_DATABASE || 'moling_test');
  pg = createTestPool();
  await initTestSchema(pg);
  await pg.query(fs.readFileSync(path.join(__dirname, '../../db/migrations/0003_generation_v2_runtime_schema_parity.sql'), 'utf8'));
});
test.after(async () => closeTestPool(pg));
test.beforeEach(async () => truncateAll(pg));

async function seedBatchItem({ itemId = 'i-fence', status = 'leased', owner = 'worker-a', leaseVersion = 1, leaseExpiry = "NOW()+INTERVAL '5 minutes'" } = {}) {
  await pg.query(`INSERT INTO users (id,email,display_name,password_hash,reward_credits,recharge_credits) VALUES ('u-fence','fence@test.local','Fence','$2b$10$fake',100,100)`);
  await pg.query(`INSERT INTO generation_batches_v2 (batch_id,user_id,idempotency_key,model_id,content_type,requested_count,unit_price,reserved_total,request_payload) VALUES ('b-fence','u-fence','idem-fence','m-fence','image',1,1,1,'{}')`);
  await pg.query(`INSERT INTO generation_items_v2 (item_id,batch_id,item_index,status,mode,lease_owner,lease_version,lease_expires_at,provider_url) VALUES ($1,'b-fence',0,$2,'real',$3,$4,${leaseExpiry},'https://provider/item.png')`, [itemId, status, owner, leaseVersion]);
  await pg.query(`INSERT INTO generation_credit_holds_v2 (item_id,user_id,pool,amount,status,kind,ref) VALUES ($1,'u-fence','reward',1,'held','reward','v2:b-fence:reserve')`, [itemId]);
}

test('wrong owner lease transition is rejected by PostgreSQL fence', async () => {
  await seedBatchItem({ owner: 'worker-a' });
  const row = await transitionItem(pg, { itemId: 'i-fence', leaseVersion: 1, workerId: 'worker-b', from: 'leased', to: 'generating' });
  assert.equal(row, null);
});

test('expired lease transition is rejected by database NOW fence', async () => {
  await seedBatchItem({ owner: 'worker-a', leaseExpiry: "NOW()-INTERVAL '1 second'" });
  const row = await transitionItem(pg, { itemId: 'i-fence', leaseVersion: 1, workerId: 'worker-a', from: 'leased', to: 'generating' });
  assert.equal(row, null);
});

test('stale lease version transition is rejected', async () => {
  await seedBatchItem({ owner: 'worker-a', leaseVersion: 2 });
  const row = await transitionItem(pg, { itemId: 'i-fence', leaseVersion: 1, workerId: 'worker-a', from: 'leased', to: 'generating' });
  assert.equal(row, null);
});

test('wrong expected status transition is rejected', async () => {
  await seedBatchItem({ status: 'generating', owner: 'worker-a' });
  const row = await transitionItem(pg, { itemId: 'i-fence', leaseVersion: 1, workerId: 'worker-a', from: 'leased', to: 'generating' });
  assert.equal(row, null);
});

test('valid owner/version/unexpired transition is accepted', async () => {
  await seedBatchItem({ owner: 'worker-a' });
  const row = await transitionItem(pg, { itemId: 'i-fence', leaseVersion: 1, workerId: 'worker-a', from: 'leased', to: 'generating' });
  assert.ok(row);
  assert.equal(row.status, 'generating');
});

test('worker A late after worker B reclaim cannot transition authoritatively', async () => {
  await seedBatchItem({ status: 'queued', owner: null, leaseVersion: 0, leaseExpiry: 'NULL' });
  const [a] = await claimItems(pg, { workerId: 'worker-a', limit: 1, leaseSeconds: 10 });
  assert.equal(a.lease_owner, 'worker-a');
  await pg.query(`UPDATE generation_items_v2 SET status='queued', lease_owner=NULL, lease_expires_at=NULL WHERE item_id='i-fence'`);
  const [b] = await claimItems(pg, { workerId: 'worker-b', limit: 1, leaseSeconds: 10 });
  assert.equal(b.lease_owner, 'worker-b');
  const lateA = await transitionItem(pg, { itemId: 'i-fence', leaseVersion: Number(a.lease_version), workerId: 'worker-a', from: 'leased', to: 'generating' });
  assert.equal(lateA, null);
});

test('wrong worker cannot finalize, commit hold, or write ledger', async () => {
  await seedBatchItem({ status: 'uploading', owner: 'worker-a', leaseVersion: 3 });
  const r = await finalizeUploadedItem(pg, { itemId: 'i-fence', leaseVersion: 3, workerId: 'worker-b', ossUrl: 'oss://x' });
  assert.equal(r.changed, false);
  const hold = await pg.query(`SELECT status FROM generation_credit_holds_v2 WHERE item_id='i-fence'`);
  const ledger = await pg.query(`SELECT count(*)::int AS n FROM credit_transactions WHERE ref='v2:i-fence:commit'`);
  assert.equal(hold.rows[0].status, 'held');
  assert.equal(ledger.rows[0].n, 0);
});

test('expired worker cannot finalize', async () => {
  await seedBatchItem({ status: 'uploading', owner: 'worker-a', leaseVersion: 3, leaseExpiry: "NOW()-INTERVAL '1 second'" });
  const r = await finalizeUploadedItem(pg, { itemId: 'i-fence', leaseVersion: 3, workerId: 'worker-a', ossUrl: 'oss://x' });
  assert.equal(r.changed, false);
});

test('reclaimed worker can finalize and late worker cannot double finalize/commit/ledger', async () => {
  await seedBatchItem({ status: 'uploading', owner: 'worker-b', leaseVersion: 4 });
  const ok = await finalizeUploadedItem(pg, { itemId: 'i-fence', leaseVersion: 4, workerId: 'worker-b', ossUrl: 'oss://x' });
  assert.equal(ok.changed, true);
  const late = await finalizeUploadedItem(pg, { itemId: 'i-fence', leaseVersion: 3, workerId: 'worker-a', ossUrl: 'oss://late' });
  assert.equal(late.changed, false);
  const item = await pg.query(`SELECT status,oss_url FROM generation_items_v2 WHERE item_id='i-fence'`);
  const hold = await pg.query(`SELECT status FROM generation_credit_holds_v2 WHERE item_id='i-fence'`);
  const ledger = await pg.query(`SELECT count(*)::int AS n FROM credit_transactions WHERE ref='v2:i-fence:commit'`);
  assert.equal(item.rows[0].status, 'done');
  assert.equal(item.rows[0].oss_url, 'oss://x');
  assert.equal(hold.rows[0].status, 'committed');
  assert.equal(ledger.rows[0].n, 1);
});
