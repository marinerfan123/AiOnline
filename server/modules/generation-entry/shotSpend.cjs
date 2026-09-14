'use strict';
/**
 * W3-10 — Shot-bound reserve/settle/release contract (pure lifecycle, no I/O).
 * Reserve on generation start (against the project budget + existing user balance), settle on
 * success (commit), release on failure/cancel. Tied to a Shot + quote. No spend outside this cycle.
 */
const crypto = require('crypto');
const { spendDecision } = require('../project-foundation/budget.cjs');

function reserve({ shotId, quote, budget } = {}) {
  if (!shotId) return { ok: false, error: { code: 'RESERVE_MISSING_SHOT' } };
  if (!quote || !quote.estimatedCost) return { ok: false, error: { code: 'RESERVE_MISSING_QUOTE' } };
  const cost = Number(quote.estimatedCost) || 0;
  if (cost <= 0) return { ok: false, error: { code: 'RESERVE_ZERO_COST' } };
  const d = spendDecision({ spent: budget && budget.spent || 0, budget: budget && budget.budget, requested: cost, warningThreshold: budget && budget.warning_threshold, approvalThreshold: budget && budget.approval_threshold });
  if (d.level === 'blocked') return { ok: false, error: { code: 'BUDGET_BLOCKED', reason: d.reason } };
  return {
    ok: true,
    reserveId: `rs-${crypto.randomUUID()}`,
    shotId,
    amount: cost,
    currency: quote.currency || 'CNY',
    status: 'reserved',
    level: d.level,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

/** Transition a reserve: commit (settle) or release. Returns {ok, status}. */
function finalize({ reserveId, action, outcome = 'success' } = {}) {
  if (!reserveId) return { ok: false, error: { code: 'FINALIZE_MISSING_RESERVE' } };
  if (!['commit', 'release'].includes(action)) return { ok: false, error: { code: 'FINALIZE_BAD_ACTION' } };
  const status = action === 'commit' ? (outcome === 'success' ? 'settled' : 'released') : 'released';
  return { ok: true, reserveId, action, status, settledAt: new Date().toISOString() };
}

module.exports = { reserve, finalize };
