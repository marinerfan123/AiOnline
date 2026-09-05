'use strict';
/**
 * Provider Status Router — Poll Policy（L21）契约测试。
 * 覆盖 §63-65：4 类 deadline 判定 / 缺省回退 / 等待≠取消语义。
 * 表 0063（provider_poll_policies）：provider-specific poll 策略 + 4 类 deadline。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createTestPool, initTestSchema, truncateAll, closeTestPool, assertSafeTestDatabase,
} = require('../../tests/helpers/test-db.cjs');
const lease = require('./lease.cjs');
const {
  pollPolicyFor, evaluatePollDeadline, normalizePolicy, reduceDecision, applyProviderEvent,
  DEFAULT_POLL_POLICY, POLL_STOPPED_DEFER_MS,
} = require('./provider-status-router.cjs');

const MIGRATION_0063 = path.join(__dirname, '../../db/migrations/0063_poll_policy.sql');

// ── 纯函数：4 类 deadline 判定（无 DB）────────────────────────────────
test('evaluatePollDeadline: no_deadline 永不停（含超大 elapsed 也不停）', () => {
  const policy = { deadline_kind: 'no_deadline', poll_interval_ms: 1000 };
  const r = evaluatePollDeadline(policy, {
    windowElapsedMs: 1e9, attemptElapsedMs: 1e9, jobElapsedMs: 1e9, attemptCount: 999,
  });
  assert.equal(r.continue, true);
  assert.equal(r.nextInMs, 1000);
});

test('evaluatePollDeadline: fixed_window 窗口耗时 ≥ deadline_ms 停 poll', () => {
  const policy = { deadline_kind: 'fixed_window', deadline_ms: 5000, poll_interval_ms: 1000 };
  assert.equal(evaluatePollDeadline(policy, { windowElapsedMs: 0 }).continue, true);
  assert.equal(evaluatePollDeadline(policy, { windowElapsedMs: 4999 }).continue, true);
  const r = evaluatePollDeadline(policy, { windowElapsedMs: 5000 });
  assert.equal(r.continue, false);
  assert.equal(r.reason, 'fixed_window_exceeded');
});

test('evaluatePollDeadline: attempt_ttl 单次 attempt 耗时 ≥ deadline_ms 停 poll', () => {
  const policy = { deadline_kind: 'attempt_ttl', deadline_ms: 2000, poll_interval_ms: 500 };
  assert.equal(evaluatePollDeadline(policy, { attemptElapsedMs: 1999 }).continue, true);
  const r = evaluatePollDeadline(policy, { attemptElapsedMs: 2000 });
  assert.equal(r.continue, false);
  assert.equal(r.reason, 'attempt_ttl_exceeded');
});

test('evaluatePollDeadline: job_ttl job 年龄 ≥ deadline_ms 停 poll', () => {
  const policy = { deadline_kind: 'job_ttl', deadline_ms: 60000, poll_interval_ms: 1000 };
  assert.equal(evaluatePollDeadline(policy, { jobElapsedMs: 59999 }).continue, true);
  const r = evaluatePollDeadline(policy, { jobElapsedMs: 60000 });
  assert.equal(r.continue, false);
  assert.equal(r.reason, 'job_ttl_exceeded');
});

test('evaluatePollDeadline: max_polls 达到上限停 poll', () => {
  const policy = { deadline_kind: 'no_deadline', max_polls: 3, poll_interval_ms: 1000 };
  assert.equal(evaluatePollDeadline(policy, { attemptCount: 2 }).continue, true);
  const r = evaluatePollDeadline(policy, { attemptCount: 3 });
  assert.equal(r.continue, false);
  assert.equal(r.reason, 'max_polls_reached');
});

test('evaluatePollDeadline: 未知 deadline_kind 视为 no_deadline（安全：不停不误取消）', () => {
  const policy = { deadline_kind: 'bogus', deadline_ms: 1, poll_interval_ms: 1000 };
  const r = evaluatePollDeadline(policy, { windowElapsedMs: 1e9 });
  assert.equal(r.continue, true);
});

test('normalizePolicy: 缺省字段回退默认常量（缺省回退）', () => {
  assert.deepEqual(normalizePolicy(undefined), {
    poll_interval_ms: DEFAULT_POLL_POLICY.poll_interval_ms,
    deadline_kind: DEFAULT_POLL_POLICY.deadline_kind,
    deadline_ms: null,
    max_polls: null,
    retry_after_cap_ms: DEFAULT_POLL_POLICY.retry_after_cap_ms,
  });
  assert.deepEqual(normalizePolicy(null), { ...DEFAULT_POLL_POLICY }, 'null 入参 == 默认常量');
  // pg 行可能给字符串（INT 列读出为 number，但防御性兜底）
  const fromString = normalizePolicy({ poll_interval_ms: '5000', deadline_kind: 'job_ttl', deadline_ms: '3000' });
  assert.equal(fromString.poll_interval_ms, 5000);
  assert.equal(fromString.deadline_kind, 'job_ttl');
  assert.equal(fromString.deadline_ms, 3000);
});

test('normalizePolicy: 非法 deadline_kind 回退 no_deadline', () => {
  assert.equal(normalizePolicy({ deadline_kind: 'nope' }).deadline_kind, 'no_deadline');
});

// ── 纯函数：等待≠取消（reduceDecision）────────────────────────────────
test('reduceDecision: pending + deadline 到期 → reconcile_wait（非 canceled），next_attempt_at 远端', () => {
  const item = { status: 'reconciling', provider_request_id: 'r1' };
  const d = reduceDecision(item, { status: 'pending' },
    { deadline_kind: 'fixed_window', deadline_ms: 1000, poll_interval_ms: 5000 },
    { windowElapsedMs: 2000 });
  assert.equal(d.to, 'reconcile_wait');
  assert.notEqual(d.to, 'canceled');
  assert.equal(d.patch.last_error_code, 'POLL_STOPPED');
  assert.match(d.patch.last_error, /NOT cancelled/i);
  assert.ok(d.patch.next_attempt_at.getTime() > Date.now() + POLL_STOPPED_DEFER_MS - 1000, 'next_attempt_at 推到远端停 poll');
});

test('reduceDecision: pending 未到期 → reconcile_wait，next_attempt_at = now + poll_interval_ms', () => {
  const item = { status: 'reconciling', provider_request_id: 'r1' };
  const before = Date.now();
  const d = reduceDecision(item, { status: 'pending' },
    { deadline_kind: 'fixed_window', deadline_ms: 10000, poll_interval_ms: 5000 },
    { windowElapsedMs: 0 });
  assert.equal(d.to, 'reconcile_wait');
  assert.equal(d.patch.last_error_code, 'PROVIDER_PENDING');
  const delta = d.patch.next_attempt_at.getTime() - before;
  assert.ok(delta >= 5000 && delta < 6000, `next_attempt_at 应为 +poll_interval_ms（got ${delta}ms）`);
});

test('reduceDecision: failed + retry_after_cap_ms 封顶重试退避', () => {
  const item = { status: 'reconciling', provider_request_id: 'r1' };
  const before = Date.now();
  const capped = reduceDecision(item, { status: 'failed' }, { retry_after_cap_ms: 5000 });
  const capDelta = capped.patch.next_attempt_at.getTime() - before;
  assert.ok(capDelta >= 5000 && capDelta < 6000, `封顶后应 ≈5000ms（got ${capDelta}ms）`);

  const before2 = Date.now();
  const uncapped = reduceDecision(item, { status: 'failed' }); // 默认 retry_after_cap_ms=30000
  const uncapDelta = uncapped.patch.next_attempt_at.getTime() - before2;
  assert.ok(uncapDelta >= 30000 && uncapDelta < 31000, `默认应 ≈30000ms（got ${uncapDelta}ms）`);
});

// ── from 一致性（修复前 failed/pending/unknown 硬编码 from='reconciling'，对 generating 项 CAS 必失败）──
test('reduceDecision: generating 项 failed/unknown 用实际 from（不硬编码 reconciling）', () => {
  const item = { status: 'generating', provider_request_id: 'r-gen' };
  const failed = reduceDecision(item, { status: 'failed' });
  assert.equal(failed.from, 'generating');
  assert.equal(failed.to, 'retry_wait'); // generating>retry_wait 是合法边

  const unknown = reduceDecision(item, { status: 'unknown' });
  assert.equal(unknown.from, 'generating');
  assert.equal(unknown.to, 'review_required'); // generating>review_required 是合法边
});

test('reduceDecision: generating 项 pending 收敛 generating>reconciling（非 reconcile_wait）', () => {
  const item = { status: 'generating', provider_request_id: 'r-gen' };
  const d = reduceDecision(item, { status: 'pending' });
  assert.equal(d.from, 'generating');
  assert.equal(d.to, 'reconciling', 'generating>reconcile_wait 非法，收敛到 reconciling 交 poll 对账');
  assert.equal(d.patch.last_error_code, 'PROVIDER_PENDING');

  // reconciling 项 pending 仍走 reconcile_wait（旧行为不变）
  const rw = reduceDecision({ status: 'reconciling', provider_request_id: 'r1' }, { status: 'pending' });
  assert.equal(rw.from, 'reconciling');
  assert.equal(rw.to, 'reconcile_wait');
});

// ── 纯函数：applyProviderEvent 等待≠取消（fake store）──────────────────
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
const noopInbox = () => ({ complete: async () => {}, fail: async () => {} });
const verifiedEvt = (extra = {}) => ({ id: 1, signature_state: 'verified', status: 'processing', provider_id: 'prov-red', payload: {}, ...extra });

test('applyProviderEvent: deadline 到期只停 poll 不 cancel（outcome=reduced, to=reconcile_wait）', async () => {
  const store = fakeStore({ item_id: 'i', status: 'reconciling', lease_version: 1, provider_request_id: 'r1' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(),
    event: verifiedEvt({ payload: { provider_request_id: 'r1' } }),
    normalizedStatus: { status: 'pending' },
    pollPolicy: { deadline_kind: 'job_ttl', deadline_ms: 1000, poll_interval_ms: 5000 },
    pollTiming: { jobElapsedMs: 5000 },
  });
  assert.equal(r.outcome, 'reduced');
  assert.equal(r.to, 'reconcile_wait');
  assert.notEqual(r.to, 'canceled');
  assert.equal(store.calls.lastTransition.to, 'reconcile_wait');
  assert.equal(store.calls.lastTransition.patch.last_error_code, 'POLL_STOPPED');
  assert.ok(store.calls.lastTransition.patch.next_attempt_at.getTime() > Date.now() + POLL_STOPPED_DEFER_MS - 1000);
});

test('applyProviderEvent: 未传 pollPolicy/pollTiming 回退默认（no_deadline 继续 poll）', async () => {
  const store = fakeStore({ item_id: 'i', status: 'reconciling', lease_version: 1, provider_request_id: 'r1' });
  const r = await applyProviderEvent({
    store, inbox: noopInbox(),
    event: verifiedEvt({ payload: { provider_request_id: 'r1' } }),
    normalizedStatus: { status: 'pending' },
  });
  assert.equal(r.outcome, 'reduced');
  assert.equal(r.to, 'reconcile_wait');
  assert.equal(store.calls.lastTransition.patch.last_error_code, 'PROVIDER_PENDING');
  assert.notEqual(store.calls.lastTransition.patch.last_error_code, 'POLL_STOPPED');
});

// ── PG 集成：pollPolicyFor 读 0063 + 缺省回退 + 等待≠取消落地 ─────────
let pg;
test.before(async () => {
  assertSafeTestDatabase(process.env.TEST_PG_DATABASE || 'moling_test');
  pg = createTestPool();
  await initTestSchema(pg);
  await pg.query(fs.readFileSync(MIGRATION_0063, 'utf8'));
});
test.after(async () => closeTestPool(pg));
test.beforeEach(async () => {
  await pg.query('TRUNCATE TABLE provider_poll_policies');
  await truncateAll(pg);
});

test('pollPolicyFor: 无行回退默认常量', async () => {
  const r = await pollPolicyFor(pg, 'prov-nope');
  assert.deepEqual(r, { ...DEFAULT_POLL_POLICY });
});

test('pollPolicyFor: 读 0063 行并归一化（含 4 类 deadline_kind 落库）', async () => {
  await pg.query(
    `INSERT INTO provider_poll_policies (provider_id, poll_interval_ms, deadline_kind, deadline_ms, max_polls, retry_after_cap_ms)
     VALUES ('prov-ttl', 2500, 'attempt_ttl', 8000, 12, 9000)`,
  );
  const r = await pollPolicyFor(pg, 'prov-ttl');
  assert.equal(r.poll_interval_ms, 2500);
  assert.equal(r.deadline_kind, 'attempt_ttl');
  assert.equal(r.deadline_ms, 8000);
  assert.equal(r.max_polls, 12);
  assert.equal(r.retry_after_cap_ms, 9000);
});

test('pollPolicyFor: 未建表/查询异常回退默认（不抛错）', async () => {
  const throwingPg = { query: async () => { throw new Error('relation "provider_poll_policies" does not exist'); } };
  assert.deepEqual(await pollPolicyFor(throwingPg, 'prov-x'), { ...DEFAULT_POLL_POLICY });
  assert.deepEqual(await pollPolicyFor(null, 'prov-x'), { ...DEFAULT_POLL_POLICY });
  assert.deepEqual(await pollPolicyFor(pg, null), { ...DEFAULT_POLL_POLICY });
});

async function seedItem({ itemId = 'i-red', status = 'reconciling', leaseVersion = 1 } = {}) {
  await pg.query(
    `INSERT INTO users (id,email,display_name,password_hash,reward_credits,recharge_credits)
     VALUES ('u-red','red@test.local','Red','$2b$10$fake',100,100)`,
  );
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id,user_id,idempotency_key,model_id,content_type,requested_count,unit_price,reserved_total,request_payload)
     VALUES ('b-red','u-red','idem-red','m-red','image',1,1,1,'{}')`,
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id,batch_id,item_index,status,mode,lease_owner,lease_version,lease_expires_at,provider_id,provider_request_id)
     VALUES ($1,'b-red',0,$2,'real','worker-red',$3,NOW() + INTERVAL '5 minutes','prov-red','req-red')`,
    [itemId, status, leaseVersion],
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

test('PG: deadline 到期 → item 落 reconcile_wait（非 canceled），next_attempt_at 远端，等待≠取消', async () => {
  await seedItem();
  await pg.query(
    `INSERT INTO provider_poll_policies (provider_id, poll_interval_ms, deadline_kind, deadline_ms)
     VALUES ('prov-red', 5000, 'fixed_window', 1000)`,
  );
  const policy = await pollPolicyFor(pg, 'prov-red');
  const r = await applyProviderEvent({
    store: makeStore(),
    inbox: null,
    event: { signature_state: 'verified', provider_id: 'prov-red', payload: { provider_request_id: 'req-red' } },
    normalizedStatus: { status: 'pending' },
    providerRequestId: 'req-red',
    pollPolicy: policy,
    pollTiming: { windowElapsedMs: 5000 }, // ≥ deadline_ms 1000 → 停 poll
  });
  assert.equal(r.outcome, 'reduced');
  assert.equal(r.to, 'reconcile_wait');

  const item = await pg.query(`SELECT status, last_error_code, next_attempt_at, lease_expires_at FROM generation_items_v2 WHERE item_id='i-red'`);
  assert.equal(item.rows[0].status, 'reconcile_wait');
  assert.notEqual(item.rows[0].status, 'canceled', 'deadline 到期绝不 cancel');
  assert.equal(item.rows[0].last_error_code, 'POLL_STOPPED');
  assert.ok(new Date(item.rows[0].next_attempt_at).getTime() > Date.now() + POLL_STOPPED_DEFER_MS - 1000, 'next_attempt_at 推到远端（停 poll）');
  assert.equal(item.rows[0].lease_expires_at, null, 'lease 释放交 watchdog');
});

test('PG: deadline 未到期 → 继续 poll（next_attempt_at = now + poll_interval_ms）', async () => {
  await seedItem();
  await pg.query(
    `INSERT INTO provider_poll_policies (provider_id, poll_interval_ms, deadline_kind, deadline_ms)
     VALUES ('prov-red', 5000, 'fixed_window', 10000)`,
  );
  const before = Date.now();
  const r = await applyProviderEvent({
    store: makeStore(),
    inbox: null,
    event: { signature_state: 'verified', provider_id: 'prov-red', payload: { provider_request_id: 'req-red' } },
    normalizedStatus: { status: 'pending' },
    providerRequestId: 'req-red',
    pollPolicy: await pollPolicyFor(pg, 'prov-red'),
    pollTiming: { windowElapsedMs: 0 },
  });
  assert.equal(r.outcome, 'reduced');
  const item = await pg.query(`SELECT status, last_error_code, next_attempt_at FROM generation_items_v2 WHERE item_id='i-red'`);
  assert.equal(item.rows[0].status, 'reconcile_wait');
  assert.equal(item.rows[0].last_error_code, 'PROVIDER_PENDING');
  const delta = new Date(item.rows[0].next_attempt_at).getTime() - before;
  assert.ok(delta >= 5000 && delta < 6000, `next_attempt_at 应为 +poll_interval_ms（got ${delta}ms）`);
});
