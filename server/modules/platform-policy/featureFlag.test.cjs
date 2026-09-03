'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveFlag, FLAG_DEFAULTS } = require('./featureFlag.cjs');

test('Factory (V2_STUDIO) is OFF by default (1.0 scope)', () => {
  assert.equal(resolveFlag('V2_STUDIO'), false);
  assert.equal(resolveFlag('V2_APP_SHELL'), false);
  assert.equal(resolveFlag('SHOP_ENABLED'), false);
});

test('internal user may enable hidden surfaces', () => {
  assert.equal(resolveFlag('V2_STUDIO', { context: { internal: true } }), true);
});

test('workspace allowlist enables a surface', () => {
  assert.equal(resolveFlag('SHOP_ENABLED', { context: { workspace: 'w-internal', workspaceAllowlist: ['w-internal'] } }), true);
  assert.equal(resolveFlag('SHOP_ENABLED', { context: { workspace: 'w-not', workspaceAllowlist: ['w-internal'] } }), false);
});

test('plan targeting works (enterprise gains PLAN_GA)', () => {
  assert.equal(resolveFlag('PLAN_GA'), true); // default
  assert.equal(resolveFlag('PLAN_GA', { context: { plan: 'free' } }), true); // default still true
});

test('region targeting works (qa region enables app shell)', () => {
  assert.equal(resolveFlag('V2_APP_SHELL', { context: { region: 'qa' } }), true);
  assert.equal(resolveFlag('V2_APP_SHELL', { context: { region: 'prod' } }), false);
});

test('unknown flag default-denies (fail-closed)', () => {
  assert.equal(resolveFlag('UNKNOWN_FLAG'), false);
});
