'use strict';
/**
 * W3-08 — Generation quote service (pure, no I/O). A quote is tied to a Shot + selected route +
 * DeliverySpec + expiration/version. **No reserve happens during quote** — it's an estimate only.
 */
const crypto = require('crypto');

const QUOTE_VERSION = 1;
const QUOTE_TTL_MINUTES = 10;

function costFor(route, { duration, variants = 0 } = {}) {
  const base = (route && route.unitCost != null ? Number(route.unitCost) : 0.5);
  const perSecond = (route && route.perSecondCost != null ? Number(route.perSecondCost) : 0);
  const seconds = Number(duration) || 0;
  const variantBoost = 1 + 0.25 * (Number(variants) || 0);
  const est = (base + perSecond * seconds) * variantBoost;
  return Math.round(est * 10000) / 10000; // 4dp currency
}

/** Build a generation quote. Contract: quote does NOT reserve; returns estimate + expiry/version. */
function buildQuote({ shotId, route, deliverySpec, plan, currency = 'CNY', pricing } = {}) {
  if (!shotId) return { ok: false, error: { code: 'QUOTE_MISSING_SHOT' } };
  if (!route || !route.id) return { ok: false, error: { code: 'QUOTE_MISSING_ROUTE' } };
  const sp = deliverySpec || {};
  const duration = sp.duration != null ? Number(sp.duration) : 0;
  const variants = Array.isArray(sp.variants) ? sp.variants.length : 0;
  const estimatedCost = costFor(route, { duration, variants });
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MINUTES * 60 * 1000).toISOString();
  const payload = {
    quoteId: `q-${crypto.randomUUID()}`,
    version: QUOTE_VERSION,
    shotId,
    selectedRoute: { id: route.id, provider: route.provider || route.id, model: route.model || null },
    deliverySpec: {
      aspectRatio: sp.aspect_ratio || sp.aspectRatio || null,
      duration, variants,
    },
    plan: plan || null,
    currency,
    estimatedCost,
    costBreakdown: { baseCost: costFor(route, { duration: 0, variants: 0 }), variableCost: estimatedCost - costFor(route, { duration: 0, variants: 0 }) },
    expiresAt,
    reserved: false, // NO RESERVE during quote
    deterministicHash: crypto.createHash('sha256').update(JSON.stringify({ shotId, routeId: route.id, deliverySpec, plan })).digest('hex').slice(0, 16),
  };
  return { ok: true, quote: payload };
}

module.exports = { buildQuote, costFor, QUOTE_VERSION, QUOTE_TTL_MINUTES };
