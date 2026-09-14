'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAssetVersion, adaptLegacyMediaToVersion, KINDS, STATUSES } = require('./assetVersion.cjs');

test('valid generated version passes', () => {
  const r = validateAssetVersion({ version_id: 'v2', media_id: 'm1', project_id: 'p1', kind: 'generated', status: 'ready', model: 'm', size_bytes: 1234 });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('media_id required (legacy media.id compatibility)', () => {
  assert.equal(validateAssetVersion({ version_id: 'v2', project_id: 'p1', kind: 'upload', status: 'ready' }).ok, false);
});

test('invalid kind/status rejected', () => {
  assert.equal(validateAssetVersion({ version_id: 'v2', media_id: 'm1', project_id: 'p1', kind: 'warp', status: 'ready' }).ok, false);
  assert.equal(validateAssetVersion({ version_id: 'v2', media_id: 'm1', project_id: 'p1', kind: 'upload', status: 'done' }).ok, false);
});

test('legacy media -> v1 version preserves media.id (assetId === media.id)', () => {
  const v = adaptLegacyMediaToVersion({ id: 'm99', project_id: 'p1', status: 'ready', source: 'generated', file_size: 2048 });
  assert.equal(v.media_id, 'm99');
  assert.equal(v.version_id, 'v1-m99');
  assert.equal(v.kind, 'generated');
  assert.equal(v.status, 'ready');
});

test('KINDS/STATUSES explicit', () => {
  assert.deepEqual(KINDS, ['upload', 'generated', 'derived']);
  assert.deepEqual(STATUSES, ['pending', 'ready', 'failed']);
});
