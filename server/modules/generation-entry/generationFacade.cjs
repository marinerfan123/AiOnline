'use strict';
/**
 * W4-01 — Product Generation Facade. Compose the W3 engine primitives into a single, versioned
 * generation initiation sequence for a Shot: IR -> compile -> route -> quote -> reserve -> init.
 * Pure orchestration (no I/O) so the pipeline is deterministic + unit-testable.
 */
const { buildPromptIr } = require('../prompt-ir/promptIr.cjs');
const { compilePrompt } = require('../prompt-ir/promptCompiler.cjs');
const { routeDecision } = require('../modelhub/routerDecision.cjs');
const { buildQuote } = require('./quoteService.cjs');
const { reserve } = require('./shotSpend.cjs');

function generateInit({ shot, deliverySpec, references = [], camera, intent, providers, plan, budget, capability = 'internal' } = {}) {
  if (!shot) return { ok: false, error: { code: 'FACADE_MISSING_SHOT' } };
  // 1. IR
  const ir = buildPromptIr({ shot, deliverySpec, references, camera, intent });
  const irVal = ir && ir.shot && ir.shot.shotId ? ir : null;
  if (!irVal) return { ok: false, error: { code: 'FACADE_INVALID_IR' } };
  // 2. compile
  const compiled = compilePrompt(ir, { capability });
  if (!compiled.ok) return compiled;
  // 3. route
  const route = routeDecision({ task: { type: shot.mediaType || (deliverySpec && deliverySpec.duration > 3 ? 'video' : 'image') }, providers, duration: (deliverySpec || {}).duration, resolution: (deliverySpec || {}).resolution, plan, requiredCapabilities: (deliverySpec || {}).requiredCapabilities });
  if (!route.ok) return { ok: false, error: { code: 'FACADE_NO_ROUTE', reason: route.reason } };
  const routeProvider = providers.find((p) => p.id === route.chosen);
  // 4. quote (no reserve)
  const quote = buildQuote({ shotId: shot.id, route: routeProvider, deliverySpec, plan });
  if (!quote.ok) return quote;
  // 5. reserve (budget overlay; existing user balance remains source of funds)
  const reserveRes = reserve({ shotId: shot.id, quote: quote.quote, budget });
  if (!reserveRes.ok) return { ok: false, error: { code: 'FACADE_RESERVE_BLOCKED', reason: reserveRes.error.reason } };
  // 6. init
  return {
    ok: true,
    init: {
      cascadeVersion: 1,
      shotId: shot.id,
      ir,
      compiledPrompt: compiled.prompt,
      compiledVersion: compiled.version,
      route: { id: route.chosen, provider: routeProvider.id, model: routeProvider.model || null, reasons: route.reason },
      quote: quote.quote,
      reserve: reserveRes,
      level: reserveRes.level,
    },
  };
}

module.exports = { generateInit };
