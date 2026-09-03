'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeModelRegistry, validateModelRegistry, projectToUserModel } = require('./modelRegistry.cjs');

test('normalizeModelRegistry: provider/model/capability/cost/latency/region/version/enabled/deprecation normalized', () => {
  const n = normalizeModelRegistry({ id: 'm1', provider: 'amper', model: 'genny', capabilities: ['image'], cost: 0.5, latency: 400, region: 'cn', version: 1, enabled: true, deprecation: null });
  assert.equal(n.id, 'm1');
  assert.equal(n.provider, 'amper');
  assert.equal(n.cost, 0.5);
  assert.equal(n.enabled, true);
  assert.deepEqual(n.capabilities, ['image']);
});

test('validateModelRegistry: requires id/provider/cost', () => {
  assert.equal(validateModelRegistry({ id: 'm1', cost: 0.5 }).ok, false); // no provider
  assert.equal(validateModelRegistry({ provider: 'amper', cost: 0.5 }).ok, false); // no id
  assert.equal(validateModelRegistry({ id: 'm1', provider: 'amper', cost: -1 }).ok, false); // negative cost
});

test('projectToUserModel strips locked/internal fields (no key/margin)', () => {
  const n = normalizeModelRegistry({ id: 'm1', provider: 'amper', cost: 0.5, apiKey: 'SECRET', internalMargin: 0.9, keyPool: 'k1' });
  const userView = projectToUserModel(n);
  assert.equal(userView.apiKey, undefined);
  assert.equal(userView.internalMargin, undefined);
  assert.equal(userView.keyPool, undefined);
  assert.equal(userView.provider, 'amper');
});

test('enabled defaults true; deprecation explicit', () => {
  const n = normalizeModelRegistry({ id: 'm1', provider: 'amper', cost: 1 });
  assert.equal(n.enabled, true);
  const d = normalizeModelRegistry({ id: 'm2', provider: 'amper', cost: 1, enabled: false });
  assert.equal(d.enabled, false);
});
