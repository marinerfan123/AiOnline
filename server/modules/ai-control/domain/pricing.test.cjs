'use strict';
/**
 * M02-A — Pricing Boundary tests.
 * Core rule: provider cost is NEVER exposed to non-admin; margin computed;
 * credits == platform price (user-facing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteGeneration, quoteForUser, assertAdminProjection } = require('./pricing.cjs');

test('pricing: quote carries all four layers', () => {
  const q = quoteGeneration({ providerCost: 0.3, platformPrice: 100, currency: 'credits', pricingRuleId: 'mp-1', pricingSource: 'model_pricing' });
  assert.equal(q.estimated_provider_cost, 0.3);
  assert.equal(q.estimated_platform_price, 100);
  assert.equal(q.estimated_credits, 100);
  assert.equal(q.margin, 99.7);
  assert.equal(q.pricing_rule_id, 'mp-1');
  assert.equal(q.pricing_source, 'model_pricing');
});

test('pricing: margin never negative', () => {
  const q = quoteGeneration({ providerCost: 500, platformPrice: 100 });
  assert.equal(q.margin, 0);
});

test('pricing: user projection strips provider cost + margin', () => {
  const q = quoteGeneration({ providerCost: 0.3, platformPrice: 100, currency: 'credits' });
  const user = quoteForUser(q);
  const s = JSON.stringify(user);
  assert.ok(!('estimated_provider_cost' in user), 'no provider cost key');
  assert.ok(!('margin' in user), 'no margin key');
  assert.ok(!s.includes('0.3'), 'cost value absent');
  assert.equal(user.estimated_credits, 100, 'user still sees credits');
});

test('pricing: assertAdminProjection gates by role', () => {
  const q = quoteGeneration({ providerCost: 0.3, platformPrice: 100 });
  const admin = assertAdminProjection({ role: 'admin' }, q);
  assert.equal(admin.estimated_provider_cost, 0.3);
  const user = assertAdminProjection({ role: 'user' }, q);
  assert.ok(!('estimated_provider_cost' in user));
  const anon = assertAdminProjection(null, q);
  assert.ok(!('estimated_provider_cost' in anon));
});

test('pricing: defaults when numbers missing', () => {
  const q = quoteGeneration({});
  assert.equal(q.estimated_provider_cost, 0);
  assert.equal(q.estimated_platform_price, 0);
  assert.equal(q.pricing_source, 'default');
});
