'use strict';
/**
 * M02-A — Provider Binding Domain tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBinding, toBinding } = require('./binding.cjs');

test('binding: validation requires logical_model_id + provider_id', () => {
  assert.equal(validateBinding({}).ok, false);
  assert.equal(validateBinding({ logical_model_id: 'kling-x' }).ok, false);
  assert.equal(validateBinding({ logical_model_id: 'kling-x', provider_id: 'agnes' }).ok, true);
});

test('binding: field types enforced', () => {
  assert.equal(validateBinding({ logical_model_id: 'm', provider_id: 'p', priority: 1.5 }).ok, false);
  assert.equal(validateBinding({ logical_model_id: 'm', provider_id: 'p', weight: 'x' }).ok, false);
  assert.equal(validateBinding({ logical_model_id: 'm', provider_id: 'p', priority: 3, weight: 50, enabled: true }).ok, true);
});

test('binding: toBinding projects a provider_model_bindings row', () => {
  const row = { id: 'pmb-1', model_id: 'kling-x', provider_id: 'agnes', upstream_model_name: 'agnes-kling-x', enabled: true, priority: 5, weight: 80 };
  const model = { endpoint: { generate: { path: '/videos' } }, param_template: { fps: 24 } };
  const provider = { base_url: 'https://api.agnes-ai.cn/v1', enabled: true };
  const b = toBinding(row, model, provider);
  assert.equal(b.id, 'pmb-1');
  assert.equal(b.logical_model_id, 'kling-x');
  assert.equal(b.provider_id, 'agnes');
  assert.equal(b.provider_model_code, 'agnes-kling-x');
  assert.equal(b.enabled, true);
  assert.equal(b.priority, 5);
  assert.equal(b.weight, 80);
  assert.equal(b.legacy_fallback, false);
  assert.deepEqual(b.parameter_overrides, { fps: 24 });
  assert.equal(b.base_url, 'https://api.agnes-ai.cn/v1');
});

test('binding: empty upstream_model_name falls back to model_id (legacy wire name)', () => {
  const b = toBinding({ id: 'x', model_id: 'm', provider_id: 'p', upstream_model_name: '', enabled: true });
  assert.equal(b.provider_model_code, 'm');
});

test('binding: legacy fallback flagged when no binding row id', () => {
  const b = toBinding({ model_id: 'm', provider_id: 'p', enabled: true }, {}, {});
  assert.equal(b.legacy_fallback, true);
});

test('binding: disabled provider reflected in provider_enabled', () => {
  const b = toBinding({ id: 'x', model_id: 'm', provider_id: 'p', enabled: true }, {}, { enabled: false });
  assert.equal(b.provider_enabled, false);
});
