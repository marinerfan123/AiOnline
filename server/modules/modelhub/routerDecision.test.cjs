'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { routeDecision, scoreProvider, planRank } = require('./routerDecision.cjs');

const P = (id, over = {}) => ({
  id, capabilities: ['reference', 'continuity'], supportsTask: ['image', 'video'],
  health: 1, cost: 1, latency: 500, historicalSuccess: 0.9, acceptedShotRate: 0.8,
  ...over,
});

test('deterministic routing picks best provider by score (ties by id)', () => {
  const r = routeDecision({ task: { type: 'video' }, providers: [P('a'), P('b', { cost: 0.5 })], duration: 30, resolution: '1080p' });
  assert.equal(r.ok, true);
  assert.equal(r.chosen, 'b'); // lower cost → higher score
  const again = routeDecision({ task: { type: 'video' }, providers: [P('a'), P('b', { cost: 0.5 })], duration: 30, resolution: '1080p' });
  assert.equal(again.chosen, r.chosen, 'deterministic');
});

test('capability fallback: provider missing required capability excluded', () => {
  const a = P('a', { capabilities: ['reference'] });
  const b = P('b', { capabilities: ['reference', 'continuity'] });
  const r = routeDecision({ task: { type: 'video' }, providers: [a, b], requiredCapabilities: ['continuity'] });
  assert.equal(r.chosen, 'b');
});

test('health gate: dead provider disqualified', () => {
  const r = routeDecision({ task: { type: 'image' }, providers: [P('dead', { health: 0.2 }), P('ok')] });
  assert.equal(r.chosen, 'ok');
});

test('plan gate: plan insufficient excludes', () => {
  const r = routeDecision({ task: { type: 'image' }, providers: [P('pro', { minPlan: 'enterprise' }), P('free')], plan: 'free' });
  assert.equal(r.chosen, 'free');
});

test('no viable provider -> reason NO_VIABLE_PROVIDER', () => {
  const r = routeDecision({ task: { type: 'video' }, providers: [P('a', { supportsTask: ['image'] })] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /NO_VIABLE|NO_PROVIDERS/);
});

test('planRank ordering', () => {
  assert.equal(planRank('enterprise', 'enterprise'), true);
  assert.equal(planRank('enterprise', 'free'), false);
  assert.equal(planRank('pro', 'enterprise'), true);
});
