'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildQuote, costFor, QUOTE_VERSION } = require('./quoteService.cjs');

const ROUTE = { id: 'r1', provider: 'amper', model: 'm1', unitCost: 0.5, perSecondCost: 0.01 };

test('quote is deterministic (same shot+route+spec+plan -> same hash)', () => {
  const a = buildQuote({ shotId: 's1', route: ROUTE, deliverySpec: { duration: 30, variants: [] } });
  const b = buildQuote({ shotId: 's1', route: ROUTE, deliverySpec: { duration: 30, variants: [] } });
  assert.equal(a.quote.deterministicHash, b.quote.deterministicHash);
  assert.equal(a.quote.version, QUOTE_VERSION);
});

test('quote carries shotId, selected route, deliverySpec, expiry + NO reserve', () => {
  const r = buildQuote({ shotId: 's1', route: ROUTE, deliverySpec: { duration: 30, variants: [] }, currency: 'CNY' });
  assert.equal(r.ok, true);
  assert.equal(r.quote.shotId, 's1');
  assert.equal(r.quote.selectedRoute.id, 'r1');
  assert.equal(r.quote.reserved, false, 'NO RESERVE during quote');
  assert.ok(r.quote.expiresAt && new Date(r.quote.expiresAt) > new Date());
  assert.ok(typeof r.quote.estimatedCost === 'number' && r.quote.estimatedCost > 0);
});

test('route change alters the quote (cost + hash)', () => {
  const a = buildQuote({ shotId: 's1', route: ROUTE, deliverySpec: { duration: 30 } });
  const b = buildQuote({ shotId: 's1', route: { id: 'r2', provider: 'kling', unitCost: 2.0, perSecondCost: 0.02 }, deliverySpec: { duration: 30 } });
  assert.notEqual(a.quote.estimatedCost, b.quote.estimatedCost);
  assert.notEqual(a.quote.deterministicHash, b.quote.deterministicHash);
  assert.ok(b.quote.estimatedCost > a.quote.estimatedCost);
});

test('browser disclosure: quote exposes expected cost, not a reserve', () => {
  const q = buildQuote({ shotId: 's1', route: ROUTE, deliverySpec: { duration: 30 } }).quote;
  assert.equal(q.reserved, false);
  assert.ok(q.estimatedCost > 0);
});

test('missing shot/route rejected', () => {
  assert.equal(buildQuote({ route: ROUTE }).ok, false);
  assert.equal(buildQuote({ shotId: 's1' }).ok, false);
});

test('costFor scales with duration + variants', () => {
  assert.ok(costFor(ROUTE, { duration: 60 }) > costFor(ROUTE, { duration: 30 }));
  assert.ok(costFor(ROUTE, { duration: 30, variants: 2 }) > costFor(ROUTE, { duration: 30, variants: 0 }));
});
