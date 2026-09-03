'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateEnvironment } = require('./environment.cjs');

test('valid environment passes', () => {
  const r = validateEnvironment({ workspace_id: 'w1', project_id: 'p1', name: 'Office', lighting: { key: 'soft' }, props: { desk: true } });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('scope required (workspace + project)', () => {
  assert.equal(validateEnvironment({ name: 'x' }).ok, false);
  assert.equal(validateEnvironment({ workspace_id: 'w1', name: 'x' }).ok, false);
});

test('name required', () => {
  assert.equal(validateEnvironment({ workspace_id: 'w1', project_id: 'p1', name: '' }).ok, false);
});

test('JSON object fields must be objects (not arrays)', () => {
  const r = validateEnvironment({ workspace_id: 'w1', project_id: 'p1', name: 'x', geometry: [1, 2] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('geometry')));
});

test('generated_views must be an array', () => {
  const r = validateEnvironment({ workspace_id: 'w1', project_id: 'p1', name: 'x', generated_views: 'bad' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('generated_views')));
});

test('master_reference_id optional but must be non-empty string when present', () => {
  assert.equal(validateEnvironment({ workspace_id: 'w1', project_id: 'p1', name: 'x', master_reference_id: 'r1' }).ok, true);
  assert.equal(validateEnvironment({ workspace_id: 'w1', project_id: 'p1', name: 'x', master_reference_id: '' }).ok, false);
});
