'use strict';
/**
 * W4-08 — Terminal settlement/release + Shot generation history (pure archive, no I/O).
 * Records the generation run for a Shot (status, route/model, settle/release) as a durable history
 * row. The money transition is the W3-10 reserve finalize; this module archives it per Shot.
 */
const crypto = require('crypto');
const { finalize } = require('./shotSpend.cjs');

/** Build a generation-history record for a Shot on terminal transition. */
function buildShotGenerationHistory({ shotId, generationId, route, model, outcome, reserve, quoteAmount, error } = {}) {
  if (!shotId) return { ok: false, error: { code: 'HISTORY_MISSING_SHOT' } };
  const fin = finalize({ reserveId: reserve && reserve.reserveId, action: outcome === 'success' ? 'commit' : 'release', outcome });
  const status = outcome === 'success' ? 'committed' : (outcome === 'canceled' ? 'released' : 'failed');
  return {
    ok: true,
    history: {
      historyId: `gh-${crypto.randomUUID()}`,
      shotId,
      generationId: generationId || null,
      route: route || null,
      model: model || null,
      outcome,
      status,
      amount: quoteAmount != null ? quoteAmount : null,
      settlement: fin.ok ? fin.status : null,
      error: error || null,
      finalizeCode: fin.ok ? null : (fin.error && fin.error.code),
      recordedAt: new Date().toISOString(),
    },
  };
}

module.exports = { buildShotGenerationHistory };
