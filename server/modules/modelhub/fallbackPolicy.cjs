'use strict';
/**
 * W4-07 — Fallback policy + legacy adapter (pure, no I/O). If the primary route fails (classified
 * retryable/permanent), pick the next candidate; legacy adapter maps a legacy single-model call
 * to the new route shape.
 */
function pickFallback({ candidates = [], failedId, classification, legacy } = {}) {
  if (legacy) {
    // legacy adapter: model routing -> deterministic fallback to a legacy provider
    return { ok: true, fallback: { id: (legacy.fallbackModel || 'legacy'), legacy: true, model: legacy.fallbackModel || null } };
  }
  // skip the failed provider + any non-viable (score<=0 or missing capability)
  const viable = candidates.filter((c) => c.id !== failedId && c.score != null && c.score > 0);
  if (!viable.length) return { ok: false, error: { code: 'NO_FALLBACK', reason: classification && classification.reason } };
  const next = viable[0];
  return { ok: true, fallback: { id: next.id, score: next.score, reasons: next.reasons } };
}

module.exports = { pickFallback };
