'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAssetRights, ORIGINS } = require('./assetRights.cjs');

test('valid rights (generated) round-trips', () => {
  const r = validateAssetRights({
    asset_id: 'a1', origin: 'generated', generated_by: 'gen', provider: 'mo',
    model: 'm1', generation_id: 'g1', reference_assets: ['r1', 'r2'], owner: 'u1',
    license: 'commercial', consent: { release: true }, commercial_usage: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('origin must be one of uploaded/generated/imported', () => {
  const r = validateAssetRights({ asset_id: 'a1', origin: 'swiped' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('origin')));
});

test('asset_id required', () => {
  assert.equal(validateAssetRights({ origin: 'uploaded' }).ok, false);
});

test('commercial_usage must be boolean when present', () => {
  assert.equal(validateAssetRights({ asset_id: 'a1', commercial_usage: 'yes' }).ok, false);
  assert.equal(validateAssetRights({ asset_id: 'a1', commercial_usage: true }).ok, true);
});

test('reference_assets must be array / consent must be object', () => {
  assert.equal(validateAssetRights({ asset_id: 'a1', reference_assets: 'x' }).ok, false);
  assert.equal(validateAssetRights({ asset_id: 'a1', consent: [1] }).ok, false);
});

test('string fields validated', () => {
  const r = validateAssetRights({ asset_id: 'a1', provider: 123 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('provider')));
});
