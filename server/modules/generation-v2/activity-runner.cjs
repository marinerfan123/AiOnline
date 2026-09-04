'use strict';
/**
 * L9 — Activity 执行循环 (§42/§43/§51)。
 *
 * 每个 activity 是 generation_activity_runs(0060) 里的一行，拥有独立的：
 *   - retry（失败只重试该 activity，不重跑已完成步骤，§43）
 *   - timeout（独立于整体 job，互不拖累）
 *   - idempotency（同一 activity 同一时刻只被一个 worker 执行一次）
 *   - lease（lease_owner/lease_expires_at/heartbeat_at，crash 后他 worker 接管，§51）
 *
 * 依赖方向：activity-runner -> lease.cjs（纯 SQL 层），runner 本身不拼 SQL，
 * 通过 store 适配器读写，因此可用内存 store 做确定性测试、用 createPgActivityStore 接真库。
 */
const lease = require('./lease.cjs');

const ACTIVITY_TYPES = lease.ACTIVITY_TYPES;
const ACTIVITY_TYPE_SET = new Set(ACTIVITY_TYPES);

/** 把 lease.cjs 的 SQL 函数绑定到一个 pg pool，作为 runner 的 store。 */
function createPgActivityStore(pg) {
  if (!pg || typeof pg.query !== 'function') throw new TypeError('pg.query is required');
  return {
    claim: (opts) => lease.claimActivity(pg, opts),
    adopt: (opts) => lease.adoptActivity(pg, opts),
    renewLease: (opts) => lease.renewActivityLease(pg, opts),
    complete: (opts) => lease.completeActivity(pg, opts),
    fail: (opts) => lease.failActivity(pg, opts),
  };
}

/**
 * 给 worker 调用包一个硬超时：超时即 abort signal 并 reject（errorCode=TIMEOUT），
 * 同时吃掉 worker 后续的 resolve/reject 避免 unhandled rejection。
 */
function withTimeout(promise, ms, controller) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = Object.assign(new Error('activity timed out'), { code: 'TIMEOUT' });
      try { if (controller) controller.abort(err); } catch (_) {}
      reject(err);
    }, ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
      (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * store: { claim, adopt, renewLease, complete, fail }（见 createPgActivityStore）
 * worker: async (activity, { signal }) => ({ ok:true } | { ok:false, errorCode })
 *         抛出异常视为失败。
 * 返回 { start, stop, runOnce, inFlight }。
 */
function createActivityRunner(opts = {}) {
  const {
    store, worker, workerId,
    maxAttempts = 3,
    timeoutMs = 30000,
    backoffMs = 5000,
    leaseSeconds = 120,
    concurrency = 1,
    onError = () => {},
  } = opts;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  if (!store) throw new TypeError('store is required');
  if (typeof worker !== 'function') throw new TypeError('worker function is required');
  if (!workerId) throw new TypeError('workerId is required');

  const heartbeatMs = Math.max(
    100,
    Number(opts.heartbeatMs) || Math.floor(leaseSeconds * 1000 / 3),
  );

  const inFlight = new Set(); // 幂等重入：同 activity 双跑防护（进程内）
  let tickInProgress = false;
  let loopTimer = null;
  let loopStarted = false;

  async function runOne(activity) {
    const id = activity.id;
    if (inFlight.has(id)) return { status: 'skipped', reason: 'in_flight' };
    if (!ACTIVITY_TYPE_SET.has(activity.activity_type)) {
      await store.fail({ id, workerId, status: 'failed', errorCode: 'UNKNOWN_ACTIVITY_TYPE' });
      return { status: 'failed', reason: 'unknown_activity_type' };
    }

    inFlight.add(id);
    const controller = new AbortController();
    let timer = null;
    timer = setInterval(async () => {
      try {
        // 心跳续租；一旦返回 null 说明已被他 worker 接管，立即中止本步（fencing）
        const row = await store.renewLease({ id, workerId, leaseSeconds });
        if (!row) controller.abort(Object.assign(new Error('lease lost'), { code: 'LEASE_LOST' }));
      } catch (e) { controller.abort(e); }
    }, heartbeatMs);
    timer.unref?.();

    let result;
    try {
      result = await withTimeout(worker(activity, { signal: controller.signal }), timeoutMs, controller);
    } catch (e) {
      result = { ok: false, errorCode: e.code || 'EXCEPTION', errorMessage: e.message };
    } finally {
      clearInterval(timer);
      inFlight.delete(id);
    }

    if (result && result.ok === true) {
      const row = await store.complete({ id, workerId });
      return row ? { status: 'done' } : { status: 'fenced', reason: 'complete_rejected' };
    }

    const errorCode = (result && result.errorCode) || 'FAILED';
    const attempts = Math.max(1, Number(activity.attempt_count) || 1);
    if (attempts >= Number(maxAttempts)) {
      await store.fail({ id, workerId, status: 'failed', errorCode });
      return { status: 'failed', errorCode };
    }
    const nextRetryAt = new Date(now() + Number(backoffMs));
    const row = await store.fail({ id, workerId, status: 'waiting_retry', errorCode, nextRetryAt });
    return row ? { status: 'waiting_retry', errorCode } : { status: 'fenced', reason: 'fail_rejected' };
  }

  async function runOnce({ limit = 10 } = {}) {
    if (tickInProgress) return { claimed: 0, note: 'tick_in_progress' }; // 重入拒
    tickInProgress = true;
    try {
      const claimed = await store.claim({ workerId, limit, leaseSeconds });
      const adopted = await store.adopt({ workerId, limit, leaseSeconds });
      const seen = new Set();
      const list = [];
      for (const a of [...claimed, ...adopted]) {
        if (!seen.has(a.id)) { seen.add(a.id); list.push(a); }
      }
      const summary = { claimed: list.length, done: 0, waiting_retry: 0, failed: 0, fenced: 0, skipped: 0 };
      const batch = Math.max(1, Number(concurrency) || 1);
      for (let i = 0; i < list.length; i += batch) {
        const results = await Promise.all(list.slice(i, i + batch).map(runOne));
        for (const r of results) {
          if (r.status === 'done') summary.done++;
          else if (r.status === 'waiting_retry') summary.waiting_retry++;
          else if (r.status === 'failed') summary.failed++;
          else if (r.status === 'fenced') summary.fenced++;
          else summary.skipped++;
        }
      }
      return summary;
    } finally {
      tickInProgress = false;
    }
  }

  function start({ intervalMs = 1000, limit = 10 } = {}) {
    if (loopStarted) return;
    loopStarted = true;
    loopTimer = setInterval(() => {
      runOnce({ limit }).catch((e) => { try { onError(e); } catch (_) {} });
    }, Math.max(10, Number(intervalMs) || 1000));
    loopTimer.unref?.();
  }

  function stop() {
    loopStarted = false;
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  }

  return { start, stop, runOnce, inFlight };
}

module.exports = { ACTIVITY_TYPES, createActivityRunner, createPgActivityStore };
