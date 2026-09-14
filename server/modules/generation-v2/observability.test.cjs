'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectV2Metrics, evaluateV2Readiness, assessStableWindow, planRollback } = require('./observability.cjs');

test('collectV2Metrics返回状态、队龄、held、outbox和过期租约', async () => {
  const pg = {
    async query(sql) {
      assert.match(sql, /generation_items_v2/);
      return { rows: [{ status_counts: { queued: 5, generating: 2 }, oldest_queue_seconds: '42', expired_leases: '1', held_count: '3', held_amount: '150', outbox_pending: '4', review_required: '2' }] };
    },
  };
  const m = await collectV2Metrics(pg);
  assert.equal(m.queue.queued, 5);
  assert.equal(m.oldestQueueSeconds, 42);
  assert.equal(m.held.amount, 150);
  assert.equal(m.outboxPending, 4);
});

test('readiness要求迁移、数据库、worker心跳和无超龄队列', () => {
  assert.equal(evaluateV2Readiness({ db: true, migration: true, workerHeartbeatAgeSec: 10, oldestQueueSeconds: 60, maxQueueAgeSec: 1200 }).ready, true);
  const r = evaluateV2Readiness({ db: true, migration: false, workerHeartbeatAgeSec: 999, oldestQueueSeconds: 2000, maxQueueAgeSec: 1200 });
  assert.equal(r.ready, false);
  assert.ok(r.reasons.length === 3);
});

test('影子模式不要求worker心跳', () => {
  const r = evaluateV2Readiness({ db: true, migration: true, shadowOnly: true, workerHeartbeatAgeSec: null, oldestQueueSeconds: 0 });
  assert.equal(r.ready, true);
});

// ─── L54 assessStableWindow ──────────────────────────────────────────────

test('assessStableWindow：默认 requiredConsecutive=1，单条 ready 即稳定', () => {
  const r = assessStableWindow([{ ready: true, oldestQueueSeconds: 10 }], { maxQueueAgeSec: 1200 });
  assert.equal(r.stable, true);
  assert.equal(r.mode, 'stable');
  assert.equal(r.windowLength, 1);
});

test('assessStableWindow：达到 requiredConsecutive 连续达标才稳定', () => {
  assert.equal(assessStableWindow([{ ready: true }, { ready: true }, { ready: true }], { requiredConsecutive: 3 }).stable, true);
  const r = assessStableWindow([{ ready: true }, { ready: true }], { requiredConsecutive: 3 });
  assert.equal(r.stable, false);
  assert.equal(r.mode, 'observing');
  assert.equal(r.windowLength, 2);
});

test('assessStableWindow：ready=false 重置窗口', () => {
  const r = assessStableWindow(
    [{ ready: true }, { ready: true }, { ready: false }, { ready: true }],
    { requiredConsecutive: 3 },
  );
  assert.equal(r.stable, false);
  assert.equal(r.mode, 'observing');
  assert.equal(r.windowLength, 1);
});

test('assessStableWindow：超队龄视为失败（有 maxQueueAgeSec 时）', () => {
  const r = assessStableWindow(
    [{ ready: true, oldestQueueSeconds: 10 }, { ready: true, oldestQueueSeconds:2000 }],
    { requiredConsecutive: 2, maxQueueAgeSec: 1200 },
  );
  assert.equal(r.stable, false);
  assert.equal(r.mode, 'unstable');
  assert.equal(r.windowLength, 0);
});

test('assessStableWindow：无 maxQueueAgeSec 时不设队龄界限', () => {
  const r = assessStableWindow(
    [{ ready: true, oldestQueueSeconds: 99999 }, { ready: true, oldestQueueSeconds: 99999 }],
    { requiredConsecutive: 2 },
  );
  assert.equal(r.stable, true);
});

test('assessStableWindow：graceFailures 容忍 N 次失败不重置', () => {
  const r = assessStableWindow(
    [{ ready: true }, { ready: true }, { ready: false }, { ready: true }],
    { requiredConsecutive: 3, graceFailures: 1 },
  );
  assert.equal(r.stable, true);
  assert.equal(r.mode, 'stable');
  assert.equal(r.windowLength, 3);
});

test('assessStableWindow：超出 graceFailures 预算则硬重置', () => {
  const r = assessStableWindow(
    [{ ready: true }, { ready: true }, { ready: false }, { ready: false }, { ready: true }],
    { requiredConsecutive: 3, graceFailures: 1 },
  );
  assert.equal(r.stable, false);
  assert.equal(r.mode, 'observing');
  assert.equal(r.windowLength, 1);
});

test('assessStableWindow：纯指标形态（无 ready 字段）视为 ready=true', () => {
  const snap = { oldestQueueSeconds: 5, expiredLeases: 0, outboxPending: 0 };
  const r = assessStableWindow([snap, snap, snap], { requiredConsecutive: 3, maxQueueAgeSec: 1200 });
  assert.equal(r.stable, true);
  assert.equal(r.mode, 'stable');
});

test('assessStableWindow：非法输入返回 unstable 且不 throw', () => {
  assert.equal(assessStableWindow(null).stable, false);
  assert.equal(assessStableWindow('nope').mode, 'unstable');
  assert.equal(assessStableWindow({}).mode, 'unstable');
  const empty = assessStableWindow([], {});
  assert.equal(empty.stable, false);
  assert.equal(empty.mode, 'unstable');
  assert.equal(empty.reason, 'no observations');
});

// ─── L54 planRollback ────────────────────────────────────────────────────

test('planRollback：video_runtime 返回有序清单，每步含 step/action/guard 字符串', () => {
  const steps = planRollback('video_runtime');
  assert.ok(Array.isArray(steps) && steps.length > 0);
  for (const s of steps) {
    assert.equal(typeof s.step, 'number');
    assert.equal(typeof s.action, 'string');
    assert.ok(s.action.length > 0);
    assert.equal(typeof s.guard, 'string');
    assert.ok(s.guard.length > 0);
  }
  assert.deepEqual(steps.map((s) => s.step), steps.map((_, i) => i + 1));
});

test('planRollback：首步关闭 VIDEO_DURABLE_EVENTS，覆盖全部 8 个 VIDEO_* 旗标', () => {
  const steps = planRollback('video_runtime');
  assert.match(steps[0].action, /FF_VIDEO_DURABLE_EVENTS=0/);
  const actions = steps.map((s) => s.action).join('\n');
  for (const flag of [
    'VIDEO_DURABLE_EVENTS',
    'VIDEO_NEW_ROUTER',
    'VIDEO_NEW_DRIVER_RUNTIME',
    'VIDEO_WORKFLOW_RUNTIME',
    'VIDEO_OPERATION_REGISTRY',
    'VIDEO_SCHEMA_RUNTIME',
    'VIDEO_CANVAS_RUNTIME',
    'VIDEO_SCHEMA_UI',
  ]) {
    assert.ok(actions.includes(`FF_${flag}=0`), `缺少旗标 ${flag}`);
  }
  assert.ok(actions.includes('fire-and-forget'), '缺少 legacy fire-and-forget 回退步骤');
  assert.ok(actions.includes('legacy routing path'), '缺少 dispatcher legacy 回退步骤');
});

test('planRollback：full 为 video_runtime 超集且确定性（两次调用相等）', () => {
  const vr = planRollback('video_runtime');
  const full = planRollback('full');
  assert.ok(full.length > vr.length);
  const a = planRollback('full', { flags: {} });
  const b = planRollback('full', { flags: {} });
  assert.deepEqual(a, b);
});

test('planRollback：未知 scope 返回空数组（fail-closed）', () => {
  assert.deepEqual(planRollback('bogus'), []);
  assert.deepEqual(planRollback(undefined), []);
});
