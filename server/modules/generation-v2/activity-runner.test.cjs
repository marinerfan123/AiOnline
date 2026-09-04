'use strict';
/**
 * L9 — Activity 执行循环测试（假 pg 语义的内存 store + 真实 worker 模拟）。
 * 覆盖：失败只重试该 activity、重试计数递增、timeout 独立、
 *       幂等重入拒、lease 到期他 worker 接管 + 旧 owner fencing 拒、心跳续租。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityRunner, ACTIVITY_TYPES } = require('./activity-runner.cjs');

/**
 * 内存 store：用 JS 复刻 lease.cjs 的 SQL 语义（fencing / expiry / attempt 计数）。
 * 时间由 clock 显式推进，保证测试确定性。
 */
function makeMemoryStore() {
  const rows = new Map();
  let t = 1_000_000;
  const clock = { now: () => t, advance(ms) { t += ms; } };
  const now = clock.now;

  function seed(a) {
    rows.set(a.id, {
      id: a.id,
      job_id: a.job_id || 'job-1',
      attempt_id: a.attempt_id || null,
      activity_type: a.activity_type,
      activity_revision: a.activity_revision || 1,
      status: a.status || 'pending',
      attempt_count: a.attempt_count || 0,
      started_at: null,
      heartbeat_at: null,
      next_retry_at: a.next_retry_at ?? 0,
      completed_at: null,
      error_code: null,
      lease_owner: a.lease_owner || null,
      lease_expires_at: a.lease_expires_at || null,
    });
  }

  const get = (id) => rows.get(id);

  async function claim({ workerId, limit = 10, leaseSeconds = 120 }) {
    const picked = [];
    for (const a of rows.values()) {
      if (picked.length >= limit) break;
      if ((a.status === 'pending' || a.status === 'waiting_retry')
          && (a.lease_expires_at == null || a.lease_expires_at < now())
          && a.next_retry_at <= now()) picked.push(a);
    }
    picked.sort((x, y) => x.next_retry_at - y.next_retry_at || (x.id < y.id ? -1 : 1));
    return picked.map((a) => {
      a.status = 'running';
      a.lease_owner = workerId;
      a.lease_expires_at = now() + leaseSeconds * 1000;
      a.heartbeat_at = now();
      a.attempt_count += 1;
      if (!a.started_at) a.started_at = now();
      return { ...a };
    });
  }

  async function adopt({ workerId, limit = 10, leaseSeconds = 120 }) {
    const picked = [];
    for (const a of rows.values()) {
      if (picked.length >= limit) break;
      if (['pending', 'waiting_retry', 'running'].includes(a.status)
          && a.lease_expires_at != null && a.lease_expires_at < now()) picked.push(a);
    }
    picked.sort((x, y) => x.lease_expires_at - y.lease_expires_at || (x.id < y.id ? -1 : 1));
    return picked.map((a) => {
      a.status = 'running';
      a.lease_owner = workerId;
      a.lease_expires_at = now() + leaseSeconds * 1000;
      a.heartbeat_at = now();
      a.attempt_count += 1;
      return { ...a };
    });
  }

  async function renewLease({ id, workerId, leaseSeconds = 120 }) {
    const a = rows.get(id);
    if (!a) return null;
    if (a.lease_owner !== workerId) return null;
    if (!['pending', 'waiting_retry', 'running'].includes(a.status)) return null;
    if (a.lease_expires_at == null || a.lease_expires_at <= now()) return null;
    a.lease_expires_at = now() + leaseSeconds * 1000;
    a.heartbeat_at = now();
    return { ...a };
  }

  async function complete({ id, workerId }) {
    const a = rows.get(id);
    if (!a) return null;
    if (a.lease_owner !== workerId) return null;
    if (!['pending', 'waiting_retry', 'running'].includes(a.status)) return null;
    a.status = 'done';
    a.completed_at = now();
    a.lease_owner = null;
    a.lease_expires_at = null;
    return { ...a };
  }

  async function fail({ id, workerId, status = 'waiting_retry', errorCode = null, nextRetryAt = null }) {
    const a = rows.get(id);
    if (!a) return null;
    if (a.lease_owner !== workerId) return null;
    if (!['pending', 'waiting_retry', 'running'].includes(a.status)) return null;
    a.status = status;
    a.error_code = errorCode;
    a.next_retry_at = nextRetryAt ? nextRetryAt.getTime() : now();
    a.lease_owner = null;
    a.lease_expires_at = null;
    return { ...a };
  }

  return { store: { claim, adopt, renewLease, complete, fail, get, seed }, clock };
}

async function waitFor(cond, timeoutMs = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let store;
let clock;
test.beforeEach(() => { ({ store, clock } = makeMemoryStore()); });

test('失败只重试该 activity，不重跑已完成步骤（§43）', async () => {
  store.seed({ id: 'submit', activity_type: 'SUBMIT_PROVIDER', status: 'pending' });
  store.seed({ id: 'prepare', activity_type: 'PREPARE_ASSETS', status: 'done' });
  const ran = [];
  const worker = async (a) => {
    ran.push(a.id);
    return a.id === 'submit' ? { ok: false, errorCode: 'RATE_LIMIT' } : { ok: true };
  };
  const runner = createActivityRunner({ store, worker, workerId: 'w', heartbeatMs: 60000, maxAttempts: 5 });
  const r = await runner.runOnce();
  assert.equal(r.waiting_retry, 1);
  assert.equal(r.done, 0);
  assert.deepEqual(ran, ['submit'], '只执行失败的 submit，done 的 prepare 不重跑');
  assert.equal(store.get('submit').status, 'waiting_retry');
  assert.equal(store.get('submit').error_code, 'RATE_LIMIT');
  assert.equal(store.get('prepare').status, 'done');
  assert.equal(store.get('prepare').attempt_count, 0, '已完成步骤 attempt_count 不变');
});

test('重试计数递增：失败→waiting_retry→重领→attempt_count 递增→成功', async () => {
  store.seed({ id: 'a1', activity_type: 'VERIFY_OUTPUT', status: 'pending', attempt_count: 0 });
  let calls = 0;
  const worker = async () => { calls += 1; return calls === 1 ? { ok: false, errorCode: 'X' } : { ok: true }; };
  const runner = createActivityRunner({
    store, worker, workerId: 'w', heartbeatMs: 60000, maxAttempts: 3, backoffMs: 1000, now: clock.now,
  });
  const r1 = await runner.runOnce();
  assert.equal(r1.waiting_retry, 1);
  assert.equal(store.get('a1').attempt_count, 1);

  clock.advance(1001); // 越过 next_retry_at
  const r2 = await runner.runOnce();
  assert.equal(r2.done, 1);
  assert.equal(store.get('a1').attempt_count, 2, '重试后 attempt_count 递增');
  assert.equal(store.get('a1').status, 'done');
  assert.equal(calls, 2);
});

test('超过 maxAttempts 后转 failed 不再 waiting_retry', async () => {
  store.seed({ id: 'a1', activity_type: 'FINALIZE_ASSETS', status: 'pending' });
  const worker = async () => ({ ok: false, errorCode: 'OSS_ERR' });
  const runner = createActivityRunner({
    store, worker, workerId: 'w', heartbeatMs: 60000, maxAttempts: 2, backoffMs: 1, now: clock.now,
  });
  await runner.runOnce(); // attempt 1 -> waiting_retry
  assert.equal(store.get('a1').status, 'waiting_retry');
  clock.advance(2);
  await runner.runOnce(); // attempt 2 -> failed (达到上限)
  assert.equal(store.get('a1').status, 'failed');
  assert.equal(store.get('a1').error_code, 'OSS_ERR');
});

test('timeout 独立：慢 activity 超时不影响其它 activity 完成', async () => {
  store.seed({ id: 'slow', activity_type: 'OBSERVE_PROVIDER', status: 'pending' });
  store.seed({ id: 'fast', activity_type: 'ACQUIRE_QUOTA', status: 'pending' });
  const worker = async (a, { signal }) => {
    if (a.id === 'slow') {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ ok: true }), 500);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
      });
    }
    return { ok: true };
  };
  const runner = createActivityRunner({ store, worker, workerId: 'w', heartbeatMs: 60000, timeoutMs: 30, maxAttempts: 5 });
  const r = await runner.runOnce();
  assert.equal(r.done, 1);
  assert.equal(r.waiting_retry, 1);
  assert.equal(store.get('fast').status, 'done', 'fast 独立完成');
  assert.equal(store.get('slow').status, 'waiting_retry');
  assert.equal(store.get('slow').error_code, 'TIMEOUT', 'timeout 只归因于该 activity');
});

test('幂等重入拒：并发 runOnce 同 activity 只跑一次', async () => {
  store.seed({ id: 'a1', activity_type: 'SETTLE_BILLING', status: 'pending' });
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const worker = async () => { calls += 1; await gate; return { ok: true }; };
  const runner = createActivityRunner({ store, worker, workerId: 'w', heartbeatMs: 60000 });
  const p1 = runner.runOnce();
  await waitFor(() => calls === 1);
  const r2 = await runner.runOnce(); // 重入 → 立即返回
  assert.equal(r2.note, 'tick_in_progress');
  release();
  const r1 = await p1;
  assert.equal(r1.done, 1);
  assert.equal(calls, 1, 'worker 只执行一次');
  assert.equal(store.get('a1').status, 'done');
});

test('done 的 activity 不会被再次 claim（顺序重入不双跑）', async () => {
  store.seed({ id: 'a1', activity_type: 'PREPARE_ASSETS', status: 'pending' });
  let calls = 0;
  const worker = async () => { calls += 1; return { ok: true }; };
  const runner = createActivityRunner({ store, worker, workerId: 'w', heartbeatMs: 60000 });
  await runner.runOnce();
  assert.equal(calls, 1);
  await runner.runOnce();
  assert.equal(calls, 1, '第二次 runOnce 不重跑 done 的 activity');
});

test('lease 到期 → 他 worker 接管，旧 owner 的 complete/fail 被 fencing 拒（§51）', async () => {
  store.seed({
    id: 'a1', activity_type: 'SUBMIT_PROVIDER', status: 'running', attempt_count: 1,
    lease_owner: 'A', lease_expires_at: clock.now() + 5000,
  });
  assert.equal((await store.adopt({ workerId: 'B' })).length, 0, '租约未到期不可接管');
  clock.advance(5001);
  const adopted = await store.adopt({ workerId: 'B', limit: 10 });
  assert.equal(adopted.length, 1, '到期后他 worker 接管成功');
  assert.equal(adopted[0].lease_owner, 'B');
  assert.equal(adopted[0].attempt_count, 2, '接管递增 attempt_count');
  assert.equal(await store.complete({ id: 'a1', workerId: 'A' }), null, '旧 owner complete 被拒');
  assert.equal(await store.fail({ id: 'a1', workerId: 'A', status: 'waiting_retry' }), null, '旧 owner fail 被拒');
  const done = await store.complete({ id: 'a1', workerId: 'B' });
  assert.equal(done.status, 'done', '新 owner 正常完成');
});

test('runner：执行中 lease 被接管 → complete 被 fencing 拒（fenced）', async () => {
  store.seed({ id: 'a1', activity_type: 'FINALIZE_ASSETS', status: 'pending' });
  const worker = async (a) => {
    // 模拟执行中途另一 worker 接管了我们的租约
    store.get(a.id).lease_owner = 'B';
    return { ok: true };
  };
  const runner = createActivityRunner({ store, worker, workerId: 'A', heartbeatMs: 60000 });
  const r = await runner.runOnce();
  assert.equal(r.fenced, 1);
  assert.equal(r.done, 0);
  assert.equal(store.get('a1').status, 'running', '未 done（被 fencing 拒）');
  assert.equal(store.get('a1').lease_owner, 'B');
});

test('runner：长任务期间心跳续租', async () => {
  store.seed({ id: 'a1', activity_type: 'OBSERVE_PROVIDER', status: 'pending' });
  let renews = 0;
  const orig = store.renewLease.bind(store);
  store.renewLease = async (opts) => { renews += 1; return orig(opts); };
  const worker = async () => { await new Promise((r) => setTimeout(r, 250)); return { ok: true }; };
  const runner = createActivityRunner({ store, worker, workerId: 'w', heartbeatMs: 100, timeoutMs: 1000 });
  await runner.runOnce();
  assert.ok(renews >= 2, `心跳续租 ${renews} 次`);
  assert.equal(store.get('a1').status, 'done');
});

test('未知 activity_type 直接 failed，不进入 retry', async () => {
  store.seed({ id: 'a1', activity_type: 'NOT_A_REAL_TYPE', status: 'pending' });
  let calls = 0;
  const worker = async () => { calls += 1; return { ok: true }; };
  const runner = createActivityRunner({ store, worker, workerId: 'w', heartbeatMs: 60000 });
  const r = await runner.runOnce();
  assert.equal(r.failed, 1);
  assert.equal(calls, 0, '未知类型不调用 worker');
  assert.equal(store.get('a1').status, 'failed');
  assert.equal(store.get('a1').error_code, 'UNKNOWN_ACTIVITY_TYPE');
});

test('缺少 store/worker/workerId 时拒绝创建', () => {
  assert.throws(() => createActivityRunner({ worker: async () => {}, workerId: 'w' }), /store/);
  assert.throws(() => createActivityRunner({ store: {}, workerId: 'w' }), /worker/);
  assert.throws(() => createActivityRunner({ store: {}, worker: async () => {} }), /workerId/);
});

test('ACTIVITY_TYPES 为 8 类且无重复', () => {
  assert.equal(ACTIVITY_TYPES.length, 8);
  assert.equal(new Set(ACTIVITY_TYPES).size, 8);
});
