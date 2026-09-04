'use strict';
/**
 * Event Reducer + Webhook Inbox — 契约测试（L16+L19 合并）。
 * 覆盖 §57-60 四道闸：duplicate 幂等 / out-of-order 降级(reconcile_wait) /
 * terminal regression 拒 / 并发 delivery 防双 reduce；以及 poll 与 webhook 同汇。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createTestPool, initTestSchema, truncateAll, closeTestPool, assertSafeTestDatabase,
} = require('../../tests/helpers/test-db.cjs');
const lease = require('./lease.cjs');
const webhookInbox = require('./webhookInbox.cjs');
const { applyProviderEvent, reduceDecision } = require('./provider-status-router.cjs');

// ── 纯函数/守卫测试（无 DB）────────────────────────────────────────────
function fakeStore(item, { transitionResult } = {}) {
  const calls = { transition: 0, find: 0, lastTransition: null };
  return {
    calls,
    async transitionItem(opts) {
      calls.transition++;
      calls.lastTransition = opts;
      if (transitionResult !== undefined) return transitionResult;
      return { status: opts.to };
    },
    async findItemByProviderRequestId() { calls.find++; return item; },
  };
}
function noopInbox() { return { complete: async () => {}, fail: async () => {} }; }
const verifiedEvt = (extra = {}) => ({ id: 1, signature_state: 'verified', status: 'processing', provider_id: 'prov-red', payload: {}, ...extra });

test('reduceDecision 映射：success→generated / failed→retry_wait / pending→reconcile_wait / unknown→review_required', () => {
  const item = { status: 'reconciling', provider_request_id: 'r1' };
  assert.equal(reduceDecision(item, { status: 'success', providerUrl: 'u' }).to, 'generated');
  assert.equal(reduceDecision(item, { status: 'failed' }).to, 'retry_wait');
  assert.equal(reduceDecision(item, { status: 'pending' }).to, 'reconcile_wait');
  assert.equal(reduceDecision(item, { status: 'unknown' }).to, 'review_required');
});

test('applyProviderEvent: 验签 failed 拒绝 reduce（Guard 1）', async () => {
  const store = fakeStore({ item_id: 'i', status: 'reconciling' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(),
    event: verifiedEvt({ signature_state: 'failed' }),
    normalizedStatus: { status: 'success', providerUrl: 'u' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.reason, 'signature_failed');
  assert.equal(store.calls.transition, 0);
});

test('applyProviderEvent: 已 reduced 的重复事件幂等 no-op（Guard 2）', async () => {
  const store = fakeStore({ item_id: 'i', status: 'reconciling' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(),
    event: verifiedEvt({ status: 'reduced' }),
    normalizedStatus: { status: 'success', providerUrl: 'u' },
  });
  assert.equal(r.outcome, 'duplicate');
  assert.equal(store.calls.transition, 0);
});

test('applyProviderEvent: 终态回归拒绝 done（Guard 3）', async () => {
  const store = fakeStore({ item_id: 'i', status: 'done' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(), event: verifiedEvt(),
    normalizedStatus: { status: 'success', providerUrl: 'u' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.reason, 'terminal_regression');
  assert.equal(store.calls.transition, 0);
});

test('applyProviderEvent: 乱序 stale 事件降级 reconcile_wait（Guard 4）', async () => {
  const store = fakeStore({ item_id: 'i', status: 'generated', provider_url: 'u' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(), event: verifiedEvt(),
    normalizedStatus: { status: 'pending' },
  });
  assert.equal(r.outcome, 'out_of_order');
  assert.equal(r.reason, 'reconcile_wait');
  assert.equal(store.calls.transition, 0);
});

test('applyProviderEvent: 源状态非收敛态（reconcile_wait）→ 降级 reconcile_wait（Guard 5）', async () => {
  const store = fakeStore({ item_id: 'i', status: 'reconcile_wait' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(), event: verifiedEvt(),
    normalizedStatus: { status: 'success', providerUrl: 'u' },
  });
  assert.equal(r.outcome, 'out_of_order');
  assert.equal(r.reason, 'reconcile_wait');
  assert.equal(store.calls.transition, 0);
});

test('applyProviderEvent: item 不存在拒绝', async () => {
  const store = fakeStore(null);
  const r = await applyProviderEvent({
    store, inbox: noopInbox(), event: verifiedEvt(),
    normalizedStatus: { status: 'success', providerUrl: 'u' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.reason, 'item_not_found');
});

test('applyProviderEvent: success 归一出 reduce 到 generated（poll/webhook 同形）', async () => {
  const store = fakeStore({ item_id: 'i', status: 'reconciling', lease_version: 1, provider_request_id: 'r1' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(),
    event: verifiedEvt({ payload: { provider_request_id: 'r1' } }),
    normalizedStatus: { status: 'success', providerUrl: 'u' },
  });
  assert.equal(r.outcome, 'reduced');
  assert.equal(r.to, 'generated');
  assert.equal(store.calls.lastTransition.patch.provider_url, 'u');
});

test('applyProviderEvent: 并发 CAS 失败 → concurrent_noop 防双 reduce', async () => {
  const store = fakeStore({ item_id: 'i', status: 'reconciling' }, { transitionResult: null });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(), event: verifiedEvt(),
    normalizedStatus: { status: 'success', providerUrl: 'u' },
  });
  assert.equal(r.outcome, 'concurrent_noop');
});

test('applyProviderEvent: 早期 webhook（generating）+ success → 直边 generating>generated', async () => {
  const store = fakeStore({ item_id: 'i', status: 'generating', lease_version: 2, provider_request_id: 'r2' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(), event: verifiedEvt({ payload: { provider_request_id: 'r2' } }),
    normalizedStatus: { status: 'success', providerUrl: 'u' },
  });
  assert.equal(r.outcome, 'reduced');
  assert.equal(r.to, 'generated');
  assert.equal(store.calls.lastTransition.from, 'generating');
});

// ── PG 集成测试 ────────────────────────────────────────────────────────
let pg;
test.before(async () => {
  assertSafeTestDatabase(process.env.TEST_PG_DATABASE || 'moling_test');
  pg = createTestPool();
  await initTestSchema(pg);
  await pg.query(fs.readFileSync(path.join(__dirname, '../../db/migrations/0062_webhook_inbox.sql'), 'utf8'));
});
test.after(async () => closeTestPool(pg));
test.beforeEach(async () => {
  await pg.query('TRUNCATE TABLE webhook_inbox RESTART IDENTITY');
  await truncateAll(pg);
});

async function seedItem({ itemId = 'i-red', status = 'reconciling', providerUrl = null, leaseVersion = 1 } = {}) {
  await pg.query(
    `INSERT INTO users (id,email,display_name,password_hash,reward_credits,recharge_credits)
     VALUES ('u-red','red@test.local','Red','$2b$10$fake',100,100)`,
  );
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id,user_id,idempotency_key,model_id,content_type,requested_count,unit_price,reserved_total,request_payload)
     VALUES ('b-red','u-red','idem-red','m-red','image',1,1,1,'{}')`,
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id,batch_id,item_index,status,mode,lease_owner,lease_version,lease_expires_at,provider_id,provider_request_id,provider_url)
     VALUES ($1,'b-red',0,$2,'real','worker-red',$3,NOW() + INTERVAL '5 minutes','prov-red','req-red',$4)`,
    [itemId, status, leaseVersion, providerUrl],
  );
}

function makeStore() {
  return {
    transitionItem: (opts) => lease.transitionItem(pg, opts),
    findItemByProviderRequestId: async (providerId, reqId) => {
      const r = await pg.query(
        `SELECT * FROM generation_items_v2 WHERE provider_request_id=$1 AND ($2::text IS NULL OR provider_id=$2) LIMIT 1`,
        [reqId, providerId],
      );
      return (r.rows && r.rows[0]) || null;
    },
  };
}
function makeInbox() {
  return { complete: (o) => webhookInbox.complete(pg, o), fail: (o) => webhookInbox.fail(pg, o) };
}

test('Gate8: 重复事件只 reduce 一次（insertIfNew dedupe + 幂等 complete）', async () => {
  await seedItem();
  const payload = { provider_request_id: 'req-red', video_url: 'https://prov/out.mp4' };
  const a = await webhookInbox.insertIfNew(pg, { providerId: 'prov-red', providerEventId: 'evt-1', eventType: 'completed', payload, signatureState: 'verified' });
  const b = await webhookInbox.insertIfNew(pg, { providerId: 'prov-red', providerEventId: 'evt-1', eventType: 'completed', payload, signatureState: 'verified' });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false, 'dedupe: 第二次 insertIfNew 不落新行');
  const cnt = await pg.query(`SELECT count(*)::int AS n FROM webhook_inbox`);
  assert.equal(cnt.rows[0].n, 1, '去重后仅一行');

  const row = await webhookInbox.claimNext(pg, { workerId: 'w1' });
  assert.ok(row, 'claimNext 领到唯一行');

  const r = await applyProviderEvent({
    store: makeStore(), inbox: makeInbox(), event: row,
    normalizedStatus: { status: 'success', providerUrl: 'https://prov/out.mp4' },
  });
  assert.equal(r.outcome, 'reduced');

  // 同事件再次 reduce（已 reduced）→ duplicate 幂等，不再动 item
  const again = await applyProviderEvent({
    store: makeStore(), inbox: makeInbox(), event: { ...row, status: 'reduced' },
    normalizedStatus: { status: 'success', providerUrl: 'https://prov/out.mp4' },
  });
  assert.equal(again.outcome, 'duplicate');

  const item = await pg.query(`SELECT status, provider_url FROM generation_items_v2 WHERE item_id='i-red'`);
  assert.equal(item.rows[0].status, 'generated');
  assert.equal(item.rows[0].provider_url, 'https://prov/out.mp4');
  const inb = await pg.query(`SELECT status FROM webhook_inbox WHERE id=$1`, [row.id]);
  assert.equal(inb.rows[0].status, 'reduced');
});

test('Gate9: 并发双 claim 单 reduce（FOR UPDATE SKIP LOCKED）', async () => {
  await seedItem();
  await webhookInbox.insertIfNew(pg, {
    providerId: 'prov-red', providerEventId: 'evt-9', eventType: 'completed',
    payload: { provider_request_id: 'req-red', video_url: 'https://prov/out9.mp4' }, signatureState: 'verified',
  });

  const clientA = await pg.connect();
  const clientB = await pg.connect();
  let rowA, rowB;
  try {
    await clientA.query('BEGIN');
    await clientB.query('BEGIN');
    rowA = await webhookInbox.claimNext(clientA, { workerId: 'worker-a', leaseSeconds: 60 });
    rowB = await webhookInbox.claimNext(clientB, { workerId: 'worker-b', leaseSeconds: 60 });
    await clientA.query('COMMIT');
    await clientB.query('COMMIT');
  } catch (e) {
    await clientA.query('ROLLBACK').catch(() => {});
    await clientB.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    clientA.release(); clientB.release();
  }
  const winners = [rowA, rowB].filter(Boolean);
  assert.equal(winners.length, 1, '并发双 claim 只一方得行（SKIP LOCKED）');

  const r = await applyProviderEvent({
    store: makeStore(), inbox: makeInbox(), event: winners[0],
    normalizedStatus: { status: 'success', providerUrl: 'https://prov/out9.mp4' },
  });
  assert.equal(r.outcome, 'reduced');

  const item = await pg.query(`SELECT status, provider_url FROM generation_items_v2 WHERE item_id='i-red'`);
  assert.equal(item.rows[0].status, 'generated');
  assert.equal(item.rows[0].provider_url, 'https://prov/out9.mp4');

  // 无剩余可领 → 不可能二次 reduce
  const again = await webhookInbox.claimNext(pg, { workerId: 'w1' });
  assert.equal(again, null);
});

test('验签态 failed 不 reduce（item 保持 reconciling，行转 failed）', async () => {
  await seedItem();
  await webhookInbox.insertIfNew(pg, {
    providerId: 'prov-red', providerEventId: 'evt-fail', eventType: 'completed',
    payload: { provider_request_id: 'req-red', video_url: 'https://prov/out.mp4' }, signatureState: 'failed',
  });
  const row = await webhookInbox.claimNext(pg, { workerId: 'w1' });
  assert.equal(row.signature_state, 'failed');

  const r = await applyProviderEvent({
    store: makeStore(), inbox: makeInbox(), event: row,
    normalizedStatus: { status: 'success', providerUrl: 'https://prov/out.mp4' },
  });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.reason, 'signature_failed');

  const item = await pg.query(`SELECT status FROM generation_items_v2 WHERE item_id='i-red'`);
  assert.equal(item.rows[0].status, 'reconciling');
  const inb = await pg.query(`SELECT status FROM webhook_inbox WHERE id=$1`, [row.id]);
  assert.equal(inb.rows[0].status, 'failed');
});

test('乱序 stale 事件降级 reconcile_wait（item 已 generated 不回退）', async () => {
  await seedItem({ status: 'generated', providerUrl: 'https://prov/done.mp4' });
  await webhookInbox.insertIfNew(pg, {
    providerId: 'prov-red', providerEventId: 'evt-ooo', eventType: 'processing',
    payload: { provider_request_id: 'req-red' }, signatureState: 'verified',
  });
  const row = await webhookInbox.claimNext(pg, { workerId: 'w1' });

  const r = await applyProviderEvent({
    store: makeStore(), inbox: makeInbox(), event: row,
    normalizedStatus: { status: 'pending' },
  });
  assert.equal(r.outcome, 'out_of_order');
  assert.equal(r.reason, 'reconcile_wait');

  const item = await pg.query(`SELECT status, provider_url FROM generation_items_v2 WHERE item_id='i-red'`);
  assert.equal(item.rows[0].status, 'generated');
  assert.equal(item.rows[0].provider_url, 'https://prov/done.mp4');
});

test('poll 路径同汇：inbox=null + queryProviderStatus 同形结果直接 reduce', async () => {
  await seedItem();
  const r = await applyProviderEvent({
    store: makeStore(),
    inbox: null,
    event: { signature_state: 'verified', provider_id: 'prov-red', payload: { provider_request_id: 'req-red' } },
    normalizedStatus: { status: 'success', providerUrl: 'https://prov/poll.mp4' }, // 与 queryProviderStatus 返回值同形
    providerRequestId: 'req-red',
  });
  assert.equal(r.outcome, 'reduced');
  assert.equal(r.to, 'generated');
  const item = await pg.query(`SELECT status, provider_url FROM generation_items_v2 WHERE item_id='i-red'`);
  assert.equal(item.rows[0].status, 'generated');
  assert.equal(item.rows[0].provider_url, 'https://prov/poll.mp4');
});
