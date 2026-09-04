'use strict';
/**
 * W3-05 — Router product-input expansion (pure decision logic, no I/O).
 * Route decision considers task, continuity need, duration/resolution, reference support,
 * provider health, latency, cost, historical success, accepted-shot rate and plan.
 *
 * L39 — Resolve / dry-run wiring (§36-37). The strict two-layer router
 * (routeModel L38 / routeBinding L37 / resolveRoute) lives in router.cjs as PURE
 * functions taking `models` + `bindings` descriptor arrays. This module adds the
 * async data-fetching "接线" (wiring) that reads REAL registry candidates from the
 * DB — logical_models (registry L1) and provider_model_bindings (binding layer) —
 * and injects them into router.cjs's resolveRoute. Pure read-only: no generation,
 * no reservation, no admission slot acquire (§37 无提交权威).
 */
const { resolveRoute: coreResolveRoute } = require('./router.cjs');

/** Compute a provider score + pick the best provider. Deterministic (ties broken by id). */
function routeDecision({ task, providers = [], continuity = {}, duration, resolution, plan, requiredCapabilities = [] } = {}) {
  const reqType = task && task.type;

  const scored = providers.map((p) => {
    const bits = scoreProvider({
      p,
      reqType,
      continuity, duration, resolution, plan,
      requiredCapabilities,
    });
    return { id: p.id, ...bits };
  }).sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));

  const top = scored[0] || null;
  const chosen = top && top.score > 0 ? top.id : null;
  return {
    ok: Boolean(chosen),
    chosen,
    candidates: scored,
    reason: chosen ? top.reasons : (scored.length ? 'NO_VIABLE_PROVIDER' : 'NO_PROVIDERS'),
  };
}

function scoreProvider({ p, reqType, continuity = {}, duration, resolution, plan, requiredCapabilities = [] }) {
  let score = 0;
  const reasons = [];
  const caps = new Set(p.capabilities || []);

  // required capability gate (reference support, etc.) — hard requirement
  for (const c of requiredCapabilities) {
    if (!caps.has(c)) return { score: -Infinity, reasons: [`missing_capability:${c}`], health: p.health, cost: p.cost, latency: p.latency };
  }
  // task type gate
  if (reqType && p.supportsTask && !p.supportsTask.includes(reqType)) {
    return { score: -Infinity, reasons: [`unsupported_task:${reqType}`], health: p.health, cost: p.cost, latency: p.latency };
  }
  // continuity need (character/state continuity) — providers with continuity support score up
  if (continuity && (continuity.needsContinuity || continuity.placeholders?.length)) {
    if (caps.has('continuity')) { score += 3; reasons.push('continuity_supported'); }
    else score -= 2;
  }
  // duration/resolution fit
  if (duration != null && p.maxDuration && duration > p.maxDuration) { score -= 2; reasons.push('over_duration'); }
  if (resolution != null && p.resolutions && !p.resolutions.includes(resolution)) { /* acceptable */ }
  // plan gate
  if (plan && p.minPlan && !planRank(p.minPlan, plan)) return { score: -Infinity, reasons: ['plan_insufficient'], health: p.health, cost: p.cost, latency: p.latency };
  // hard health gate — dead provider is disqualified
  if (p.health != null && p.health < 0.5) return { score: -Infinity, reasons: ['health_low'], health: p.health, cost: p.cost, latency: p.latency };

  // quality + economics
  score += (p.historicalSuccess != null ? p.historicalSuccess * 5 : 0) || 0;
  score += (p.acceptedShotRate != null ? p.acceptedShotRate * 4 : 0) || 0;
  score -= (p.cost != null ? p.cost : 0.5);
  score -= (p.latency != null ? p.latency / 1000 : 0);
  if (caps.has('reference')) { score += 1; reasons.push('reference_supported'); }
  reasons.push(`score:${score.toFixed(2)}`);
  return { score, reasons, health: p.health, cost: p.cost, latency: p.latency };
}

function planRank(minPlan, userPlan) {
  const order = { free: 0, pro: 1, enterprise: 2 };
  return (order[userPlan] ?? 0) >= (order[minPlan] ?? 0);
}

// ═══════════════════════════════════════════════════════════════════════════
//  L39 — Resolve / dry-run 接线（读 registry 真库候选 → 注入 routeModel/routeBinding）
// ═══════════════════════════════════════════════════════════════════════════

/** 空决策信封（统一形状，供各类失败复用）。 */
function emptyEnvelope(code, reasons) {
  return {
    ok: false,
    code,
    decision: { model: null, binding: null, score: null, reasons: reasons || [] },
    alternatives: undefined,
    modelTrace: null,
    bindingTrace: null,
  };
}

/**
 * 读 registry 候选 logical model（上层 routeModel 输入）。
 *  - logical_models（media_type 粗筛 + status=ACTIVE；可选 code 锁定 = 手动直通）
 *  - model_revisions（metadata：成本/质量/延迟等可选富字段）
 *  - model_operation_revisions × model_operations（supported operations + input_schema + semantics）
 * 表缺失/查询失败 → 优雅降级返回 []（候选空 → NO_ROUTABLE_MODEL），不向上抛异常。
 * @param {{query:Function}} pg
 * @param {{mediaType:string, logicalModelCode?:string}} q
 * @returns {Promise<Array<object>>} model 描述符（normalizeModel 兼容形状）
 */
async function fetchModels(pg, { mediaType, logicalModelCode } = {}) {
  try {
    const params = [mediaType];
    let sql = "SELECT * FROM logical_models WHERE media_type = $1 AND status = 'ACTIVE'";
    if (logicalModelCode != null && String(logicalModelCode) !== '') {
      sql += ' AND code = $2';
      params.push(String(logicalModelCode));
    }
    sql += ' ORDER BY code ASC';
    const lmRes = await pg.query(sql, params);
    const lms = lmRes.rows || [];
    if (lms.length === 0) return [];

    const lmById = new Map(lms.map((l) => [l.id, l]));
    const lmIds = [...lmById.keys()];

    // 该批 logical model 的 ACTIVE revisions（metadata 富字段）
    const revRes = await pg.query(
      `SELECT logical_model_id, metadata FROM model_revisions
        WHERE logical_model_id = ANY($1) AND status = 'ACTIVE'
        ORDER BY released_at DESC NULLS LAST, created_at DESC, id ASC`,
      [lmIds],
    );
    const revsByLm = new Map();
    for (const r of revRes.rows || []) {
      if (!revsByLm.has(r.logical_model_id)) revsByLm.set(r.logical_model_id, []);
      revsByLm.get(r.logical_model_id).push(r);
    }

    // ACTIVE operation revisions（supported operations + schema/semantics）
    const opRes = await pg.query(
      `SELECT mor.input_schema, mor.semantic_map, mor.capability_descriptor,
              mo.code AS operation_code, mr.logical_model_id
         FROM model_operation_revisions mor
         JOIN model_revisions mr ON mr.id = mor.model_revision_id
         JOIN model_operations mo ON mo.id = mor.operation_id
        WHERE mor.status = 'ACTIVE' AND mr.status = 'ACTIVE' AND mr.logical_model_id = ANY($1)
        ORDER BY mo.code ASC`,
      [lmIds],
    );
    const opsByLm = new Map();
    for (const r of opRes.rows || []) {
      if (!opsByLm.has(r.logical_model_id)) opsByLm.set(r.logical_model_id, []);
      opsByLm.get(r.logical_model_id).push(r);
    }

    return lms.map((lm) => {
      const ops = opsByLm.get(lm.id) || [];
      const revs = revsByLm.get(lm.id) || [];
      const opCodes = [...new Set(ops.map((o) => o.operation_code).filter(Boolean))];
      const first = ops[0] || {};
      // metadata：首个 ACTIVE revision 的富字段（宽容合并，缺失字段由 score 默认值兜底）
      const meta = {};
      for (const rv of revs) {
        if (rv.metadata && typeof rv.metadata === 'object') {
          for (const [k, v] of Object.entries(rv.metadata)) {
            if (meta[k] === undefined) meta[k] = v;
          }
        }
      }
      return Object.assign({
        logicalModelCode: lm.code,
        mediaType: lm.media_type,
        status: lm.status,
        operations: opCodes,
        schema: first.input_schema !== undefined ? first.input_schema : undefined,
        semantics: first.capability_descriptor || first.semantic_map || undefined,
      }, meta);
    });
  } catch (e) {
    console.warn('[routerDecision] fetchModels 失败(降级为空候选):', e && e.message);
    return [];
  }
}

/**
 * 读 provider binding 候选（下层 routeBinding 输入）。
 *  - provider_model_bindings（enabled）+ providers（enabled）→ binding 行
 *  - models.credit_cost → binding 成本（成本优先打分；缺省 null → 平分，由 bindingId tie-break）
 * 表缺失/查询失败 → 优雅降级返回 []。
 * @param {{query:Function}} pg
 * @param {string[]} modelCodes logical model code 数组（bindings.model_id 语义 = logical code）
 * @returns {Promise<Array<object>>} binding 描述符（routeBinding 兼容形状）
 */
async function fetchBindings(pg, modelCodes = []) {
  if (!Array.isArray(modelCodes) || modelCodes.length === 0) return [];
  try {
    const bRes = await pg.query(
      `SELECT pmb.id AS binding_id, pmb.model_id, pmb.provider_id,
              pmb.upstream_model_name, pmb.priority, pmb.weight
         FROM provider_model_bindings pmb
         JOIN providers p ON p.id = pmb.provider_id
        WHERE pmb.enabled = true AND p.enabled = true AND pmb.model_id = ANY($1)
        ORDER BY pmb.model_id ASC, pmb.priority DESC, pmb.id ASC`,
      [modelCodes],
    );
    const rows = bRes.rows || [];

    let costByModel = new Map();
    try {
      const cRes = await pg.query(
        `SELECT model_id, MIN(credit_cost) AS cost FROM models
          WHERE model_id = ANY($1) AND enabled = true GROUP BY model_id`,
        [modelCodes],
      );
      for (const r of cRes.rows || []) costByModel.set(r.model_id, r.cost);
    } catch (_) { /* cost 缺失非阻断 */ }

    return rows.map((b) => ({
      bindingId: b.binding_id,
      logicalModelCode: b.model_id, // 顶层逻辑码：routeBinding 层隔离用（_bindingModelCode 优先取此键）
      model: { logicalModelCode: b.model_id, model_id: b.model_id },
      provider: { id: b.provider_id },
      cost: costByModel.has(b.model_id) ? Number(costByModel.get(b.model_id)) : null,
      bindingWeight: Number(b.weight || 0),
      upstreamModelName: b.upstream_model_name || '',
    }));
  } catch (e) {
    console.warn('[routerDecision] fetchBindings 失败(降级为空候选):', e && e.message);
    return [];
  }
}

/**
 * 组装 alternatives：未被选中的候选（≤3），带淘汰/排序原因。
 *  - 先取幸存者 ranking 中低于所选 model 的 runner-up（带 score，原因=分数更低）
 *  - 不足 3 条时补 rejected（带 `[rejectedAt] rejectReason` 淘汰原因）
 * @param {{decision:object, modelTrace?:object}} core  router.cjs resolveRoute 结果
 * @returns {Array<{logicalModelCode:string, score:number|null, reason:string}>}
 */
function buildAlternatives(core) {
  const out = [];
  const chosen = core && core.decision ? core.decision.model : null;
  const chosenCode = chosen ? String(chosen.logicalModelCode || chosen.code || chosen.model_id || '') : null;
  const mt = (core && core.modelTrace) || {};

  for (const r of mt.ranking || []) {
    if (out.length >= 3) break;
    if (chosenCode && r.logicalModelCode === chosenCode) continue;
    out.push({ logicalModelCode: r.logicalModelCode, score: r.score, reason: 'score 低于所选 model' });
  }
  if (out.length < 3) {
    for (const r of mt.rejected || []) {
      if (out.length >= 3) break;
      out.push({ logicalModelCode: r.logicalModelCode, score: null, reason: `[${r.rejectedAt}] ${r.rejectReason}` });
    }
  }
  return out;
}

/**
 * Resolve / dry-run（§36-37，L39）—— 读 registry 真库候选，注入双层路由，返回可解释决策。
 * 纯只读：不触发任何生成/预留/占槽；提交时须重新 validate+resolve（无提交权威，§37）。
 *
 * @param {object} args
 *   - pg                 PG Pool/Client（需 .query）
 *   - mediaType          required 媒体类型（候选池粗筛轴）
 *   - operationCode      required Operation 码（上层第 1 道）
 *   - logicalModelCode   optional 手动直通锁定（§30：仅该 model 参与，禁跨 model fallback）
 *   - requirements       optional routeModel 需求（params/requiredSemantics/minFidelity/...）
 *   - usage              optional 容量只读评估输入（number | {[bindingId|scope_id]:number}）
 *   - maxCostAuthorized  optional 成本上限（→ 上层 cost ceiling + 下层 binding maxCost）
 *   - opts               optional router opts
 * @returns {Promise<{ok, code, decision:{model,binding,score,bindingScore,reasons},
 *                    alternatives?, modelTrace, bindingTrace}>}
 *   候选空 → { ok:false, code:'NO_ROUTABLE_MODEL', decision:{model:null,binding:null,score:null,reasons:[...]} }
 */
async function resolveRoute({ pg, mediaType, operationCode, logicalModelCode, requirements, usage, maxCostAuthorized, opts } = {}) {
  if (!pg || typeof pg.query !== 'function') {
    return emptyEnvelope('DB_UNAVAILABLE', ['无可用 pg 连接（registry 只读候选读取失败）']);
  }
  if (!mediaType || !operationCode) {
    return emptyEnvelope('INVALID_ARGUMENT', ['mediaType 与 operationCode 必填']);
  }

  // 组装有效需求：手动直通 / 成本上限 / 容量 / minFidelity 透传
  const req = requirements || {};
  const effReq = Object.assign({}, req);
  if (logicalModelCode != null && String(logicalModelCode) !== '') {
    effReq.mode = 'manual';
    effReq.manualModelCode = String(logicalModelCode);
  }
  if (maxCostAuthorized != null && Number.isFinite(Number(maxCostAuthorized))) {
    const mc = Number(maxCostAuthorized);
    effReq.maxCost = mc;
    effReq.providerConstraints = Object.assign({}, req.providerConstraints || {}, { maxCost: mc });
  }
  if (req.minFidelity != null && !(effReq.providerConstraints && effReq.providerConstraints.minFidelity != null)) {
    effReq.providerConstraints = Object.assign({}, effReq.providerConstraints, { minFidelity: req.minFidelity });
  }
  if (usage !== undefined) effReq.usage = usage;

  const models = await fetchModels(pg, { mediaType, logicalModelCode });
  const modelCodes = models.map((m) => m.logicalModelCode).filter(Boolean);
  const bindings = await fetchBindings(pg, modelCodes);

  const core = coreResolveRoute({
    mediaType,
    operationCode,
    requirements: effReq,
    semantics: req.semantics || {},
    models,
    bindings,
    opts,
  });

  const alternatives = buildAlternatives(core);
  return {
    ok: core.ok,
    code: core.code || null,
    decision: {
      model: core.decision.model,
      binding: core.decision.binding,
      score: core.decision.score,
      bindingScore: core.decision.bindingScore,
      reasons: core.decision.reasons,
    },
    alternatives: alternatives.length ? alternatives : undefined,
    modelTrace: core.modelTrace,
    bindingTrace: core.bindingTrace,
  };
}

module.exports = {
  routeDecision,
  scoreProvider,
  planRank,
  // L39 Resolve / dry-run 接线
  resolveRoute,
  fetchModels,
  fetchBindings,
  buildAlternatives,
};
