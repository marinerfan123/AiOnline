'use strict';
/**
 * tick-mount.test.cjs — runActivityTick/runGroupTick 接入装配的单元测试（无 DB，假 store）。
 *
 * 覆盖：
 *   1. buildWorkerTicks 装配列表含 activityTick/groupTick（恒注册）。
 *   2. activityTick/groupTick 把 workerId + enabled 旗标从装配上下文透传给
 *      runActivityTick/runGroupTick（workerId 缺省进程 pid 风格）。
 *   3. 旗标 off → tick 内部 no-op（runActivityTick/runGroupTick 直接返回 {enabled:false}，
 *      不要求 workerId、不领活）——「装配即注册 + tick 内旗标 no-op」双保险。
 *   4. 旗标 on → 单跑（假 store）：activity 经 createActivityRunner.runOnce 领 1 行并完成；
 *      group 经注入假 store + 假 processItem 领 1 组 1 item 并 dispatch。
 *
 * 运行：node --test server/modules/generation-v2/tick-mount.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkerTicks } = require('./worker-service.cjs');
const { runActivityTick, runGroupTick } = require('./generation-worker.cjs');

// 保存/清理 env，保证 off 测试确定性（runActivityTick/runGroupTick 会读 env）。
const ENV_KEYS = ['GENERATION_V2_ACTIVITY_RUNNER', 'GENERATION_V2_GROUP_RUNNER'];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
test.beforeEach(clearEnv);
test.after(clearEnv);

function baseDeps(overrides = {}) {
  return {
    runWorkerTick: async () => {},
    runUploadTick: async () => {},
    claimReconciling: async () => [],
    publishOutbox: async () => {},
    reapExpiredLeases: async () => {},
    reapExpiredUploads: async () => {},
    writeHeartbeat: async () => {},
    ...overrides,
  };
}

// ── 1. 装配列表含新 tick（恒注册） ───────────────────────────────
test('buildWorkerTicks 装配含 activityTick/groupTick（恒注册）', () => {
  const d = baseDeps({
    runActivityTick: async () => {},
    runGroupTick: async () => {},
  });
  const t = buildWorkerTicks(d, { workerId: 'w' });
  assert.equal(typeof t.generationTick, 'function');
  assert.equal(typeof t.uploadTick, 'function');
  assert.equal(typeof t.reconcileTick, 'function');
  assert.equal(typeof t.outboxTick, 'function');
  assert.equal(typeof t.reaperTick, 'function');
  assert.equal(typeof t.activityTick, 'function', 'activityTick 应恒注册');
  assert.equal(typeof t.groupTick, 'function', 'groupTick 应恒注册');
});

// ── 2. workerId + enabled 旗标透传 ────────────────────────────────
test('activityTick/groupTick 透传 workerId 与 enabled 旗标（缺省 pid 风格 workerId）', async () => {
  const seen = [];
  const d = baseDeps({
    runActivityTick: async (_pg, opts) => { seen.push(['activity', opts]); return { claimed: 0 }; },
    runGroupTick: async (_pg, opts) => { seen.push(['group', opts]); return { groups: 0, claimed: 0 }; },
  });
  const t = buildWorkerTicks(d, { workerId: 'w-9', activityEnabled: true, groupEnabled: true });
  await t.activityTick({});
  await t.groupTick({});
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], 'activity');
  assert.equal(seen[0][1].workerId, 'w-9');
  assert.equal(seen[0][1].enabled, true);
  assert.equal(seen[1][0], 'group');
  assert.equal(seen[1][1].workerId, 'w-9');
  assert.equal(seen[1][1].enabled, true);
});

test('缺省 workerId 为 pid 风格（v2-<pid>）', async () => {
  let gotWorkerId = null;
  const d = baseDeps({
    runActivityTick: async (_pg, opts) => { gotWorkerId = opts.workerId; return { claimed: 0 }; },
    runGroupTick: async () => ({ groups: 0, claimed: 0 }),
  });
  const t = buildWorkerTicks(d, {});
  await t.activityTick({});
  assert.match(gotWorkerId, /^v2-\d+$/, `缺省 workerId 应为 v2-<pid> 风格，实际 ${gotWorkerId}`);
});

test('默认 off：未传旗标时透传 enabled=false', async () => {
  let gotEnabled = undefined;
  const d = baseDeps({
    runActivityTick: async (_pg, opts) => { gotEnabled = opts.enabled; return { claimed: 0 }; },
    runGroupTick: async () => ({ groups: 0, claimed: 0 }),
  });
  const t = buildWorkerTicks(d, { workerId: 'w' });
  await t.activityTick({});
  assert.equal(gotEnabled, false);
});

// ── 3. 旗标 off → tick 内部 no-op（不要求 workerId） ──────────────
test('runActivityTick 默认 off：no-op，不要求 workerId', async () => {
  const r = await runActivityTick(null, {}, {});
  assert.equal(r.enabled, false);
  assert.equal(r.claimed, 0);
});

test('runGroupTick 默认 off：no-op，不要求 workerId', async () => {
  const r = await runGroupTick(null, {}, {});
  assert.equal(r.enabled, false);
  assert.equal(r.claimed, 0);
});

// ── 4. 旗标 on → 单跑（假 store） ────────────────────────────────
test('runActivityTick 旗标 on：经 runner 领 1 行并完成（假 store）', async () => {
  const claimed = [];
  const completed = [];
  const store = {
    claim: async ({ workerId, limit }) => {
      claimed.push({ workerId, limit });
      return [{ id: 'a1', activity_type: 'PREPARE_ASSETS', status: 'pending', attempt_count: 0 }];
    },
    adopt: async () => [],
    renewLease: async () => ({ id: 'a1' }),
    complete: async ({ id, workerId }) => { completed.push({ id, workerId }); return { id, status: 'succeeded' }; },
    fail: async () => null,
  };
  const ran = [];
  const worker = async (a) => { ran.push(a.id); return { ok: true }; };

  const r = await runActivityTick(null, { workerId: 'w-1', enabled: true }, { store, activityWorker: worker });
  assert.equal(r.claimed, 1);
  assert.equal(r.done, 1);
  assert.deepEqual(ran, ['a1']);
  assert.deepEqual(completed, [{ id: 'a1', workerId: 'w-1' }]);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].workerId, 'w-1');
});

test('runActivityTick 旗标 on 但缺 activityWorker → 抛 TypeError', async () => {
  await assert.rejects(
    () => runActivityTick(null, { workerId: 'w-1', enabled: true }, { store: {} }),
    /activityWorker is required/,
  );
});

test('runGroupTick 旗标 on：单跑领 1 组 1 item 并 dispatch（假 store）', async () => {
  const dispatched = [];
  const store = {
    listActiveGroups: async () => [{ id: 'g-1', policy: { concurrency: 1, failurePolicy: 'fail_fast' } }],
    hasFailedItem: async () => false,
    countInFlight: async () => 0,
    claimGroupItems: async ({ groupId, workerId }) => {
      assert.equal(groupId, 'g-1');
      assert.equal(workerId, 'w-1');
      return [{ item_id: 'i-1' }];
    },
    markRunning: async () => {},
    failGroup: async () => {},
    groupItemCounts: async () => ({ total: 1, done: 0, failed: 0, canceled: 0 }),
    finalizeGroup: async () => {},
  };
  const processItem = async (_pg, item) => { dispatched.push(item.item_id); return { status: 'leased' }; };

  const r = await runGroupTick(null, { workerId: 'w-1', enabled: true }, { store, processItem });
  assert.equal(r.enabled, true);
  assert.equal(r.claimed, 1);
  assert.equal(r.dispatched, 1);
  assert.deepEqual(dispatched, ['i-1']);
});
