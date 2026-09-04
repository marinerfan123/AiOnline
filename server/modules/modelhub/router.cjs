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

// ═══════════════════════════════════════════════════════════════════════════
//  L37 + L38 — 严格双层 Router（§29-38）
//
//  上层 Auto Model Router（routeModel，L38）：
//    媒体轴粗筛（mediaType，非 13 道之一）→ 13 道固定序 admission 逐道淘汰
//    （附逐道原因）→ score 最后才算（§32「禁止先算 score 再发现不支持」）→
//    选出 model + 原因链（可解释决策，§33 权重化线性打分，不上 ML）。
//    手动 model 直通不跨（§30）：requirements.mode='manual' 或 manualModelCode
//    显式锁定时，仅该 model 参与；任何失败 → NO_ROUTABLE_MODEL，绝不跨 model fallback。
//
//  下层 Binding Router（routeBinding，L37）：
//    同 model 内多 binding（provider 线路）选路，只读评估 cert/成本/容量
//    （admission 只读，不占槽位——真正的 acquire 由提交时 L35 quotaScopeAdmission 做）。
//    禁跨 model 选（§29）：非本 logicalModelCode 的 binding 一律排除并记录。
//
//  resolveRoute（§36 Resolve/dry-run）：组合上下两层 → {ok, decision:{model,binding,score,reasons}}；
//    候选空 → {ok:false, code:'NO_ROUTABLE_MODEL'}。无提交权威（§37）：提交时须重新 validate+resolve。
// ═══════════════════════════════════════════════════════════════════════════

const { validateOperationInput } = require('./modelSchema.cjs');
const { rankFidelity } = require('./provider-cert.cjs');
const { evaluateScopeCapacity } = require('../generation-v2/provider-admission.cjs');

// §32 13 道 admission 固定序（score 恒为最后一步，第 13 道）
const ADMISSION_ORDER = [
  'operationCompat',   // 1  Operation compat
  'schemaCompat',      // 2  Schema compat
  'requiredSemantic',  // 3  Required semantic
  'modelLifecycle',    // 4  Model lifecycle
  'dataPrivacy',       // 5  Data/privacy
  'region',            // 6  Region
  'providerCert',      // 7  Provider certification
  'quota',             // 8  Quota
  'credential',        // 9  Credential
  'serviceClass',      // 10 Service class
  'costCeiling',       // 11 Cost ceiling
  'providerHealth',    // 12 Provider health
  'score',             // 13 Score（最后才算）
];

// §33 Router Score 权重（P0 稳定可解释线性打分）
const MODEL_SCORE_WEIGHTS = { quality: 0.35, reliability: 0.20, latency: 0.25, cost: 0.20 };

// §32 第 4 道：可路由 lifecycle（仅 ACTIVE）
const ROUTABLE_LIFECYCLES = new Set(['ACTIVE']);

// 统一错误码
const NO_ROUTABLE_MODEL = 'NO_ROUTABLE_MODEL';
const NO_ROUTABLE_BINDING = 'NO_ROUTABLE_BINDING';

// 下层 Binding Router 门序（cert → cost → capacity，与 L37 过滤维度一致）
const BINDING_GATE_ORDER = ['cert', 'cost', 'capacity'];

/** 宽容字段读取：按候选键序取首个非 null/undefined 值。 */
function _pick(obj, ...keys) {
  if (obj == null) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** 数组/对象 → 字符串集合（对象取 truthy 值键）。 */
function _asSet(v) {
  const s = new Set();
  if (Array.isArray(v)) { for (const x of v) if (x != null && x !== '') s.add(String(x)); }
  else if (v && typeof v === 'object') { for (const k of Object.keys(v)) if (v[k]) s.add(String(k)); }
  return s;
}

/** 归一 model 描述符（宽容读取多种字段名，供 13 道与 score 使用）。 */
function normalizeModel(m) {
  const dataPolicy = _pick(m, 'dataPolicy', 'data_policy') || {};
  const cert = _pick(m, 'certification', 'cert') || null;
  const credentials = _pick(m, 'credential', 'credentials');
  let hasCredential = true;
  if (Array.isArray(credentials)) hasCredential = credentials.length > 0;
  else if (credentials && typeof credentials === 'object' && 'hasCredential' in credentials) hasCredential = credentials.hasCredential !== false;
  else { const hc = _pick(m, 'hasCredential'); hasCredential = (hc === undefined || hc === null) ? true : (hc !== false); }

  const cost = _pick(m, 'cost', 'unitCost', 'price');
  const health = _pick(m, 'health', 'providerHealth');
  const latency = _pick(m, 'latencyMs', 'latency_ms', 'latency');
  const quality = _pick(m, 'quality');
  const reliability = _pick(m, 'reliability');

  return {
    _raw: m,
    code: String(_pick(m, 'logicalModelCode', 'code', 'modelCode', 'model_id', 'id') || ''),
    mediaType: String(_pick(m, 'mediaType', 'media_type', 'type') || ''),
    operations: _pick(m, 'operations', 'operationCodes', 'supportedOperations'),
    status: String(_pick(m, 'status', 'lifecycle', 'lifecycleState') || '').toUpperCase(),
    schema: _pick(m, 'schema', 'inputSchema', 'input_schema'),
    semantics: _pick(m, 'semantics', 'semanticMap', 'capabilityDescriptor', 'capabilities'),
    dataPolicy,
    certification: cert,
    quota: _pick(m, 'quota'),
    hasCredential,
    serviceClass: _pick(m, 'serviceClass', 'service_class'),
    serviceClasses: _pick(m, 'serviceClasses', 'service_classes'),
    region: _pick(m, 'region', 'dataResidency', 'data_residency'),
    cost: cost == null ? NaN : Number(cost),
    health: health == null ? NaN : Number(health),
    latencyMs: latency == null ? NaN : Number(latency),
    quality: quality == null ? NaN : Number(quality),
    reliability: reliability == null ? NaN : Number(reliability),
  };
}

/** 归一 model 的「支持语义键」集合（§21 capability signature 形状 / bySemantic map / 布尔能力键）。 */
function _supportedSemantics(sem) {
  if (!sem) return new Set();
  if (Array.isArray(sem)) return _asSet(sem);
  if (typeof sem !== 'object') return _asSet([sem]);
  if (sem.bySemantic && typeof sem.bySemantic === 'object' && Object.keys(sem.bySemantic).length) {
    return new Set(Object.keys(sem.bySemantic));
  }
  if (Array.isArray(sem.supported) && sem.supported.length) return _asSet(sem.supported);
  const out = new Set();
  for (const [k, v] of Object.entries(sem)) if (v === true) out.add(k);
  return out;
}

// ─── 13 道 admission 谓词（每道返回 { pass, reason }）─────────────────────

function _admitOperationCompat(nm, ctx) {
  const op = ctx.operationCode;
  if (!op) return { pass: true, reason: '无 operation 约束' };
  const supported = _asSet(nm.operations);
  const pass = supported.size === 0 ? false : supported.has(String(op));
  return { pass, reason: pass ? `支持 operation '${op}'` : `不支持 operation '${op}'` };
}

function _admitSchemaCompat(nm, ctx) {
  const params = (ctx.requirements && ctx.requirements.params) || null;
  const schema = nm.schema;
  if (params == null || schema == null) return { pass: true, reason: '无 schema/params 约束' };
  const r = validateOperationInput(schema, params);
  return { pass: r.ok, reason: r.ok ? 'params 满足 input schema' : `schema 不兼容: ${(r.errors || []).join('; ')}` };
}

function _admitRequiredSemantic(nm, ctx) {
  const req = (ctx.requirements && ctx.requirements.requiredSemantics) || [];
  if (!Array.isArray(req) || req.length === 0) return { pass: true, reason: '无 required semantic 约束' };
  const supported = _supportedSemantics(nm.semantics);
  const missing = req.filter((s) => !supported.has(String(s)));
  return { pass: missing.length === 0, reason: missing.length === 0 ? `语义齐全: ${req.join(',')}` : `缺语义: ${missing.join(',')}` };
}

function _admitModelLifecycle(nm) {
  const pass = ROUTABLE_LIFECYCLES.has(nm.status);
  return { pass, reason: pass ? `lifecycle ${nm.status}` : `lifecycle ${nm.status || 'UNKNOWN'} 不可路由` };
}

function _admitDataPrivacy(nm, ctx) {
  const req = ctx.requirements || {};
  const dp = nm.dataPolicy || {};
  const reasons = [];
  if (req.zdrRequired) {
    const cls = String(_pick(dp, 'dataRetentionClass', 'data_retention_class') || '').toLowerCase();
    if (cls !== 'zdr') reasons.push(`zdr_required 但 data_retention_class=${cls || '未声明'}`);
  }
  if (req.noTrainingProvider) {
    const tup = String(_pick(dp, 'trainingUsagePolicy', 'training_usage_policy') || '').toLowerCase();
    if (tup !== 'no_training' && tup !== 'no-training') reasons.push(`no_training_required 但 training_usage_policy=${tup || '未声明'}`);
  }
  return { pass: reasons.length === 0, reason: reasons.length === 0 ? 'data policy 满足' : reasons.join('; ') };
}

function _admitRegion(nm, ctx) {
  const allowed = (ctx.requirements && ctx.requirements.allowedRegions) || [];
  if (!Array.isArray(allowed) || allowed.length === 0) return { pass: true, reason: '无 region 约束' };
  const r = nm.region;
  if (r == null || r === '') return { pass: false, reason: 'region 未声明（无法确认 residency）' };
  const pass = allowed.some((a) => String(a) === String(r));
  return { pass, reason: pass ? `region '${r}' 在允许列表` : `region '${r}' 不在允许列表 [${allowed.join(',')}]` };
}

function _admitProviderCert(nm, ctx) {
  const minFidelity = (ctx.requirements && ctx.requirements.minFidelity) || null;
  if (!minFidelity) return { pass: true, reason: '无 cert 约束' };
  const minRank = rankFidelity(minFidelity);
  if (minRank == null) return { pass: false, reason: `非法 minFidelity '${minFidelity}'` };
  const certs = Array.isArray(nm.certification) ? nm.certification : (nm.certification ? [nm.certification] : []);
  let best = -1;
  for (const c of certs) {
    const cs = String(_pick(c, 'certStatus', 'cert_status', 'status') || '').toLowerCase();
    if (cs !== 'certified') continue;
    const r = rankFidelity(_pick(c, 'fidelityClass', 'fidelity_class') || 'UNKNOWN');
    if (r != null && r > best) best = r;
  }
  if (best < 0) return { pass: false, reason: `无 certified 认证（minFidelity=${minFidelity}）` };
  if (best < minRank) return { pass: false, reason: `fidelity 不足（best rank ${best} < ${minRank}）` };
  return { pass: true, reason: `cert 达标（fidelity ≥ ${minFidelity}）` };
}

function _admitQuota(nm) {
  const q = nm.quota;
  if (q == null) return { pass: true, reason: '无 quota 信息（dry-run 放行）' };
  if (typeof q === 'boolean') return q ? { pass: true, reason: 'quota 可用' } : { pass: false, reason: 'quota 已耗尽' };
  if (q && typeof q === 'object') {
    if (q.available === false) return { pass: false, reason: 'quota 已耗尽' };
    if (q.scope && q.usage != null) {
      const ev = evaluateScopeCapacity(q.scope, q.usage);
      if (!ev.available) return { pass: false, reason: `quota 容量不足: ${ev.reason || 'capacity exhausted'}` };
    }
    return { pass: true, reason: 'quota 可用' };
  }
  return { pass: true, reason: '无 quota 约束' };
}

function _admitCredential(nm) {
  return nm.hasCredential ? { pass: true, reason: '有凭证' } : { pass: false, reason: '无有效凭证' };
}

function _admitServiceClass(nm, ctx) {
  const want = (ctx.requirements && ctx.requirements.serviceClass) || null;
  if (!want) return { pass: true, reason: '无 service class 约束' };
  const offered = new Set();
  if (nm.serviceClass != null) offered.add(String(nm.serviceClass).toLowerCase());
  if (Array.isArray(nm.serviceClasses)) nm.serviceClasses.forEach((s) => offered.add(String(s).toLowerCase()));
  if (offered.size === 0) return { pass: true, reason: 'service class 未声明（dry-run 放行）' };
  const pass = offered.has(String(want).toLowerCase());
  return { pass, reason: pass ? `service class '${want}' 可用` : `service class '${want}' 不支持（提供 ${[...offered].join(',')}）` };
}

function _admitCostCeiling(nm, ctx) {
  const maxCost = (ctx.requirements && ctx.requirements.maxCost);
  if (maxCost == null || !Number.isFinite(Number(maxCost))) return { pass: true, reason: '无 cost ceiling' };
  if (!Number.isFinite(nm.cost)) return { pass: true, reason: '成本未声明（dry-run 放行）' };
  const pass = nm.cost <= Number(maxCost);
  return { pass, reason: pass ? `cost ${nm.cost} ≤ ${maxCost}` : `cost ${nm.cost} 超上限 ${maxCost}` };
}

function _admitProviderHealth(nm, ctx) {
  const minHealth = (ctx.requirements && ctx.requirements.minHealth) != null ? Number(ctx.requirements.minHealth) : 0.5;
  if (!Number.isFinite(nm.health)) return { pass: true, reason: 'health 未声明（dry-run 放行）' };
  const pass = nm.health >= minHealth;
  return { pass, reason: pass ? `health ${nm.health} ≥ ${minHealth}` : `health ${nm.health} < ${minHealth}` };
}

// 前 12 道谓词表（score 为第 13 道，单独计算，不作淘汰）
const ADMISSION_PREDICATES = {
  operationCompat: _admitOperationCompat,
  schemaCompat: _admitSchemaCompat,
  requiredSemantic: _admitRequiredSemantic,
  modelLifecycle: _admitModelLifecycle,
  dataPrivacy: _admitDataPrivacy,
  region: _admitRegion,
  providerCert: _admitProviderCert,
  quota: _admitQuota,
  credential: _admitCredential,
  serviceClass: _admitServiceClass,
  costCeiling: _admitCostCeiling,
  providerHealth: _admitProviderHealth,
  score: null,
};

/** §33 score（第 13 道，仅对通过前 12 道的幸存者计算）。 */
function scoreModel(nm) {
  const q = Number.isFinite(nm.quality) ? clamp01(nm.quality) : 0.5;
  const rel = Number.isFinite(nm.reliability) ? clamp01(nm.reliability) : 0.5;
  const latMs = Number.isFinite(nm.latencyMs) ? nm.latencyMs : 0;
  const latencyScore = 1 - clamp01(latMs / LATENCY_REF_MS);
  const cost = Number.isFinite(nm.cost) ? nm.cost : 0;
  const costScore = 1 - clamp01(cost / COST_REF_UNITS);
  const score =
    (q * MODEL_SCORE_WEIGHTS.quality) +
    (rel * MODEL_SCORE_WEIGHTS.reliability) +
    (latencyScore * MODEL_SCORE_WEIGHTS.latency) +
    (costScore * MODEL_SCORE_WEIGHTS.cost);
  return { score, components: { quality: q, reliability: rel, latencyScore, costScore } };
}

function _emptyReasons(rejected, preRejected) {
  const rs = [];
  if (preRejected.length) rs.push(`候选池为空：mediaType 预筛剔除 ${preRejected.length} 个 model`);
  for (const r of rejected) rs.push(`[${r.rejectedAt}] ${r.logicalModelCode}: ${r.rejectReason}`);
  if (rs.length === 0) rs.push('无候选 model');
  return rs;
}

/**
 * 上层 Auto Model Router（L38）。
 * @param {object} args
 *   - mediaType       媒体类型（候选池粗筛轴，非 13 道之一）
 *   - operationCode   Operation 码（第 1 道）
 *   - requirements    { params, requiredSemantics, minFidelity, maxCost, minHealth,
 *                       allowedRegions, zdrRequired, noTrainingProvider, serviceClass,
 *                       mode:'auto'|'manual', manualModelCode }
 *   - semantics       语义上下文（透传，当前由 requirements.requiredSemantics 表达）
 *   - models          ACTIVE 候选 model 描述符数组
 * @returns {{ok, code, model, score, reasons, rejected, preRejected, ranking, manual, admissionOrder}}
 */
function routeModel({ mediaType, operationCode, requirements = {}, semantics = {}, models = [], opts = {} } = {}) {
  const req = requirements || {};
  const manual = req.mode === 'manual' || (req.manualModelCode != null && req.manualModelCode !== '');
  const manualCode = manual ? String(req.manualModelCode || req.modelCode || '') : '';

  const emptyEnvelope = (over) => Object.assign({
    ok: false, code: NO_ROUTABLE_MODEL, model: null, score: null, reasons: [],
    rejected: [], preRejected: [], ranking: [], manual, admissionOrder: ADMISSION_ORDER,
  }, over);

  let normalized = (models || []).map(normalizeModel).filter((nm) => nm.code !== '');

  // 手动直通（§30）：锁定单 model，禁跨 model fallback
  if (manual) {
    if (!manualCode) {
      return emptyEnvelope({ code: 'INVALID_ARGUMENT', reasons: ['手动模式必须提供 manualModelCode'] });
    }
    const pinned = normalized.filter((nm) => nm.code === manualCode);
    if (pinned.length === 0) {
      return emptyEnvelope({ reasons: [`手动锁定 model '${manualCode}' 不在候选集，禁止跨 model fallback（§30）`] });
    }
    normalized = pinned;
  }

  // 媒体轴粗筛（非 13 道）
  const preRejected = [];
  let pool = [];
  if (mediaType != null && mediaType !== '') {
    for (const nm of normalized) {
      if (nm.mediaType === String(mediaType)) pool.push(nm);
      else preRejected.push({ logicalModelCode: nm.code, reason: `mediaType 不匹配（${nm.mediaType || '未声明'} != ${mediaType}）` });
    }
  } else {
    pool = normalized.slice();
  }

  const ctx = { mediaType, operationCode, requirements: req, semantics };
  const rejected = [];
  let survivors = pool.slice();

  // 前 12 道逐道淘汰（固定序，短路：无候选即停）
  for (let i = 0; i < ADMISSION_ORDER.length; i++) {
    const step = ADMISSION_ORDER[i];
    if (step === 'score') continue;
    const next = [];
    for (const nm of survivors) {
      const r = ADMISSION_PREDICATES[step](nm, ctx);
      if (r.pass) next.push(nm);
      else rejected.push({ logicalModelCode: nm.code, rejectedAt: step, rejectReason: r.reason });
    }
    survivors = next;
    if (survivors.length === 0) break;
  }

  // 第 13 道：score（最后才算），排序定胜者
  let ranking = [];
  let chosen = null;
  let chosenScore = null;
  if (survivors.length > 0) {
    ranking = survivors.map((nm) => {
      const s = scoreModel(nm);
      return { logicalModelCode: nm.code, score: s.score, components: s.components, model: nm._raw };
    }).sort((a, z) => (z.score - a.score) || String(a.logicalModelCode).localeCompare(String(z.logicalModelCode)));
    chosen = ranking[0];
    chosenScore = chosen.score;
  }

  // 选中 model 的逐道原因链（可解释决策）
  let reasons = [];
  if (chosen) {
    const chosenNm = survivors.find((nm) => nm.code === chosen.logicalModelCode);
    for (let i = 0; i < ADMISSION_ORDER.length; i++) {
      const step = ADMISSION_ORDER[i];
      if (step === 'score') {
        reasons.push(`[13/13 score] ${chosen.logicalModelCode} score=${chosenScore.toFixed(4)}（quality ${chosen.components.quality.toFixed(2)}×${MODEL_SCORE_WEIGHTS.quality} + reliability ${chosen.components.reliability.toFixed(2)}×${MODEL_SCORE_WEIGHTS.reliability} + latency ${chosen.components.latencyScore.toFixed(2)}×${MODEL_SCORE_WEIGHTS.latency} + cost ${chosen.components.costScore.toFixed(2)}×${MODEL_SCORE_WEIGHTS.cost}）`);
      } else {
        const r = ADMISSION_PREDICATES[step](chosenNm, ctx);
        reasons.push(`[${i + 1}/13 ${step}] ${r.pass ? '✓' : '✗'} ${r.reason}`);
      }
    }
  } else {
    reasons = _emptyReasons(rejected, preRejected);
  }

  return {
    ok: chosen != null,
    code: chosen != null ? null : NO_ROUTABLE_MODEL,
    model: chosen ? chosen.model : null,
    score: chosenScore,
    reasons,
    rejected,
    preRejected,
    ranking,
    manual,
    admissionOrder: ADMISSION_ORDER,
  };
}

// ─── 下层 Binding Router（L37）────────────────────────────────────────────

function _bindingModelCode(b) {
  const m = b && b.model;
  return String(_pick(b, 'logicalModelCode') || (m && _pick(m, 'model_id', 'logicalModelCode', 'code')) || _pick(b, 'modelId', 'model_id') || '');
}

function _bindingFidelityRank(b) {
  const cert = b && (b.cert || b.certification);
  if (!cert) return -1;
  const cs = String(_pick(cert, 'certStatus', 'cert_status', 'status') || '').toLowerCase();
  if (cs !== 'certified') return -1;
  const r = rankFidelity(_pick(cert, 'fidelityClass', 'fidelity_class') || 'UNKNOWN');
  return r == null ? -1 : r;
}

function _bindingCost(b) {
  const c = _pick(b, 'cost', 'unitCost', 'price');
  return c == null ? null : Number(c);
}

/**
 * 下层 Binding Router（L37）：同 model 内多 binding 选路。
 * @param {object} args
 *   - logicalModelCode  本 model（同 model 内选路；禁跨 model）
 *   - operationCode     Operation 码（上下文，用于容量/额度评估，不作 binding 淘汰门）
 *   - bindings          binding 行数组（loadDispatchPairs 形状：{bindingId, model, provider, quotaScope, cert, cost, bindingWeight}）
 *   - providerConstraints { minFidelity, maxCost }
 *   - usage             容量只读评估输入（number | { [bindingId|scope_id]: number }）
 * @returns {{ok, code, binding, bindingId, score, reasons, rejected, crossModelRejected, ranking}}
 */
function routeBinding({ logicalModelCode, operationCode, bindings = [], providerConstraints = {}, usage = {}, opts = {} } = {}) {
  const emptyEnvelope = (over) => Object.assign({
    ok: false, code: NO_ROUTABLE_BINDING, binding: null, bindingId: null, score: null, reasons: [],
    rejected: [], crossModelRejected: [], ranking: [],
  }, over);

  if (!logicalModelCode) {
    return emptyEnvelope({ code: 'INVALID_ARGUMENT', reasons: ['logicalModelCode 必填（同 model 内选路）'] });
  }
  const pc = providerConstraints || {};

  // 层隔离（§29 禁跨 model）：非本 model 的 binding 一律排除并记录
  const crossModelRejected = [];
  const scoped = [];
  for (const b of (bindings || [])) {
    const mc = _bindingModelCode(b);
    if (mc !== String(logicalModelCode)) {
      crossModelRejected.push({ bindingId: String(_pick(b, 'bindingId', 'id') || ''), modelId: mc, reason: `跨 model binding（${mc} != ${logicalModelCode}），下层禁跨 model 选` });
      continue;
    }
    scoped.push(b);
  }

  const rejected = [];
  const eligible = [];

  for (const b of scoped) {
    const bid = String(_pick(b, 'bindingId', 'id') || '');
    const certRank = _bindingFidelityRank(b);
    const cost = _bindingCost(b);
    const minFidelity = pc.minFidelity || null;
    const maxCost = pc.maxCost;

    // 1) cert 过滤（minFidelity）
    if (minFidelity) {
      const minRank = rankFidelity(minFidelity);
      if (minRank == null) {
        rejected.push({ bindingId: bid, rejectedAt: 'cert', rejectReason: `非法 minFidelity '${minFidelity}'` });
        continue;
      }
      if (certRank < 0) {
        rejected.push({ bindingId: bid, rejectedAt: 'cert', rejectReason: `无 certified 认证（minFidelity=${minFidelity}）` });
        continue;
      }
      if (certRank < minRank) {
        rejected.push({ bindingId: bid, rejectedAt: 'cert', rejectReason: `fidelity 不足（rank ${certRank} < ${minRank}）` });
        continue;
      }
    }

    // 2) 成本过滤（maxCost ceiling）
    if (maxCost != null && Number.isFinite(Number(maxCost)) && cost != null && Number.isFinite(cost)) {
      if (cost > Number(maxCost)) {
        rejected.push({ bindingId: bid, rejectedAt: 'cost', rejectReason: `cost ${cost} 超上限 ${maxCost}` });
        continue;
      }
    }

    // 3) 容量过滤（admission 只读评估，不占槽位）
    const scope = _pick(b, 'quotaScope', 'quota_scope');
    if (scope) {
      const u = typeof usage === 'number' ? usage : _pick(usage, bid, scope.scope_id, scope.scope_code, 'current');
      const ev = evaluateScopeCapacity(scope, u == null ? 0 : Number(u));
      if (!ev.available) {
        rejected.push({ bindingId: bid, rejectedAt: 'capacity', rejectReason: `容量不足: ${ev.reason || 'capacity exhausted'}` });
        continue;
      }
    }

    // 打分：成本优先（50%）+ cert 保真（30%）+ 人工权重（20%）
    const fidelityNorm = certRank >= 0 ? certRank / 3 : 0;
    const costNorm = (cost != null && Number.isFinite(cost)) ? clamp01(cost / COST_REF_UNITS) : 0;
    const costScore = 1 - costNorm;
    const weightScore = clamp01(Number(_pick(b, 'bindingWeight', 'weight') || 0));
    const score = (0.50 * costScore) + (0.30 * fidelityNorm) + (0.20 * weightScore);

    eligible.push({
      bindingId: bid,
      modelId: _bindingModelCode(b),
      providerId: String((b.provider && b.provider.id) || _pick(b, 'providerId') || ''),
      score,
      cost,
      certRank,
      components: { costScore, fidelityNorm, weightScore },
      binding: b,
    });
  }

  const ranking = eligible.slice().sort((a, z) => (z.score - a.score) || String(a.bindingId).localeCompare(String(z.bindingId)));
  const chosen = ranking[0] || null;

  const reasons = [];
  if (chosen) {
    reasons.push(`同 model '${logicalModelCode}' 内 ${scoped.length} 条 binding，成本优先选 '${chosen.bindingId}'`);
    reasons.push(`cost=${chosen.cost == null ? '未声明' : chosen.cost}（costScore ${chosen.components.costScore.toFixed(2)}×0.50 + cert ${chosen.components.fidelityNorm.toFixed(2)}×0.30 + weight ${chosen.components.weightScore.toFixed(2)}×0.20）→ score=${chosen.score.toFixed(4)}`);
    if (crossModelRejected.length) reasons.push(`层隔离：已排除 ${crossModelRejected.length} 条跨 model binding`);
  } else {
    for (const r of rejected) reasons.push(`[${r.rejectedAt}] ${r.bindingId}: ${r.rejectReason}`);
    if (crossModelRejected.length) reasons.push(`层隔离：已排除 ${crossModelRejected.length} 条跨 model binding`);
    if (rejected.length === 0) reasons.push(`无 binding 候选（model '${logicalModelCode}' 下无 binding）`);
  }

  return {
    ok: chosen != null,
    code: chosen != null ? null : NO_ROUTABLE_BINDING,
    binding: chosen ? chosen.binding : null,
    bindingId: chosen ? chosen.bindingId : null,
    score: chosen ? chosen.score : null,
    reasons,
    rejected,
    crossModelRejected,
    ranking: ranking.map((r) => ({ bindingId: r.bindingId, modelId: r.modelId, providerId: r.providerId, score: r.score })),
  };
}

/**
 * Resolve / dry-run（§36）——组合上下两层，无提交权威（§37）。
 * @param {object} args  见 routeModel / routeBinding（models + bindings 均注入）
 * @returns {{ok, code, decision:{model, binding, score, bindingScore, reasons}, modelTrace, bindingTrace}}
 *   候选空 → { ok:false, code:'NO_ROUTABLE_MODEL', decision:{...reasons} }
 */
function resolveRoute({ mediaType, operationCode, requirements = {}, semantics = {}, models = [], bindings = [], opts = {} } = {}) {
  const req = requirements || {};
  const modelTrace = routeModel({ mediaType, operationCode, requirements: req, semantics, models, opts });

  let bindingTrace = null;
  if (modelTrace.ok && modelTrace.model) {
    const chosenModelCode = normalizeModel(modelTrace.model).code;
    bindingTrace = routeBinding({
      logicalModelCode: chosenModelCode,
      operationCode,
      bindings,
      providerConstraints: req.providerConstraints || {},
      usage: req.usage || {},
      opts,
    });
  }

  if (!modelTrace.ok) {
    return {
      ok: false,
      code: modelTrace.code || NO_ROUTABLE_MODEL,
      decision: { model: null, binding: null, score: null, reasons: modelTrace.reasons },
      modelTrace,
      bindingTrace,
    };
  }

  const reasons = [].concat(modelTrace.reasons, bindingTrace ? bindingTrace.reasons : []);
  return {
    ok: true,
    code: null,
    decision: {
      model: modelTrace.model,
      binding: bindingTrace ? bindingTrace.binding : null,
      score: modelTrace.score,
      bindingScore: bindingTrace ? bindingTrace.score : null,
      reasons,
    },
    modelTrace,
    bindingTrace,
  };
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
  // L37 + L38 双层 Router
  ADMISSION_ORDER,
  MODEL_SCORE_WEIGHTS,
  ROUTABLE_LIFECYCLES,
  BINDING_GATE_ORDER,
  NO_ROUTABLE_MODEL,
  NO_ROUTABLE_BINDING,
  normalizeModel,
  scoreModel,
  routeModel,
  routeBinding,
  resolveRoute,
};
