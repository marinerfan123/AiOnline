'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FLAG_NAMES,
  FLAG_DEFAULTS,
  resolveFlag,
  isFlagEnabled,
  listFlags,
  setFlagSettingsSource,
  parseBool,
} = require('./flags.cjs');

const EXPECTED_8 = [
  'VIDEO_OPERATION_REGISTRY',
  'VIDEO_SCHEMA_RUNTIME',
  'VIDEO_NEW_DRIVER_RUNTIME',
  'VIDEO_DURABLE_EVENTS',
  'VIDEO_NEW_ROUTER',
  'VIDEO_SCHEMA_UI',
  'VIDEO_CANVAS_RUNTIME',
  'VIDEO_WORKFLOW_RUNTIME',
];

/** Temporarily set env vars, restore on the way out (no cross-test pollution). */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    Object.assign(process.env, vars);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('L7: the 8 §138 VIDEO_* flags are registered, default OFF (Phase 1)', () => {
  assert.deepEqual(FLAG_NAMES, EXPECTED_8);
  for (const name of EXPECTED_8) {
    assert.equal(FLAG_DEFAULTS[name], false, `${name} should default false`);
  }

  // Pure defaults (no env, no settings).
  for (const name of EXPECTED_8) {
    assert.equal(resolveFlag(name, { env: {}, settings: null }), false, `${name} pure default false`);
  }

  // listFlags()/isFlagEnabled() read real env — assume clean (no FF_* set).
  const list = listFlags();
  assert.deepEqual(Object.keys(list).sort(), [...EXPECTED_8].sort());
  for (const name of EXPECTED_8) {
    assert.equal(list[name], false, `${name} listed false`);
    assert.equal(isFlagEnabled(name), false, `${name} disabled`);
  }
});

test('L7: env override wins (FF_<NAME>=1)', () => {
  assert.equal(process.env.FF_VIDEO_SCHEMA_RUNTIME, undefined, 'precondition: clean env');
  withEnv({ FF_VIDEO_SCHEMA_RUNTIME: '1' }, () => {
    assert.equal(isFlagEnabled('VIDEO_SCHEMA_RUNTIME'), true);
    assert.equal(listFlags()['VIDEO_SCHEMA_RUNTIME'], true);
    // other flags remain off under the same env
    assert.equal(isFlagEnabled('VIDEO_OPERATION_REGISTRY'), false);
  });
  assert.equal(process.env.FF_VIDEO_SCHEMA_RUNTIME, undefined, 'env restored');
  assert.equal(isFlagEnabled('VIDEO_SCHEMA_RUNTIME'), false, 'back to default off');
});

test('L7: settings override applies when env absent; env still beats settings', () => {
  // no env → settings beats default off
  assert.equal(resolveFlag('VIDEO_NEW_ROUTER', { env: {}, settings: { VIDEO_NEW_ROUTER: true } }), true);
  assert.equal(resolveFlag('VIDEO_NEW_ROUTER', { env: {}, settings: { VIDEO_NEW_ROUTER: false } }), false);

  // env (explicit) beats settings, in both directions
  assert.equal(
    resolveFlag('VIDEO_NEW_ROUTER', { env: { FF_VIDEO_NEW_ROUTER: '0' }, settings: { VIDEO_NEW_ROUTER: true } }),
    false,
    'env=0 forces off despite settings=true',
  );
  assert.equal(
    resolveFlag('VIDEO_NEW_ROUTER', { env: { FF_VIDEO_NEW_ROUTER: '1' }, settings: { VIDEO_NEW_ROUTER: false } }),
    true,
    'env=1 forces on despite settings=false',
  );
});

test('L7: settings source wiring drives isFlagEnabled/listFlags (DB hook, later phase)', () => {
  setFlagSettingsSource(() => ({ VIDEO_DURABLE_EVENTS: true, VIDEO_WORKFLOW_RUNTIME: 'on' }));
  try {
    assert.equal(isFlagEnabled('VIDEO_DURABLE_EVENTS'), true);
    assert.equal(isFlagEnabled('VIDEO_WORKFLOW_RUNTIME'), true);
    assert.equal(isFlagEnabled('VIDEO_OPERATION_REGISTRY'), false, 'absent from settings → default off');
    const list = listFlags();
    assert.equal(list['VIDEO_DURABLE_EVENTS'], true);
    assert.equal(list['VIDEO_WORKFLOW_RUNTIME'], true);
  } finally {
    setFlagSettingsSource(null);
  }
  assert.equal(isFlagEnabled('VIDEO_DURABLE_EVENTS'), false, 'source detached → default off');
});

test('L7: unknown flag is rejected (throws, never silently OFF)', () => {
  assert.throws(() => isFlagEnabled('UNKNOWN_FLAG'), /Unknown feature flag/);
  assert.throws(() => resolveFlag('VIDEO_', { env: {} }), /Unknown feature flag/);
  assert.throws(() => resolveFlag('', { env: {} }), /Unknown feature flag/);
  assert.throws(() => resolveFlag(undefined), /Unknown feature flag/);
});

test('L7: parseBool literal grammar', () => {
  assert.equal(parseBool(true), true);
  assert.equal(parseBool(false), false);
  assert.equal(parseBool(1), true);
  assert.equal(parseBool(0), false);
  assert.equal(parseBool('1'), true);
  assert.equal(parseBool('TRUE'), true);
  assert.equal(parseBool('on'), true);
  assert.equal(parseBool('0'), false);
  assert.equal(parseBool('Off'), false);
  assert.equal(parseBool('garbage'), null);
  assert.equal(parseBool(null), null);
  assert.equal(parseBool(undefined), null);
});
