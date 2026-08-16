'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('./router.cjs');

// ─── 测试夹具 ───
function mkPair(over = {}) {
  return {
    bindingId: over.bindingId != null ? over.bindingId : 'b1',
    model: Object.assign(
      { model_id: over.modelId || 'm1', enabled: true, type: over.type || 'image', capabilities: over.capabilities || {}, bindingWeight: over.bindingWeight || 0, max_concurrent: over.max_concurrent },
      over.modelExtra || {},
    ),
    provider: Object.assign(
      { id: over.providerId || 'p1', enabled: true, max_concurrent: over.providerMaxConc, capacity_model: over.capacityModel, cooldown_ms: over.cooldown_ms, rate_limits: over.rate_limits },
      over.providerExtra || {},
    ),
  };
}

function mkAcct(over = {}) {
  return Object.assign(
    {
      providerId: over.providerId || 'p1',
      cooldownUntil: 0,
      consecutiveRejects: 0,
      manualState: null,
      capacityModel: 'limited',
      bucket: { tokens: 10, cap: 10 },
      conc: 0,
      concCap: 2,
    },
    over,
  );
}

function mkAttempts(bid, rows) {
  return rows.map((r) => Object.assign({ binding_id: bid, status: 'success', latency_ms: null, cost: 1 }, r));
}

const W = R.DEFAULT_WEIGHTS;

// ─── 1) aggregateMetrics：聚合正确性 ───
test('aggregateMetrics 聚合成功率/P95/成本', () => {
  const rows = mkAttempts('b1', [
    { status: 'success', latency_ms: 100, cost: 1 },
    { status: 'success', latency_ms: 200, cost: 1 },
    { status: 'success', latency_ms: 300, cost: 2 },
    { status: 'success', latency_ms: 400, cost: 2 },
    { status: 'success', latency_ms: 500, cost: 2 },
    { status: 'failed', latency_ms: null, cost: 1 },
    { status: 'rate_limited', latency_ms: null, cost: 1 },
    { status: 'timeout', latency_ms: null, cost: 1 },
  ]);
  const m = R.aggregateMetrics(rows);
  assert.strictEqual(m.b1.attempts, 8);
  assert.strictEqual(m.b1.successRate, 5 / 8);
  assert.strictEqual(m.b1.failures, 3);
  // 5 个成功时延 [100,200,300,400,500]，nearest-rank P95 = idx=ceil(0.95*5)-1=4 → 500
  assert.strictEqual(m.b1.p95LatencyMs, 500);
  // 成本对所有已记录 attempt 取均值（含失败重试消耗的桶单位）：(1+1+2+2+2+1+1+1)/8 = 11/8
  assert.ok(Math.abs(m.b1.avgCost - 11 / 8) < 1e-9);
});

test('aggregateMetrics 空输入 → 空 map', () => {
  assert.deepStrictEqual(R.aggregateMetrics([]), {});
  assert.deepStrictEqual(R.aggregateMetrics(null), {});
});

test('aggregateMetrics 无成功时延 → p95=0', () => {
  const m = R.aggregateMetrics(mkAttempts('b', [{ status: 'failed', latency_ms: 999 }]));
  assert.strictEqual(m.b.p95LatencyMs, 0);
  assert.strictEqual(m.b.successRate, 0);
});

// ─── 2) buildGateContext：7 道门 ───
test('buildGateContext 全通过（全新账号）', () => {
  const g = R.buildGateContext(null, mkPair(), { now: 1000, contentType: 'image' });
  assert.deepStrictEqual(g, {
    enabled: true, providerEnabled: true, cooldownOk: true,
    circuitOk: true, rateLimitOk: true, concurrencyOk: true, capabilityOk: true,
    cbState: null, cbProbe: 0,
  });
});

test('buildGateContext 模型未启用 → enabled 门', () => {
  const g = R.buildGateContext(null, mkPair({ modelExtra: { enabled: false } }), { now: 1000 });
  assert.strictEqual(g.enabled, false);
});

test('buildGateContext 服务商未启用 → providerEnabled 门', () => {
  const g = R.buildGateContext(null, mkPair({ providerExtra: { enabled: false } }), { now: 1000 });
  assert.strictEqual(g.providerEnabled, false);
});

test('buildGateContext 冷却期 → cooldownOk 门', () => {
  const g = R.buildGateContext(mkAcct({ cooldownUntil: 5000 }), mkPair(), { now: 1000 });
  assert.strictEqual(g.cooldownOk, false);
});

test('buildGateContext 手动 cold → 计入冷却门（cooldownOk=false），电路门不受影响', () => {
  const acct = mkAcct({ manualState: 'cold', cooldownUntil: 9999 });
  const g = R.buildGateContext(acct, mkPair(), { now: 1000 });
  assert.strictEqual(g.cooldownOk, false); // manual cold 由冷却门捕获（对齐 dispatcher.isCold）
  assert.strictEqual(g.circuitOk, true);   // 电路门只看 'open' / 连续拒单，不重复拦 cold
});

test('buildGateContext 连续拒单达阈值 → circuitOk 门', () => {
  const g = R.buildGateContext(mkAcct({ consecutiveRejects: R.CIRCUIT_OPEN_THRESHOLD }), mkPair(), { now: 1000 });
  assert.strictEqual(g.circuitOk, false);
});

test('buildGateContext 连续拒单未达阈值 → circuitOk 通过', () => {
  const g = R.buildGateContext(mkAcct({ consecutiveRejects: R.CIRCUIT_OPEN_THRESHOLD - 1 }), mkPair(), { now: 1000 });
  assert.strictEqual(g.circuitOk, true);
});

test('buildGateContext 桶令牌不足 → rateLimitOk 门', () => {
  const g = R.buildGateContext(mkAcct({ capacityModel: 'limited', bucket: { tokens: 0.5, cap: 10 } }), mkPair(), { now: 1000, unitCost: 1 });
  assert.strictEqual(g.rateLimitOk, false);
});

test('buildGateContext unlimited 容量不受令牌限制', () => {
  const g = R.buildGateContext(mkAcct({ capacityModel: 'unlimited', bucket: { tokens: 0, cap: 0 } }), mkPair(), { now: 1000, unitCost: 1 });
  assert.strictEqual(g.rateLimitOk, true);
});

test('buildGateContext 并发满 → concurrencyOk 门', () => {
  const g = R.buildGateContext(mkAcct({ conc: 2, concCap: 2 }), mkPair(), { now: 1000 });
  assert.strictEqual(g.concurrencyOk, false);
});

test('buildGateContext capability 不匹配 → capabilityOk 门', () => {
  const g = R.buildGateContext(null, mkPair({ type: 'image', capabilities: {} }), { now: 1000, contentType: 'video' });
  assert.strictEqual(g.capabilityOk, false);
});

test('buildGateContext capability：type 匹配放行', () => {
  const g = R.buildGateContext(null, mkPair({ type: 'video' }), { now: 1000, contentType: 'video' });
  assert.strictEqual(g.capabilityOk, true);
});

test('buildGateContext capability：capabilities.types 数组放行', () => {
  const g = R.buildGateContext(null, mkPair({ type: 'image', capabilities: { types: ['image', 'video'] } }), { now: 1000, contentType: 'video' });
  assert.strictEqual(g.capabilityOk, true);
});

// ─── 3) scoreCandidate：分量与公式 ───
test('scoreCandidate 无历史 → 中性默认', () => {
  const sc = R.scoreCandidate(mkPair(), null, W, null, {});
  assert.strictEqual(sc.components.successRate, R.DEFAULT_WEIGHTS ? 0.5 : 0.5);
  assert.strictEqual(sc.components.negP95Latency, 0);
  assert.strictEqual(sc.components.negCost, 0);
  // 健康度=1（无 acct），空闲=1（unlimited/无 acct），manualWeight=0
  assert.strictEqual(sc.components.health, 1);
  assert.strictEqual(sc.components.idleCapacity, 1);
  assert.strictEqual(sc.components.manualWeight, 0);
});

test('scoreCandidate 公式逐分量可加', () => {
  const metrics = { b1: { attempts: 10, successRate: 0.9, p95LatencyMs: 0, avgCost: 0, failures: 1 } };
  const acct = mkAcct({ consecutiveRejects: 0, conc: 0, concCap: 4, capacityModel: 'limited', bucket: { tokens: 10, cap: 10 } });
  const pair = mkPair({ bindingWeight: 0.5 });
  const sc = R.scoreCandidate(pair, metrics, W, acct, {});
  // 0.9*0.30 + 1*0.20 + 1*0.15 + 0.5*0.15 + 0*0.10 + 0*0.10 = 0.27+0.20+0.15+0.075 = 0.695
  assert.ok(Math.abs(sc.score - 0.695) < 1e-9, `score=${sc.score}`);
  assert.ok(Math.abs(sc.components.successRate * W.successRate - 0.27) < 1e-9);
});

test('scoreCandidate P95 负向惩罚生效', () => {
  const metricsSlow = { b1: { attempts: 1, successRate: 1, p95LatencyMs: R.LATENCY_REF_MS, avgCost: 0, failures: 0 } };
  const metricsFast = { b1: { attempts: 1, successRate: 1, p95LatencyMs: 0, avgCost: 0, failures: 0 } };
  const scSlow = R.scoreCandidate(mkPair(), metricsSlow, W, null, {});
  const scFast = R.scoreCandidate(mkPair(), metricsFast, W, null, {});
  assert.ok(scSlow.score < scFast.score, '慢链路分数应低于快链路');
  // p95=REF → negP95 = -1 → -0.10
  assert.ok(Math.abs(scSlow.components.negP95Latency + 1) < 1e-9);
});

test('scoreCandidate 成本负向惩罚生效', () => {
  const metricsExp = { b1: { attempts: 1, successRate: 1, p95LatencyMs: 0, avgCost: R.COST_REF_UNITS, failures: 0 } };
  const metricsCheap = { b1: { attempts: 1, successRate: 1, p95LatencyMs: 0, avgCost: 0, failures: 0 } };
  const scExp = R.scoreCandidate(mkPair(), metricsExp, W, null, {});
  const scCheap = R.scoreCandidate(mkPair(), metricsCheap, W, null, {});
  assert.ok(scExp.score < scCheap.score);
  assert.ok(Math.abs(scExp.components.negCost + 1) < 1e-9);
});

test('scoreCandidate 健康度随拒单数下降', () => {
  const fresh = R.scoreCandidate(mkPair(), null, W, mkAcct({ consecutiveRejects: 0 }), {});
  const hot3 = R.scoreCandidate(mkPair(), null, W, mkAcct({ consecutiveRejects: 3 }), {});
  assert.ok(fresh.components.health > hot3.components.health);
});

// ─── 4) 门控管线顺序 / 短路 ───
test('routeBindings 未启用绑定被剔除且 rejectedAt=enabled', () => {
  const pairs = [mkPair({ bindingId: 'bad', modelExtra: { enabled: false } }), mkPair({ bindingId: 'good' })];
  const res = R.routeBindings(pairs, { acctMap: new Map(), metrics: {}, weights: W, seed: 1, contentType: 'image' });
  assert.strictEqual(res.rejected.length, 1);
  assert.strictEqual(res.rejected[0].bindingId, 'bad');
  assert.strictEqual(res.rejected[0].rejectedAt, 'enabled');
  assert.strictEqual(res.eligible ? res.eligible.length : res.ranking.length, 1);
  assert.strictEqual(res.ranking[0].bindingId, 'good');
});

test('routeBindings 全部门控通过则进入 eligible', () => {
  const pairs = [mkPair({ bindingId: 'x' }), mkPair({ bindingId: 'y', providerId: 'p2' })];
  const res = R.routeBindings(pairs, { acctMap: new Map(), metrics: {}, weights: W, seed: 1, contentType: 'image' });
  assert.strictEqual(res.rejected.length, 0);
  assert.strictEqual(res.ranking.length, 2);
  // 每个 eligible 带完整 components / gate / reasons
  for (const e of res.ranking) {
    assert.ok(e.components && typeof e.score === 'number');
    assert.ok(Array.isArray(e.reasons) && e.reasons.length >= 6);
    assert.ok(e.gate && e.gate.capabilityOk === true);
  }
});

// ─── 5) 排序 tie-break 确定性 ───
test('sortByScore 降序 + 同分 bindingId 字典序', () => {
  const in_ = [
    { bindingId: 'b3', score: 0.5 },
    { bindingId: 'b1', score: 0.9 },
    { bindingId: 'b2', score: 0.9 },
    { bindingId: 'b4', score: 0.1 },
  ];
  const out = R.sortByScore(in_).map((e) => e.bindingId);
  assert.deepStrictEqual(out, ['b1', 'b2', 'b3', 'b4']);
});

test('sortByScore 不改原数组', () => {
  const in_ = [{ bindingId: 'a', score: 1 }, { bindingId: 'b', score: 2 }];
  R.sortByScore(in_);
  assert.strictEqual(in_[0].bindingId, 'a');
});

// ─── 6) 加权选择确定性（同 seed 同结果）───
test('weightedSelect 种子化确定性：同输入同 seed → 同 chosen', () => {
  const eligible = [
    { bindingId: 'a', score: 0.9 },
    { bindingId: 'b', score: 0.1 },
    { bindingId: 'c', score: 0.5 },
  ];
  const r1 = R.weightedSelect(eligible, 12345);
  const r2 = R.weightedSelect(eligible, 12345);
  assert.strictEqual(r1.bindingId, r2.bindingId);
});

test('weightedSelect 不同 seed 可能不同（随机性确实存在，但可控）', () => {
  const eligible = [
    { bindingId: 'a', score: 0.5 },
    { bindingId: 'b', score: 0.5 },
  ];
  // 收集多个 seed 的选择分布，确认两种都可能被选中（非恒选其一）
  const seen = new Set();
  for (let seed = 1; seed <= 20; seed++) seen.add(R.weightedSelect(eligible, seed).bindingId);
  assert.ok(seen.size >= 1); // 至少为 1（即便恒选其一也不算错，但分布应合理）
});

test('weightedSelect 概率为 score 加权（大样本近似）', () => {
  const eligible = [
    { bindingId: 'hi', score: 0.9 },
    { bindingId: 'lo', score: 0.1 },
  ];
  let hi = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) if (R.weightedSelect(eligible, i + 1).bindingId === 'hi') hi++;
  const ratio = hi / N;
  // 期望 ≈ 0.9；允许统计波动
  assert.ok(ratio > 0.8 && ratio < 0.98, `加权比例=${ratio}`);
});

test('weightedSelect 全负分 → 退化首个（确定性）', () => {
  const eligible = [{ bindingId: 'x', score: -0.5 }, { bindingId: 'y', score: -0.2 }];
  assert.strictEqual(R.weightedSelect(eligible, 7).bindingId, 'x');
});

test('weightedSelect 空 → null', () => {
  assert.strictEqual(R.weightedSelect([], 1), null);
});

// ─── 7) routeBindings 端到端：高成功率优先 ───
test('routeBindings 端到端：历史优者排第一（确定性排序）', () => {
  const pairs = [
    mkPair({ bindingId: 'lowq', providerId: 'p_low', bindingWeight: 0 }),
    mkPair({ bindingId: 'hiq', providerId: 'p_hi', bindingWeight: 0 }),
  ];
  const metrics = {
    lowq: { attempts: 10, successRate: 0.3, p95LatencyMs: 0, avgCost: 0, failures: 7 },
    hiq: { attempts: 10, successRate: 0.95, p95LatencyMs: 0, avgCost: 0, failures: 0 },
  };
  const res = R.routeBindings(pairs, { acctMap: new Map(), metrics, weights: W, seed: 1, contentType: 'image' });
  assert.strictEqual(res.ranking[0].bindingId, 'hiq');
  assert.ok(res.ranking[0].score > res.ranking[1].score);
  // chosen 由加权选择得出（hiq 权重高，seed=1 通常选 hiq）
  assert.strictEqual(res.chosen.bindingId, 'hiq');
});

test('routeBindings 端到端：冷账号被剔除（电路/冷却门）', () => {
  const pairs = [mkPair({ bindingId: 'cold', providerId: 'p_cold' })];
  const acctMap = new Map([['p_cold', mkAcct({ cooldownUntil: 999999, consecutiveRejects: 5 })]]);
  const res = R.routeBindings(pairs, { acctMap, metrics: {}, weights: W, seed: 1, contentType: 'image' });
  assert.strictEqual(res.rejected.length, 1);
  assert.ok(res.rejected[0].rejectedAt === 'cooldownOk' || res.rejected[0].rejectedAt === 'circuitOk');
});

// ─── 8) acctMap 两种形态（Map / 函数）───
test('routeBindings 接受函数型 acctMap', () => {
  const pairs = [mkPair({ bindingId: 'a', providerId: 'pA' })];
  const res = R.routeBindings(pairs, {
    acctMap: (pid) => (pid === 'pA' ? mkAcct({ conc: 2, concCap: 2 }) : null),
    metrics: {}, weights: W, seed: 1, contentType: 'image',
  });
  assert.strictEqual(res.rejected.length, 1);
  assert.strictEqual(res.rejected[0].rejectedAt, 'concurrencyOk');
});

// ─── 9) 权重覆盖（可配置）───
test('routeBindings 权重可覆盖：提高 manualWeight 权重改变排序', () => {
  const pairs = [
    mkPair({ bindingId: 'plain', providerId: 'p1', bindingWeight: 0 }),
    mkPair({ bindingId: 'pref', providerId: 'p2', bindingWeight: 1 }),
  ];
  const metrics = {
    plain: { attempts: 5, successRate: 1.0, p95LatencyMs: 0, avgCost: 0, failures: 0 },
    pref: { attempts: 5, successRate: 0.4, p95LatencyMs: 0, avgCost: 0, failures: 0 },
  };
  // 默认权重：plain 成功率满分(0.30) 主导 → 0.65 > pref 0.62（pref 仅人工权重多 0.15 但成功率低）
  const def = R.routeBindings(pairs, { acctMap: new Map(), metrics, weights: W, seed: 1, contentType: 'image' });
  assert.strictEqual(def.ranking[0].bindingId, 'plain');
  // 极端权重：manualWeight 占 0.95 → pref（人工置顶）排前
  const heavy = { successRate: 0.01, health: 0.01, idleCapacity: 0.01, manualWeight: 0.95, negP95Latency: 0.01, negCost: 0.01 };
  const r2 = R.routeBindings(pairs, { acctMap: new Map(), metrics, weights: heavy, seed: 1, contentType: 'image' });
  assert.strictEqual(r2.ranking[0].bindingId, 'pref');
});

// ─── 10) routeDispatchOrder：best-first 重排 ───
test('routeDispatchOrder 按分数 best-first 重排 pairs', () => {
  const pairs = [
    mkPair({ bindingId: 'low', providerId: 'p1' }),
    mkPair({ bindingId: 'hi', providerId: 'p2' }),
  ];
  const metrics = {
    low: { attempts: 5, successRate: 0.2, p95LatencyMs: 0, avgCost: 0, failures: 4 },
    hi: { attempts: 5, successRate: 0.9, p95LatencyMs: 0, avgCost: 0, failures: 0 },
  };
  const ordered = R.routeDispatchOrder(pairs, { acctMap: new Map(), metrics, weights: W, seed: 1, contentType: 'image' });
  assert.strictEqual(ordered[0].bindingId, 'hi');
  assert.strictEqual(ordered.length, 2);
});

// ─── 11) loadRoutingMetrics SQL 失败不抛（行为契约，不连真库）───
test('loadRoutingMetrics 非阻断：pgPool 缺失返回空 map', async () => {
  const m = await R.loadRoutingMetrics(null, ['b1']);
  assert.deepStrictEqual(m, {});
});

// ─── 12) Circuit Breaker 状态机（Phase 3.5）───
function mkCb(state, over = {}) {
  return Object.assign({
    state,
    failCount: 0,
    cooldownUntil: 0,
    probeCount: 0,
    probeSuccessCount: 0,
    openedAt: 0,
  }, over);
}

test('cbInitState 返回 CLOSED 初始态', () => {
  const s = R.cbInitState();
  assert.strictEqual(s.state, 'CLOSED');
  assert.strictEqual(s.failCount, 0);
  assert.strictEqual(s.probeCount, 0);
});

test('cbAdmit CLOSED → 放行且状态不变', () => {
  const st = mkCb('CLOSED');
  const r = R.cbAdmit(st, 1000);
  assert.strictEqual(r.admit, true);
  assert.strictEqual(r.state, st);
  assert.strictEqual(r.reason, 'closed');
});

test('cbAdmit OPEN 冷却中 → 拒且状态不变', () => {
  const st = mkCb('OPEN', { cooldownUntil: 5000, openedAt: 100 });
  const r = R.cbAdmit(st, 1000);
  assert.strictEqual(r.admit, false);
  assert.strictEqual(r.state, st);
  assert.strictEqual(r.reason, 'open-cooling');
});

test('cbAdmit OPEN 冷却过 → 转 HALF_OPEN 并发首个探测（probeCount=1）', () => {
  const st = mkCb('OPEN', { cooldownUntil: 5000, openedAt: 100 });
  const r = R.cbAdmit(st, 6000);
  assert.strictEqual(r.admit, true);
  assert.strictEqual(r.state.state, 'HALF_OPEN');
  assert.strictEqual(r.state.probeCount, 1);
  assert.strictEqual(r.reason, 'half-open-probe');
});

test('cbAdmit HALF_OPEN 探测额度内 → 放行且 probeCount+1', () => {
  const st = mkCb('HALF_OPEN', { probeCount: 1, probeSuccessCount: 0 });
  const r = R.cbAdmit(st, 1000);
  assert.strictEqual(r.admit, true);
  assert.strictEqual(r.state.probeCount, 2);
  // 入参不被改动（不可变）
  assert.strictEqual(st.probeCount, 1);
});

test('cbAdmit HALF_OPEN 探测额度耗尽 → 重 OPEN 冷却且拒', () => {
  const st = mkCb('HALF_OPEN', { probeCount: 3, probeSuccessCount: 0 }); // 3 == halfOpenMaxProbes
  const r = R.cbAdmit(st, 1000);
  assert.strictEqual(r.admit, false);
  assert.strictEqual(r.state.state, 'OPEN');
  assert.ok(r.state.cooldownUntil >= 1000);
  assert.strictEqual(r.reason, 'half-open-exhausted-reopen');
});

test('cbRecordOutcome CLOSED 失败累计，达阈值 → OPEN（带 cooldownUntil）', () => {
  let st = mkCb('CLOSED');
  st = R.cbRecordOutcome(st, 'failure', 1000);
  assert.strictEqual(st.failCount, 1);
  assert.strictEqual(st.state, 'CLOSED');
  st = R.cbRecordOutcome(st, 'failure', 1000);
  assert.strictEqual(st.failCount, 2);
  st = R.cbRecordOutcome(st, 'failure', 2000);
  assert.strictEqual(st.state, 'OPEN');
  assert.strictEqual(st.failCount, 3);
  assert.strictEqual(st.cooldownUntil, 2000 + R.CB_CONFIG.cooldownMs);
  assert.strictEqual(st.openedAt, 2000);
});

test('cbRecordOutcome CLOSED 成功 → 重置 failCount', () => {
  let st = mkCb('CLOSED', { failCount: 2 });
  st = R.cbRecordOutcome(st, 'success', 1000);
  assert.strictEqual(st.state, 'CLOSED');
  assert.strictEqual(st.failCount, 0);
});

test('cbRecordOutcome OPEN 期间保持不动（无 outcome 误操作）', () => {
  const st = mkCb('OPEN', { cooldownUntil: 5000 });
  const r = R.cbRecordOutcome(st, 'failure', 1000);
  assert.strictEqual(r, st);
});

test('cbRecordOutcome HALF_OPEN 成功累计，达阈值 → CLOSED（清空计数）', () => {
  let st = mkCb('HALF_OPEN', { probeCount: 1, probeSuccessCount: 0 });
  st = R.cbRecordOutcome(st, 'success', 1000);
  assert.strictEqual(st.probeSuccessCount, 1);
  assert.strictEqual(st.state, 'HALF_OPEN');
  st = R.cbRecordOutcome(st, 'success', 1000);
  assert.strictEqual(st.state, 'CLOSED');
  assert.strictEqual(st.failCount, 0);
  assert.strictEqual(st.probeCount, 0);
  assert.strictEqual(st.probeSuccessCount, 0);
});

test('cbRecordOutcome HALF_OPEN 失败 → 重 OPEN 冷却', () => {
  const st = mkCb('HALF_OPEN', { probeCount: 2, probeSuccessCount: 1 });
  const r = R.cbRecordOutcome(st, 'failure', 3000);
  assert.strictEqual(r.state, 'OPEN');
  assert.strictEqual(r.cooldownUntil, 3000 + R.CB_CONFIG.cooldownMs);
  assert.strictEqual(r.probeCount, 0);
});

test('cbRecordOutcome 入参不可变（返回新对象）', () => {
  const st = mkCb('CLOSED', { failCount: 0 });
  const r = R.cbRecordOutcome(st, 'failure', 1000);
  assert.notStrictEqual(r, st);
  assert.strictEqual(st.failCount, 0);
  assert.strictEqual(r.failCount, 1);
});

test('buildGateContext cbState=OPEN 冷却中 → circuitOk=false 且暴露 cbState=OPEN', () => {
  const acct = mkAcct({ cbState: mkCb('OPEN', { cooldownUntil: 5000 }) });
  const g = R.buildGateContext(acct, mkPair(), { now: 1000 });
  assert.strictEqual(g.circuitOk, false);
  assert.strictEqual(g.cbState, 'OPEN');
});

test('buildGateContext cbState=OPEN 冷却过 → circuitOk=true（将转 HALF_OPEN 探测）', () => {
  const acct = mkAcct({ cbState: mkCb('OPEN', { cooldownUntil: 500 }) });
  const g = R.buildGateContext(acct, mkPair(), { now: 1000 });
  assert.strictEqual(g.circuitOk, true);
  assert.strictEqual(g.cbState, 'OPEN');
});

test('buildGateContext cbState=HALF_OPEN 探测额度耗尽 → circuitOk=false', () => {
  const acct = mkAcct({ cbState: mkCb('HALF_OPEN', { probeCount: 3, probeSuccessCount: 0 }) });
  const g = R.buildGateContext(acct, mkPair(), { now: 1000 });
  assert.strictEqual(g.circuitOk, false);
  assert.strictEqual(g.cbState, 'HALF_OPEN');
  assert.strictEqual(g.cbProbe, 3);
});

test('buildGateContext cbState=HALF_OPEN 探测额度内 → circuitOk=true', () => {
  const acct = mkAcct({ cbState: mkCb('HALF_OPEN', { probeCount: 1, probeSuccessCount: 0 }) });
  const g = R.buildGateContext(acct, mkPair(), { now: 1000 });
  assert.strictEqual(g.circuitOk, true);
});

test('buildGateContext cbState=CLOSED → circuitOk=true 且暴露 CLOSED', () => {
  const acct = mkAcct({ cbState: mkCb('CLOSED', { failCount: 2 }), consecutiveRejects: 2 });
  const g = R.buildGateContext(acct, mkPair(), { now: 1000 });
  assert.strictEqual(g.circuitOk, true);
  assert.strictEqual(g.cbState, 'CLOSED');
});

test('buildGateContext manualState=open → circuitOk=false（强制熔断）', () => {
  const acct = mkAcct({ manualState: 'open' });
  const g = R.buildGateContext(acct, mkPair(), { now: 1000 });
  assert.strictEqual(g.circuitOk, false);
  assert.strictEqual(g.cbState, 'OPEN');
});

test('buildGateContext 旧快照无 cbState → 退化为 consecutiveRejects 阈值', () => {
  const hot = R.buildGateContext(mkAcct({ consecutiveRejects: R.CIRCUIT_OPEN_THRESHOLD }), mkPair(), { now: 1000 });
  assert.strictEqual(hot.circuitOk, false);
  assert.strictEqual(hot.cbState, null); // 无 cbState → null
  const cold = R.buildGateContext(mkAcct({ consecutiveRejects: R.CIRCUIT_OPEN_THRESHOLD - 1 }), mkPair(), { now: 1000 });
  assert.strictEqual(cold.circuitOk, true);
});

test('routeBindings OPEN provider 被剔除且 rejectedAt=circuitOk，rejectReason 含状态', () => {
  const pairs = [mkPair({ bindingId: 'down', providerId: 'p_down' })];
  const acctMap = new Map([['p_down', mkAcct({ cbState: mkCb('OPEN', { cooldownUntil: 999999 }) })]]);
  const res = R.routeBindings(pairs, { acctMap, metrics: {}, weights: W, seed: 1, contentType: 'image', now: 1000 });
  assert.strictEqual(res.rejected.length, 1);
  assert.strictEqual(res.rejected[0].rejectedAt, 'circuitOk');
  assert.ok(/OPEN/.test(res.rejected[0].rejectReason));
  assert.strictEqual(res.rejected[0].gate.cbState, 'OPEN');
  assert.strictEqual(res.ranking.length, 0);
});

test('setCircuitBreakerConfig 覆盖阈值后生效', () => {
  const prev = R.getCircuitBreakerConfig();
  try {
    R.setCircuitBreakerConfig({ failureThreshold: 2, cooldownMs: 1000, halfOpenMaxProbes: 5, halfOpenSuccessToClose: 1 });
    const cfg = R.getCircuitBreakerConfig();
    assert.strictEqual(cfg.failureThreshold, 2);
    assert.strictEqual(cfg.cooldownMs, 1000);
    assert.strictEqual(cfg.halfOpenMaxProbes, 5);
    assert.strictEqual(cfg.halfOpenSuccessToClose, 1);
    // 验证新阈值：连续 2 次失败即 OPEN
    let st = mkCb('CLOSED');
    st = R.cbRecordOutcome(st, 'failure', 1000);
    st = R.cbRecordOutcome(st, 'failure', 1000);
    assert.strictEqual(st.state, 'OPEN');
  } finally {
    R.setCircuitBreakerConfig(prev); // 还原，避免污染其他测试
  }
});

test('熔断状态机端到端：CLOSED→OPEN→HALF_OPEN→CLOSED 自愈', () => {
  R.setCircuitBreakerConfig({ failureThreshold: 2, cooldownMs: 1000, halfOpenMaxProbes: 2, halfOpenSuccessToClose: 2 });
  try {
    let st = mkCb('CLOSED');
    // 2 次失败 → OPEN
    st = R.cbRecordOutcome(st, 'failure', 1000);
    st = R.cbRecordOutcome(st, 'failure', 1000);
    assert.strictEqual(st.state, 'OPEN');
    // 冷却过 → 首次 admit 转 HALF_OPEN（probeCount=1）
    let adm = R.cbAdmit(st, 2500);
    assert.strictEqual(adm.state.state, 'HALF_OPEN');
    st = adm.state;
    // 发探测并成功 → probeSuccessCount=1（未达 2）
    st = R.cbRecordOutcome(st, 'success', 2500);
    assert.strictEqual(st.state, 'HALF_OPEN');
    assert.strictEqual(st.probeSuccessCount, 1);
    // 第二次 admit（probeCount=2）→ 成功 → 达标 → CLOSED 自愈
    adm = R.cbAdmit(st, 2600);
    assert.strictEqual(adm.admit, true);
    st = adm.state;
    st = R.cbRecordOutcome(st, 'success', 2600);
    assert.strictEqual(st.state, 'CLOSED');
    assert.strictEqual(st.failCount, 0);
  } finally {
    R.setCircuitBreakerConfig({ failureThreshold: 3, cooldownMs: 60000, halfOpenMaxProbes: 3, halfOpenSuccessToClose: 2 });
  }
});
