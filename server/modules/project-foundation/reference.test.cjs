'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { REFERENCE_TYPES, validateReference } = require('./reference.cjs');

test('REFERENCE_TYPES is the type matrix (10 types)', () => {
  assert.deepEqual(REFERENCE_TYPES, [
    'character', 'environment', 'product', 'object', 'style', 'camera',
    'composition', 'motion', 'brand', 'audio',
  ]);
});

test('valid reference passes', () => {
  const r = validateReference({ project_id: 'p1', type: 'character', name: 'Neo', role: 'hero', source: 'brief', attributes: { eyes: 'green' } });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('invalid type rejected', () => {
  const r = validateReference({ project_id: 'p1', type: 'vibe', name: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('type must be one of')));
});

test('missing project_id / name rejected', () => {
  assert.equal(validateReference({ type: 'character', name: 'x' }).ok, false);
  assert.equal(validateReference({ project_id: 'p1', type: 'character' }).ok, false);
});

test('attributes must be a JSON object (not array/string)', () => {
  assert.equal(validateReference({ project_id: 'p1', type: 'audio', name: 'sound', attributes: [1, 2] }).ok, false);
  assert.equal(validateReference({ project_id: 'p1', type: 'brand', name: 'b' }).ok, true);
});

test('role/source optional but validated when present', () => {
  assert.equal(validateReference({ project_id: 'p1', type: 'style', name: 'neo-noir', role: '' }).ok, false);
  assert.equal(validateReference({ project_id: 'p1', type: 'style', name: 'neo-noir' }).ok, true);
});
