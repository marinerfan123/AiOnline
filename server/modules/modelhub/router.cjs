'use strict';
/**
 * ModelHub V3 Phase 3.4 — 确定性智能路由算法（纯函数，可解释 + 可测试 + 确定性）
 *
 * 设计三铁律：
 *   1. 可解释：每个候选返回完整 score 分量（components）、门控结果（gate）、人话原因（reasons）；
 *      被剔除的候选带 rejectedAt（卡在第几道门）+ rejectReason。
 *   2. 可测试：所有核心函数均为纯函数（显式入参，不依赖模块级可变状态），可用内存假数据单测。
 *   3. 确定性：加权选择使用种子化 PRNG（LCG），相同 seed + 相同输入 → 相同 chosen；无隐藏随机。
 *
 * 候选来源：loadDispatchPairs 的 pairs（已预过滤 enabled 绑定 + enabled 服务商 + 有效 api_key）。
 * 历史指标：generation_attempts（Phase 3.3 落地）—— aggregateMetrics 按 binding_id 聚合。
 * 实时门控态：dispatcher 内存 ACCT 的「快照」—— buildGateContext 读取，绝不改动调用方状态。
 *
 * 评分公式（权重可配置，默认见 DEFAULT_WEIGHTS）：
 *   score = successRate*0.30 + health*0.20 + idleCapacity*0.15 + manualWeight*0.15
 *           - p95Latency*0.10 - cost*0.10
 * 其中时延/成本先归一化到 [0,1] 再取负项，保证各分量同量纲、可加。
 */

// ─── 常量（可调，但保持与 dispatcher.cjs 一致）───
const DEFAULT_WEIGHTS = {
  successRate: 0.30,
  health: 0.20,
  idleCapacity: 0.15,
  manualWeight: 0.15,
  negP95Latency: 0.10,
  negCost: 0.10,
};
const CIRCUIT_OPEN_THRESHOLD = 3;   // 连续拒单达到该值 → 熔断（与 dispatcher 双路径冷却一致）
const ACCOUNT_CONC_CAP = 4;         // 单账号并发硬上限（与 dispatcher 一致）
const DEFAULT_CONC_CAP = 2;         // 无显式配置时的兜底并发上限
const LATENCY_REF_MS = 60000;       // P95 时延归一化参考（>60s → 满分负向惩罚）
const COST_REF_UNITS = 4;           // 成本归一化参考（attempt.cost 为桶单位 1~4；=4 → 满分负向惩罚）

// ─── Circuit Breaker 状态机（Phase 3.5）───
// 目标：第三方 API 挂掉后系统「自动隔离」—— OPEN 期间绝不发请求（不扣令牌、不占并发、不记 attempt），
//       冷却后转 HALF_OPEN 发少量探测，探测达标自动回 CLOSED，未达标重 OPEN 继续冷却。
// 状态迁移：
//   CLOSED  —— 正常放行；累计失败达 failureThreshold → OPEN
//   OPEN    —— 冷却中拒单；cooldown 过后首次 admit 自动转 HALF_OPEN 并发首个探测
//   HALF_OPEN —— 发少量探测（≤ halfOpenMaxProbes）；成功达标 → CLOSED；任一失败 → 重 OPEN 冷却
const CB_CONFIG = {
  failureThreshold: 3,        // CLOSED 态连续失败达到该值 → 转 OPEN
  cooldownMs: 60000,          // OPEN 冷却时长（与 dispatcher cooldownMs 对齐）
  halfOpenMaxProbes: 3,       // HALF_OPEN 最多发几个探测
  halfOpenSuccessToClose: 2,  // HALF_OPEN 成功探测达到该值 → 回 CLOSED
};
let _CB_CONFIG = { ...CB_CONFIG };

// 无历史数据时的中性默认（不奖不罚，让评分由实时态驱动）：
const DEFAULT_SUCCESS_RATE = 0.5;   // 成功率未知 → 中性
const DEFAULT_P95_MS = 0;           // 时延未知 → 无惩罚
const DEFAULT_COST = 0;             // 成本未知 → 无惩罚

// 门控管线顺序（与用户给定的 7 道门严格一致）：
//   enabled → providerEnabled → cooldown → circuitOpen → rateLimit → concurrencyFull → capability
const GATE_ORDER = [
  'enabled', 'providerEnabled', 'cooldownOk', 'circuitOk',
  'rateLimitOk', 'concurrencyOk', 'capabilityOk',
];
const GATE_REASON = {
  enabled: '绑定/模型未启用（enabled=false）',
  providerEnabled: '服务商未启用（provider.enabled=false）',
  cooldownOk: '账号处于冷却期（cooldownUntil 未到）',
  circuitOk: `熔断开启（连续拒单 ≥ ${CIRCUIT_OPEN_THRESHOLD}）`,
  rateLimitOk: '限流桶令牌不足（tokens < 本次成本）',
  concurrencyOk: '账号并发已满（conc ≥ concCap）',
  capabilityOk: '模型不支持该内容类型（capability 不满足）',
};

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ─── 1) 历史指标聚合（纯函数，输入 attempt 行，输出 per-binding 指标）───
/**
 * 从 generation_attempts 行聚合每 binding_id 的指标。
 * @param {Array<{binding_id:string,status:string,latency_ms:?number,cost:?number}>} rows
 * @returns {Object<string,{attempts:number,successRate:number,p95LatencyMs:number,avgCost:number,failures:number}>}
 */
function aggregateMetrics(rows) {
  const by = Object.create(null);
  for (const r of (rows || [])) {
    const bid = r.binding_id || '';
    if (!by[bid]) by[bid] = { _n: 0, _ok: 0, _fail: 0, _lat: [], _cost: [] };
    const b = by[bid];
    b._n += 1;
    const st = (r.status || '').toLowerCase();
    if (st === 'success') b._ok += 1;
    else if (st === 'failed' || st === 'timeout' || st === 'rate_limited' || st === 'error') b._fail += 1;
    if (st === 'success' && typeof r.latency_ms === 'number' && r.latency_ms > 0) b._lat.push(r.latency_ms);
    if (typeof r.cost === 'number') b._cost.push(r.cost);
  }
  const out = {};
  for (const bid of Object.keys(by)) {
    const b = by[bid];
    const lat = b._lat.slice().sort((a, z) => a - z);
    // 最近秩（nearest-rank）P95
    let p95 = 0;
    if (lat.length) {
      const idx = Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1);
      p95 = lat[Math.max(0, idx)];
    }
    const avgCost = b._cost.length ? b._cost.reduce((s, v) => s + v, 0) / b._cost.length : 0;
    out[bid] = {
      attempts: b._n,
      successRate: b._n > 0 ? b._ok / b._n : 0,
      p95LatencyMs: p95,
      avgCost,
      failures: b._fail,
    };
  }
  return out;
}

// ─── 2) 实时门控态快照（ACCT → 7 道门；true = 通过）───
/**
 * 把 dispatcher 的实时 ACCT 态映射为 7 道门控结果。
 * @param {object|null} acct  ACCT 快照（来自 dispatcher.snapshotAcct）；null = 全新账号（视为可用）
 * @param {{model:object,provider:object,bindingId?:string}} pair
 * @param {{now:number,contentType?:string,unitCost?:number}} opts
 * @returns {{enabled:boolean,providerEnabled:boolean,cooldownOk:boolean,circuitOk:boolean,rateLimitOk:boolean,concurrencyOk:boolean,capabilityOk:boolean}}
 */
function buildGateContext(acct, pair, opts) {
  const now = opts && opts.now != null ? opts.now : Date.now();
  const contentType = opts && opts.contentType;
  const unitCost = opts && typeof opts.unitCost === 'number' ? opts.unitCost : 1;

  const model = (pair && pair.model) || {};
  const provider = (pair && pair.provider) || {};

  const enabled = model.enabled !== false;                 // 绑定/模型启用（live 路径已被 loadDispatchPairs 预过滤）
  const providerEnabled = provider.enabled !== false;       // 服务商启用（live 路径已预过滤）

  // 以下 4 道实时门：无 ACCT（全新账号）→ 视为可用（通过）
  const inCooldown = !!(acct && acct.cooldownUntil > now);
  // 熔断门（Phase 3.5）：读取 ACCT 的 cbState 权威判定；无 cbState 的旧快照退化为 consecutiveRejects 阈值。
  const circuitOpen = !cbAllows(acct, now);
  const rateLimited = !!(acct && acct.capacityModel !== 'unlimited' && (acct.bucket ? acct.bucket.tokens : 0) < unitCost);
  const concCap = (acct && acct.concCap) || DEFAULT_CONC_CAP;
  const concurrencyFull = !!(acct && (acct.conc || 0) >= concCap);

  const capabilityOk = capabilitySatisfies(model, contentType);

  // 暴露熔断态供后台「决策解释」面板消费（OPEN / HALF_OPEN / CLOSED / null）
  const st = acct && acct.cbState;
  const cbState = st && st.state
    ? st.state
    : (acct && acct.manualState === 'open' ? 'OPEN' : null);
  const cbProbe = st ? (st.probeCount || 0) : 0;

  return {
    enabled,
    providerEnabled,
    cooldownOk: !inCooldown,
    circuitOk: !circuitOpen,
    rateLimitOk: !rateLimited,
    concurrencyOk: !concurrencyFull,
    capabilityOk,
    cbState,
    cbProbe,
  };
}

/** 模型是否满足该内容类型的生成能力 */
function capabilitySatisfies(model, contentType) {
  if (!contentType) return true;                  // 无内容类型约束 → 放行
  if (!model) return false;
  if (model.type === contentType) return true;    // 主类型匹配
  const caps = model.capabilities;
  if (caps && typeof caps === 'object') {
    if (caps[contentType] === true) return true;
    if (Array.isArray(caps.types) && caps.types.includes(contentType)) return true;
    if (caps[`${contentType}Input`] === true) return true;
  }
  return false;
}

// ─── 3) 单候选评分（分量 + 总分）───
/**
 * 计算单个候选的评分分量与总分。
 * @returns {{score:number,components:object,raw:object}}
 */
function scoreCandidate(pair, metrics, weights, acct, opts) {
  weights = weights || DEFAULT_WEIGHTS;
  const bid = (pair && pair.bindingId) || '';
  const m = (metrics && metrics[bid]) || null;

  // 成功率：历史（无数据 → 中性 0.5）
  const successRate = m ? m.successRate : DEFAULT_SUCCESS_RATE;

  // 健康度：来自实时 ACCT（连续拒单越少越健康；cold=0, hot=1）
  let health;
  if (!acct) health = 1;
  else if (acct.manualState === 'cold') health = 0;
  else if (acct.manualState === 'hot') health = 1;
  else health = clamp01(1 - (acct.consecutiveRejects || 0) / CIRCUIT_OPEN_THRESHOLD);

  // 空闲容量：1 - 已用/上限（unlimited → 始终空闲）
  let idleCapacity;
  if (!acct || acct.capacityModel === 'unlimited') idleCapacity = 1;
  else {
    const cap = (acct.concCap) || DEFAULT_CONC_CAP;
    idleCapacity = cap > 0 ? clamp01((cap - (acct.conc || 0)) / cap) : 0;
  }

  // 人工权重：来自绑定 weight（0~1）
  const manualWeight = clamp01(Number((pair && pair.model && pair.model.bindingWeight)) || 0);

  // P95 时延负项：归一化到 [0,1] 取负（用 0 - x 避免产生 -0，便于严格比较/序列化）
  const p95 = m ? m.p95LatencyMs : DEFAULT_P95_MS;
  const negP95Latency = 0 - clamp01(p95 / LATENCY_REF_MS);

  // 成本负项：归一化到 [0,1] 取负（attempt.cost 为桶单位）
  const cost = m ? m.avgCost : DEFAULT_COST;
  const negCost = 0 - clamp01(cost / COST_REF_UNITS);

  const components = { successRate, health, idleCapacity, manualWeight, negP95Latency, negCost };
  const score =
    (components.successRate * (weights.successRate || 0)) +
    (components.health * (weights.health || 0)) +
    (components.idleCapacity * (weights.idleCapacity || 0)) +
    (components.manualWeight * (weights.manualWeight || 0)) +
    (components.negP95Latency * (weights.negP95Latency || 0)) +
    (components.negCost * (weights.negCost || 0));

  const raw = {
    p95LatencyMs: p95,
    avgCost: cost,
    attempts: m ? m.attempts : 0,
    consecutiveRejects: acct ? (acct.consecutiveRejects || 0) : 0,
    conc: acct ? (acct.conc || 0) : 0,
    concCap: acct ? (acct.concCap || DEFAULT_CONC_CAP) : DEFAULT_CONC_CAP,
    hasHistory: !!m,
  };
  return { score, components, raw };
}

// ─── 4) 门控 + 评分 + 排序 + 选择（顶层入口）───
/**
 * 对候选 pairs 执行完整确定性路由：门控 → 评分 → 排序 → 加权选择。
 * @param {Array<{model:object,provider:object,bindingId:string}>} pairs
 * @param {object} [opts]
 *   - acctMap: Map<providerId, snapshot> 或 (providerId)=>snapshot
 *   - metrics: Object<bindingId, metrics>  （来自 aggregateMetrics）
 *   - weights: 权重包（缺省 DEFAULT_WEIGHTS）
 *   - seed: 加权选择种子（缺省 1）
 *   - contentType / tier / now / unitCost
 * @returns {{chosen:object|null,ranking:Array,rejected:Array,weights:object,seed:number}}
 */
function routeBindings(pairs, opts) {
  opts = opts || {};
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const seed = opts.seed != null ? opts.seed : 1;
  const now = opts.now != null ? opts.now : Date.now();
  const metrics = opts.metrics || Object.create(null);
  const getAcct = normalizeAcctMap(opts.acctMap);
  const contentType = opts.contentType;
  const unitCost = opts.unitCost != null ? opts.unitCost : 1;

  const eligible = [];
  const rejected = [];

  for (const pair of (pairs || [])) {
    const pid = pair && pair.provider ? pair.provider.id : '';
    const acct = getAcct(pid);
    const gate = buildGateContext(acct, pair, { now, contentType, unitCost });

    // 7 道门按管线顺序短路：首个未通过的门即 rejectedAt
    let blockedGate = null;
    for (const g of GATE_ORDER) {
      if (!gate[g]) { blockedGate = g; break; }
    }
    if (blockedGate) {
      rejected.push({
        bindingId: (pair && pair.bindingId) || '',
        modelId: pair && pair.model ? pair.model.model_id : '',
        providerId: pid,
        rejectedAt: blockedGate,
        rejectReason: blockedGate === 'circuitOk'
          ? circuitRejectReason(acct, gate)
          : (GATE_REASON[blockedGate] || '未知门控'),
        gate,
      });
      continue;
    }

    const sc = scoreCandidate(pair, metrics, weights, acct, { contentType });
    eligible.push({
      bindingId: (pair && pair.bindingId) || '',
      modelId: pair && pair.model ? pair.model.model_id : '',
      providerId: pid,
      score: sc.score,
      components: sc.components,
      raw: sc.raw,
      gate,
      reasons: buildReasons(sc, metrics[(pair && pair.bindingId) || ''], weights),
    });
  }

  const ranking = sortByScore(eligible);
  const chosen = weightedSelect(ranking, seed);
  return { chosen, ranking, rejected, weights, seed };
}

function normalizeAcctMap(acctMap) {
  if (typeof acctMap === 'function') return acctMap;
  if (acctMap && typeof acctMap.get === 'function') {
    return (pid) => acctMap.get(pid) || null;
  }
  return () => null;
}

/** 降序排序；同分时按 bindingId 字典序（保证确定性 tie-break） */
function sortByScore(eligible) {
  return (eligible || []).slice().sort((a, z) => {
    if (z.score !== a.score) return z.score - a.score;
    return String(a.bindingId).localeCompare(String(z.bindingId));
  });
}

// ─── 5) 种子化加权选择（确定性）───
/**
 * 按 score 作为权重做加权随机选择的确定性版本（LCG 种子化）。
 * @param {Array<{score:number,bindingId:string}>} eligible
 * @param {number} seed
 * @returns {object|null} 选中的候选（含 score/components/...）
 */
function weightedSelect(eligible, seed) {
  const list = eligible || [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  // 选择概率权重：score 可能为负（被负向项拉低），夹到 ≥0；总和≤0 → 退化到首个（确定性）
  const mult = list.map((e) => (e.score > 0 ? e.score : 0));
  const total = mult.reduce((s, v) => s + v, 0);
  if (total <= 0) return list[0];

  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const r = rnd() * total;
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    acc += mult[i];
    if (r < acc) return list[i];
  }
  return list[list.length - 1];
}

// ─── 6) 人话原因（解释性）───
function buildReasons(sc, metric, weights) {
  weights = weights || DEFAULT_WEIGHTS;
  const reasons = [];
  const c = sc.components;
  reasons.push(`成功率 ${(c.successRate).toFixed(2)} × ${weights.successRate} = +${(c.successRate * weights.successRate).toFixed(3)}`);
  reasons.push(`健康度 ${c.health.toFixed(2)} × ${weights.health} = +${(c.health * weights.health).toFixed(3)}`);
  reasons.push(`空闲容量 ${c.idleCapacity.toFixed(2)} × ${weights.idleCapacity} = +${(c.idleCapacity * weights.idleCapacity).toFixed(3)}`);
  reasons.push(`人工权重 ${c.manualWeight.toFixed(2)} × ${weights.manualWeight} = +${(c.manualWeight * weights.manualWeight).toFixed(3)}`);
  reasons.push(`P95时延 ${sc.raw.p95LatencyMs}ms → 负项 ${c.negP95Latency.toFixed(2)} × ${weights.negP95Latency} = ${(c.negP95Latency * weights.negP95Latency).toFixed(3)}`);
  reasons.push(`成本 ${sc.raw.avgCost.toFixed(2)}u → 负项 ${c.negCost.toFixed(2)} × ${weights.negCost} = ${(c.negCost * weights.negCost).toFixed(3)}`);
  if (!sc.raw.hasHistory) reasons.push('无历史指标：成功率取中性默认 0.5，时延/成本无惩罚');
  return reasons;
}

// ─── 7) DB 读取：聚合近期 attempt 指标（可选，非阻断）───
/**
 * 从 generation_attempts 读取近期指标并按 binding_id 聚合。
 * 失败（DB 抖动）→ 返回空 map，绝不抛异常阻断路由。
 */
async function loadRoutingMetrics(pgPool, bindingIds, opts) {
  if (!pgPool || !Array.isArray(bindingIds) || bindingIds.length === 0) return {};
  const windowH = (opts && opts.windowHours) || 24;
  try {
    const res = await pgPool.query(
      `SELECT binding_id, status, latency_ms, cost
         FROM generation_attempts
        WHERE binding_id = ANY($1)
          AND created_at > NOW() - ($2 || ' hours')::interval`,
      [bindingIds, String(windowH)],
    );
    return aggregateMetrics(res.rows || []);
  } catch (e) {
    return {};
  }
}

/** 供 dispatcher 重排调度顺序（best-first，确定性，无随机）—— 实时态由 attemptOnAccount 兜底 */
function routeDispatchOrder(pairs, opts) {
  const { ranking } = routeBindings(pairs, opts);
  const byBid = new Map((pairs || []).map((p) => [p.bindingId || '', p]));
  const ordered = [];
  for (const r of ranking) {
    const p = byBid.get(r.bindingId);
    if (p) ordered.push(p);
  }
  // 任何未被排序覆盖的 pair（罕见：门控全过但排序丢失）→ 补在末尾，保证不丢候选
  for (const p of (pairs || [])) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  return ordered;
}

// ─── 8) Circuit Breaker 状态机（Phase 3.5，纯函数）───
// 熔断态对象结构：{ state, failCount, cooldownUntil, probeCount, probeSuccessCount, openedAt }
//   state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
//   failCount: CLOSED 态累计失败数
//   cooldownUntil: OPEN 冷却到期时间戳（ms）
//   probeCount: HALF_OPEN 已发出探测数（含本次预约）
//   probeSuccessCount: HALF_OPEN 成功探测数
//   openedAt: 最近一次进入 OPEN 的时间戳（诊断用）

/** 新建一个 CLOSED 初始态 */
function cbInitState() {
  return { state: 'CLOSED', failCount: 0, cooldownUntil: 0, probeCount: 0, probeSuccessCount: 0, openedAt: 0 };
}

/**
 *  admission 判定（只读 + 惰性状态推进；dispatcher attemptOnAccount 在真正发请求前调用）。
 *  @param {{state:string,failCount?:number,cooldownUntil?:number,probeCount?:number,probeSuccessCount?:number,openedAt?:number}|null} st
 *  @param {number} [now]
 *  @returns {{admit:boolean,state:object,reason:string}}
 *    - CLOSED → admit，state 不变
 *    - OPEN 且未过冷却 → 拒，state 不变
 *    - OPEN 且已过冷却 → 自动转 HALF_OPEN 并发首个探测（probeCount=1），admit
 *    - HALF_OPEN 且探测额度内 → admit，probeCount+1（预约探测）
 *    - HALF_OPEN 且探测额度耗尽 → 重 OPEN 冷却，拒
 *    - 无状态（旧快照/未初始化）→ 视为 CLOSED，admit
 */
function cbAdmit(st, now) {
  const cfg = _CB_CONFIG;
  const t = (now != null) ? now : Date.now();
  if (!st || !st.state) return { admit: true, state: st || null, reason: 'no-state-closed' };
  if (st.state === 'CLOSED') return { admit: true, state: st, reason: 'closed' };
  if (st.state === 'OPEN') {
    if (t >= (st.cooldownUntil || 0)) {
      // 冷却过 → 转 HALF_OPEN，发起首个探测
      const ns = {
        state: 'HALF_OPEN', failCount: 0, cooldownUntil: 0,
        probeCount: 1, probeSuccessCount: 0, openedAt: st.openedAt || 0,
      };
      return { admit: true, state: ns, reason: 'half-open-probe' };
    }
    return { admit: false, state: st, reason: 'open-cooling' };
  }
  if (st.state === 'HALF_OPEN') {
    if ((st.probeCount || 0) < cfg.halfOpenMaxProbes) {
      const ns = Object.assign({}, st, { probeCount: (st.probeCount || 0) + 1 });
      return { admit: true, state: ns, reason: 'half-open-probe' };
    }
    // 探测额度耗尽仍不达标 → 重新 OPEN 冷却
    const ns = {
      state: 'OPEN', failCount: 0, cooldownUntil: t + cfg.cooldownMs,
      probeCount: 0, probeSuccessCount: 0, openedAt: t,
    };
    return { admit: false, state: ns, reason: 'half-open-exhausted-reopen' };
  }
  return { admit: true, state: st, reason: 'fallback' };
}

/**
 *  记录一次 outcome（dispatcher 发请求后：成功/失败 各调用一次），返回新状态。
 *  @param {{state:string,failCount?:number,cooldownUntil?:number,probeCount?:number,probeSuccessCount?:number,openedAt?:number}|null} st
 *  @param {'success'|'failure'} outcome
 *  @param {number} [now]
 *  @returns {object} 新状态（不可变：返回全新对象，不改动入参）
 *    - CLOSED：success→重置 failCount；failure→failCount+1，达阈值→OPEN(cooldownUntil)
 *    - OPEN：保持不动（未发请求，不应有 outcome）
 *    - HALF_OPEN：success→成功数+1，达标→CLOSED；failure→重 OPEN 冷却
 */
function cbRecordOutcome(st, outcome, now) {
  const cfg = _CB_CONFIG;
  const t = (now != null) ? now : Date.now();
  if (!st || !st.state) st = cbInitState();
  const o = (outcome === 'success') ? 'success' : 'failure';
  if (st.state === 'CLOSED') {
    if (o === 'success') return Object.assign({}, st, { failCount: 0, probeCount: 0, probeSuccessCount: 0 });
    const fc = (st.failCount || 0) + 1;
    if (fc >= cfg.failureThreshold) {
      return { state: 'OPEN', failCount: fc, cooldownUntil: t + cfg.cooldownMs, probeCount: 0, probeSuccessCount: 0, openedAt: t };
    }
    return Object.assign({}, st, { failCount: fc });
  }
  if (st.state === 'OPEN') {
    return st; // 保持原状，避免误操作
  }
  if (st.state === 'HALF_OPEN') {
    if (o === 'success') {
      const sc = (st.probeSuccessCount || 0) + 1;
      if (sc >= cfg.halfOpenSuccessToClose) {
        return { state: 'CLOSED', failCount: 0, cooldownUntil: 0, probeCount: 0, probeSuccessCount: 0, openedAt: 0 };
      }
      return Object.assign({}, st, { probeSuccessCount: sc });
    }
    // 探测失败 → 重新 OPEN 冷却
    return { state: 'OPEN', failCount: 0, cooldownUntil: t + cfg.cooldownMs, probeCount: 0, probeSuccessCount: 0, openedAt: t };
  }
  return st;
}

/** 覆盖熔断配置（阈值可配置化）；仅接受有限数字字段 */
function setCircuitBreakerConfig(cfg) {
  if (cfg && typeof cfg === 'object') {
    const merged = Object.assign({}, CB_CONFIG);
    for (const k of Object.keys(CB_CONFIG)) {
      if (typeof cfg[k] === 'number' && Number.isFinite(cfg[k]) && cfg[k] > 0) merged[k] = cfg[k];
    }
    _CB_CONFIG = merged;
  }
  return _CB_CONFIG;
}
function getCircuitBreakerConfig() { return _CB_CONFIG; }

/**
 *  只读判门（buildGateContext 调用）：该 provider 当前是否允许被路由选中。
 *  - 管理员手动 open → 拒
 *  - 无 cbState 旧快照 → 退化为 consecutiveRejects 阈值
 *  - OPEN 且已过冷却 → 允许（将转 HALF_OPEN）
 *  - OPEN 冷却中 / HALF_OPEN 探测额度耗尽 → 拒
 *  - CLOSED / HALF_OPEN 探测额度内 → 允许
 */
function cbAllows(acct, now) {
  if (!acct) return true;
  if (acct.manualState === 'open') return false;
  const st = acct.cbState;
  if (!st || !st.state) {
    return !((acct.consecutiveRejects || 0) >= CIRCUIT_OPEN_THRESHOLD);
  }
  if (st.state === 'OPEN') return now >= (st.cooldownUntil || 0);
  if (st.state === 'HALF_OPEN') return (st.probeCount || 0) < _CB_CONFIG.halfOpenMaxProbes;
  return true; // CLOSED
}

/** 熔断门被拒时的动态人话原因（供 routeBindings rejected.rejectReason） */
function circuitRejectReason(acct, gate) {
  const st = acct && acct.cbState;
  if (acct && acct.manualState === 'open') return '熔断开启（管理员手动 OPEN）';
  if (st && st.state === 'OPEN') {
    const until = st.cooldownUntil ? new Date(st.cooldownUntil).toISOString() : '?';
    return `熔断开启（OPEN，冷却至 ${until}）`;
  }
  if (st && st.state === 'HALF_OPEN') return `熔断探测额度耗尽（HALF_OPEN ${st.probeCount || 0}/${_CB_CONFIG.halfOpenMaxProbes}）`;
  return GATE_REASON.circuitOk;
}

module.exports = {
  DEFAULT_WEIGHTS,
  CIRCUIT_OPEN_THRESHOLD,
  ACCOUNT_CONC_CAP,
  LATENCY_REF_MS,
  COST_REF_UNITS,
  CB_CONFIG,
  GATE_ORDER,
  GATE_REASON,
  aggregateMetrics,
  buildGateContext,
  capabilitySatisfies,
  scoreCandidate,
  routeBindings,
  sortByScore,
  weightedSelect,
  buildReasons,
  loadRoutingMetrics,
  routeDispatchOrder,
  cbInitState,
  cbAdmit,
  cbRecordOutcome,
  setCircuitBreakerConfig,
  getCircuitBreakerConfig,
  cbAllows,
  circuitRejectReason,
};
