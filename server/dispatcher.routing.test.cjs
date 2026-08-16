'use strict';
// 集成测试：验证 dispatcher.explainRouting / snapshotAcct / setRoutingWeights 非阻断接入，
// 不连真实 PG（pgPool=null → 退化为空指标，仅按实时态排序）。
const test = require('node:test');
const assert = require('node:assert');
const dispatcher = require('./dispatcher.cjs');

function mkPair(over = {}) {
  return {
    bindingId: over.bindingId != null ? over.bindingId : 'b1',
    model: Object.assign(
      { model_id: over.modelId || 'm1', enabled: true, type: over.type || 'image', capabilities: over.capabilities || {}, bindingWeight: over.bindingWeight || 0 },
      over.modelExtra || {},
    ),
    provider: Object.assign(
      { id: over.providerId || 'p1', enabled: true, capacity_model: over.capacityModel, max_concurrent: over.providerMaxConc },
      over.providerExtra || {},
    ),
  };
}

test('explainRouting 无 PG → 返回可解释决策结构', async () => {
  const pairs = [
    mkPair({ bindingId: 'hi', providerId: 'p_hi', bindingWeight: 1 }),
    mkPair({ bindingId: 'lo', providerId: 'p_lo', bindingWeight: 0 }),
  ];
  const dec = await dispatcher.explainRouting(pairs, { pgPool: null, contentType: 'image' });
  assert.ok(dec.chosen, '应有 chosen');
  assert.ok(Array.isArray(dec.ranking) && dec.ranking.length === 2);
  assert.ok(Array.isArray(dec.rejected) && dec.rejected.length === 0);
  assert.ok(Array.isArray(dec.gateOrder) && dec.gateOrder.length === 7);
  // 每个 ranking 元素带 score / components / gate / reasons（可解释三要素）
  for (const e of dec.ranking) {
    assert.strictEqual(typeof e.score, 'number');
    assert.ok(e.components && typeof e.components.successRate === 'number');
    assert.ok(e.gate && e.gate.capabilityOk === true);
    assert.ok(Array.isArray(e.reasons) && e.reasons.length >= 6);
  }
  // 权重为默认包
  assert.strictEqual(dec.weights.successRate, 0.3);
});

test('explainRouting 排序：人工权重高者排前（无历史、无实时态）', async () => {
  const pairs = [
    mkPair({ bindingId: 'lo', providerId: 'p_lo', bindingWeight: 0 }),
    mkPair({ bindingId: 'hi', providerId: 'p_hi', bindingWeight: 1 }),
  ];
  const dec = await dispatcher.explainRouting(pairs, { pgPool: null, contentType: 'image' });
  assert.strictEqual(dec.ranking[0].bindingId, 'hi');
});

test('snapshotAcct 全新账号 → 视为可用（不限流/不冷却/并发空）', () => {
  const snap = dispatcher.snapshotAcct(mkPair({ providerId: 'p_new' }));
  assert.strictEqual(snap.cooldownUntil, 0);
  assert.strictEqual(snap.consecutiveRejects, 0);
  assert.strictEqual(snap.conc, 0);
  assert.ok(snap.concCap >= 1);
});

test('setRoutingWeights 仅覆盖存在的键，且不破坏默认', () => {
  const before = dispatcher.getRoutingWeights();
  const overridden = dispatcher.setRoutingWeights({ manualWeight: 0.9, bogus: 123 });
  assert.strictEqual(overridden.manualWeight, 0.9);
  assert.strictEqual(overridden.successRate, before.successRate); // 未覆盖项保持默认
  assert.strictEqual(overridden.bogus, undefined);
  // 还原，避免影响其他测试
  dispatcher.setRoutingWeights(before);
});

test('snapshotAcct 含 cbState（CLOSED 初始态）— 熔断状态机已接入 dispatcher', () => {
  const snap = dispatcher.snapshotAcct(mkPair({ providerId: 'p_cb_init' }));
  assert.ok(snap.cbState, 'snapshotAcct 应携带熔断态');
  assert.strictEqual(snap.cbState.state, 'CLOSED');
  assert.strictEqual(snap.cbState.probeCount, 0);
  assert.strictEqual(snap.cbState.failCount, 0);
});

test('dispatcher 经由共享 router 模块接入熔断状态机（cbAdmit/cbRecordOutcome 可用）', () => {
  const R = require('./modules/modelhub/router.cjs');
  assert.strictEqual(typeof R.cbAdmit, 'function');
  assert.strictEqual(typeof R.cbRecordOutcome, 'function');
  assert.strictEqual(typeof R.cbInitState, 'function');
});

// ─── Phase A：切换调用（dispatchOne 的候选序列由 router.routeBindings 权威驱动）───
test('事实锁定：buildDispatchSequence 顺序 == routeBindings ranking（生产链路由路由权威驱动）', () => {
  const R = require('./modules/modelhub/router.cjs');
  const pairs = [
    mkPair({ bindingId: 'a', providerId: 'p_a', bindingWeight: 0.2 }),
    mkPair({ bindingId: 'b', providerId: 'p_b', bindingWeight: 0.8 }),
    mkPair({ bindingId: 'c', providerId: 'p_c', bindingWeight: 0.5 }),
  ];
  const seq = dispatcher.buildDispatchSequence(pairs, { contentType: 'image' });
  const rb = R.routeBindings(pairs, { weights: R.DEFAULT_WEIGHTS, seed: 1, contentType: 'image' });
  const expectOrder = rb.ranking.map((r) => r.bindingId);
  assert.deepStrictEqual(seq.map((p) => p.bindingId), expectOrder);
});

test('buildDispatchSequence 开启 → best-first（人工权重高者排前）', () => {
  const pairs = [
    mkPair({ bindingId: 'lo', providerId: 'p_lo', bindingWeight: 0 }),
    mkPair({ bindingId: 'hi', providerId: 'p_hi', bindingWeight: 1 }),
  ];
  const seq = dispatcher.buildDispatchSequence(pairs, { contentType: 'image' });
  assert.strictEqual(seq.length, 2);
  assert.strictEqual(seq[0].bindingId, 'hi');
  assert.strictEqual(seq[1].bindingId, 'lo');
});

test('buildDispatchSequence 关闭（kill-switch）→ 原始顺序，可回退', () => {
  const prev = dispatcher.getRoutingV3Enabled();
  dispatcher.setRoutingV3Enabled(false);
  try {
    const pairs = [
      mkPair({ bindingId: 'lo', providerId: 'p_lo', bindingWeight: 0 }),
      mkPair({ bindingId: 'hi', providerId: 'p_hi', bindingWeight: 1 }),
    ];
    const seq = dispatcher.buildDispatchSequence(pairs, { contentType: 'image' });
    assert.strictEqual(seq.length, 2);
    assert.strictEqual(seq[0].bindingId, 'lo'); // 原始顺序保留
    assert.strictEqual(seq[1].bindingId, 'hi');
  } finally {
    dispatcher.setRoutingV3Enabled(prev);
  }
});

test('buildDispatchSequence 路由异常 → 退化为原始顺序（非阻断，兼容层兜底）', () => {
  const R = require('./modules/modelhub/router.cjs');
  const orig = R.routeBindings;
  R.routeBindings = () => { throw new Error('boom'); };
  try {
    const pairs = [
      mkPair({ bindingId: 'lo', providerId: 'p_lo', bindingWeight: 0 }),
      mkPair({ bindingId: 'hi', providerId: 'p_hi', bindingWeight: 1 }),
    ];
    const seq = dispatcher.buildDispatchSequence(pairs, { contentType: 'image' });
    assert.strictEqual(seq.length, 2);
    assert.strictEqual(seq[0].bindingId, 'lo'); // 退化为原始顺序
    assert.strictEqual(seq[1].bindingId, 'hi');
  } finally {
    R.routeBindings = orig;
  }
});

test('setRoutingV3Enabled / getRoutingV3Enabled 可读写 kill-switch', () => {
  const prev = dispatcher.getRoutingV3Enabled();
  try {
    assert.strictEqual(dispatcher.setRoutingV3Enabled(false), false);
    assert.strictEqual(dispatcher.getRoutingV3Enabled(), false);
    assert.strictEqual(dispatcher.setRoutingV3Enabled(true), true);
    assert.strictEqual(dispatcher.getRoutingV3Enabled(), true);
  } finally {
    dispatcher.setRoutingV3Enabled(prev);
  }
});

// ─── Phase A 续：权重热配置（settings.app.routingWeights → generate() 每请求载入）───
test('applyRuntimeSettings 读 settings.app.routingWeights 并热载入路由权重（与 setRoutingWeights 同契约）', () => {
  const before = dispatcher.getRoutingWeights();
  try {
    dispatcher.applyRuntimeSettings({ routingWeights: { health: 0.42, bogus: 99, successRate: 'x' } });
    const w = dispatcher.getRoutingWeights();
    assert.strictEqual(w.health, 0.42);                          // 合法数值键被覆盖
    assert.strictEqual(w.successRate, before.successRate);       // 非数值键被忽略，保留默认
    assert.strictEqual(w.bogus, undefined);                      // 越界键不污染权重包
    assert.strictEqual(w.manualWeight, before.manualWeight);     // 未提供键保持默认
  } finally {
    dispatcher.setRoutingWeights(before);
  }
});

test('applyRuntimeSettings 同时处理 kill-switch 与权重（单一事实来源 = settings.app）', () => {
  const prevV3 = dispatcher.getRoutingV3Enabled();
  const before = dispatcher.getRoutingWeights();
  try {
    dispatcher.applyRuntimeSettings({ routingV3Enabled: false, routingWeights: { health: 0.1 } });
    assert.strictEqual(dispatcher.getRoutingV3Enabled(), false);   // kill-switch 同机制生效
    assert.strictEqual(dispatcher.getRoutingWeights().health, 0.1); // 权重同机制载入
  } finally {
    dispatcher.setRoutingV3Enabled(prevV3);
    dispatcher.setRoutingWeights(before);
  }
});

test('applyRuntimeSettings 非对象/空值 → 安全空操作（不抛、不改全局态）', () => {
  const before = dispatcher.getRoutingWeights();
  const prevV3 = dispatcher.getRoutingV3Enabled();
  dispatcher.applyRuntimeSettings(null);
  dispatcher.applyRuntimeSettings(undefined);
  dispatcher.applyRuntimeSettings('not-an-object');
  assert.deepStrictEqual(dispatcher.getRoutingWeights(), before);
  assert.strictEqual(dispatcher.getRoutingV3Enabled(), prevV3);
});
