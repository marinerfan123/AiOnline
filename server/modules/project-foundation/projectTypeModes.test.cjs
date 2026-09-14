'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { PROJECT_MODES, MODE_SET, LEGACY_TO_MODE, LEGACY_TYPES, ALLOWED_PROJECT_TYPES, resolveProjectMode } = require('./projectTypeModes.cjs');

test('modern modes defined', () => {
  assert.deepEqual(MODE_SET, ['narrative', 'advertising', 'ecommerce', 'other']);
  assert.equal(PROJECT_MODES.length, 4);
});

test('legacy values map deterministically', () => {
  assert.equal(resolveProjectMode('short_drama'), 'narrative');
  assert.equal(resolveProjectMode('studio'), 'narrative');
  assert.equal(resolveProjectMode('general'), 'other');
  assert.equal(resolveProjectMode('short_drama'), 'narrative');
});

test('modern modes resolve to themselves', () => {
  assert.equal(resolveProjectMode('narrative'), 'narrative');
  assert.equal(resolveProjectMode('ecommerce'), 'ecommerce');
});

test('unknown/empty defaults to other', () => {
  assert.equal(resolveProjectMode(''), 'other');
  assert.equal(resolveProjectMode('nonsense'), 'other');
  assert.equal(resolveProjectMode(undefined), 'other');
});

test('allowed set contains modern + legacy (extensible)', () => {
  for (const m of MODE_SET) assert.ok(ALLOWED_PROJECT_TYPES.includes(m), `missing mode ${m}`);
  for (const l of LEGACY_TYPES) assert.ok(ALLOWED_PROJECT_TYPES.includes(l), `missing legacy ${l}`);
  assert.equal(resolveProjectMode('short_drama'), 'narrative'); // legacy reopen maps to narrative
});
