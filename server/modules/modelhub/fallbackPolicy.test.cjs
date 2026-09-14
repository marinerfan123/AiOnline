'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pickFallback } = require('./fallbackPolicy.cjs');

test('fallback picks next viable candidate, skipping failed + non-viable', () => {
  const cands = [{ id: 'a', score: -Infinity }, { id: 'b', score: 3 }, { id: 'c', score: 1 }];
  const r = pickFallback({ candidates: cands, failedId: 'b' });
  assert.equal(r.ok, true);
  assert.equal(r.fallback.id, 'c');
});

test('fallback: legacy adapter deterministic', () => {
  const r = pickFallback({ candidates: [], failedId: 'a', legacy: { fallbackModel: 'legacy-v1' } });
  assert.equal(r.ok, true);
  assert.equal(r.fallback.legacy, true);
  assert.equal(r.fallback.model, 'legacy-v1');
});

test('fallback: no viable -> NO_FALLBACK', () => {
  const r = pickFallback({ candidates: [{ id: 'a', score: -Infinity }], failedId: 'a', classification: { reason: 'health_low' } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_FALLBACK');
});
