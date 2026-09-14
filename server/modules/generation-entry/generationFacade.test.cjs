'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { generateInit } = require('./generationFacade.cjs');

const SHOT = { id: 's1', mediaType: 'video', title: 'Opening', storyIntent: { synopsis: 'hero rises' } };
const SPEC = { aspect_ratio: '9:16', resolution: '720x1280', duration: 30, fps: 30, platform: 'douyin' };
const PROVIDERS = [
  { id: 'amper', model: 'genny', capabilities: ['image', 'video', 'reference'], supportsTask: ['image', 'video'], health: 1, cost: 0.5, latency: 400, historicalSuccess: 0.95, acceptedShotRate: 0.9 },
  { id: 'kling', model: 'kv', capabilities: ['video'], supportsTask: ['video'], health: 1, cost: 2, latency: 800, historicalSuccess: 0.8, acceptedShotRate: 0.7 },
];
const BUDGET = { budget: 100, spent: 0 };

test('facade composes IR->compile->route->quote->reserve for a Shot', () => {
  const r = generateInit({ shot: SHOT, deliverySpec: SPEC, providers: PROVIDERS, plan: 'pro', budget: BUDGET });
  assert.equal(r.ok, true);
  assert.equal(r.init.shotId, 's1');
  assert.ok(r.init.compiledPrompt.includes('Subject') || r.init.compiledPrompt.includes('Story'));
  assert.ok(r.init.route.id);
  assert.ok(r.init.quote.reserved === false, 'quote does not reserve');
  assert.equal(r.init.reserve.status, 'reserved', 'reserve tied to shot');
});

test('facade fails-closed when no route', () => {
  const r = generateInit({ shot: SHOT, deliverySpec: SPEC, providers: [], budget: BUDGET });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'FACADE_NO_ROUTE');
});

test('facade fails-closed when budget blocked', () => {
  const r = generateInit({ shot: SHOT, deliverySpec: SPEC, providers: PROVIDERS, budget: { budget: 0, spent: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'FACADE_RESERVE_BLOCKED');
});

test('facade picks cheapest viable provider (route has id + score reasons)', () => {
  const r = generateInit({ shot: SHOT, deliverySpec: SPEC, providers: PROVIDERS, plan: 'pro', budget: BUDGET });
  assert.equal(r.init.route.id, 'amper'); // cheaper + higher success
});
