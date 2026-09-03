'use strict';
/**
 * W3-05 — Router product-input expansion (pure decision logic, no I/O).
 * Route decision considers task, continuity need, duration/resolution, reference support,
 * provider health, latency, cost, historical success, accepted-shot rate and plan.
 */

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

module.exports = { routeDecision, scoreProvider, planRank };
