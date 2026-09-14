'use strict';
/**
 * M02-A AI Control Plane — Routing Decision (audit contract)
 *
 * 路由决策的【可审计投影】。不重写 ModelHub V3 的 routeBindings（已认证 admission），
 * 而是把它的输出（chosen/ranking/rejected）规范化成一个带 routing_decision_id 的审计记录，
 * 供日志/telemetry/UI 决策解释面板消费，并建立 adapter boundary 让 Generation V2 的上游
 * 配置解析层可以复用同一决策结构。
 *
 * 输入：routeBindings 风格的结果 + 请求上下文。
 * 输出：{ routing_decision_id, model_id, capability, selected, reason, fallback_candidates[], rejected[], ts }
 */
const crypto = require('node:crypto');

function newDecisionId() {
  return 'rd-' + crypto.randomBytes(8).toString('hex');
}

/**
 * @param {object} routeResult  { chosen, ranking, rejected, weights, seed }（来自 modelhub/router.routeBindings）
 * @param {object} ctx  { model_id, capability?, contentType?, region?, cost_preference?, latency_preference?, now? }
 * @returns {object} 审计决策记录（纯，无 secret）
 */
function toRoutingDecision(routeResult, ctx = {}) {
  const now = ctx.now || Date.now();
  const rr = routeResult || {};
  const chosen = rr.chosen || null;
  const ranking = Array.isArray(rr.ranking) ? rr.ranking : [];
  const rejected = Array.isArray(rr.rejected) ? rr.rejected : [];

  // fallback 候选 = 除 chosen 外的 ranking 头部（按分数降序，天然 fallback 顺序）
  const fallback = chosen
    ? ranking.filter((r) => r.bindingId !== chosen.bindingId).map((r) => summarizeCandidate(r))
    : ranking.map((r) => summarizeCandidate(r));

  return {
    routing_decision_id: newDecisionId(),
    ts: now,
    model_id: ctx.model_id ?? (chosen && chosen.modelId) ?? null,
    capability: ctx.capability ?? ctx.contentType ?? null,
    region: ctx.region ?? null,
    cost_preference: ctx.cost_preference ?? null,
    latency_preference: ctx.latency_preference ?? null,
    selected: chosen ? summarizeCandidate(chosen) : null,
    reason: chosen
      ? (Array.isArray(chosen.reasons) ? chosen.reasons.join('; ') : 'selected')
      : (rejected.length ? 'no eligible binding' : 'no candidates'),
    fallback_candidates: fallback,
    rejected: rejected.map((r) => ({
      bindingId: r.bindingId,
      modelId: r.modelId,
      providerId: r.providerId,
      rejectedAt: r.rejectedAt,
      reason: r.rejectReason,
    })),
    // 解释性权重/种子（诊断用，非 secret）
    weights: rr.weights ?? null,
    seed: rr.seed ?? null,
  };
}

function summarizeCandidate(c) {
  return {
    bindingId: c.bindingId,
    modelId: c.modelId,
    providerId: c.providerId,
    score: typeof c.score === 'number' ? c.score : null,
    components: c.components ?? null,
  };
}

module.exports = { newDecisionId, toRoutingDecision };
