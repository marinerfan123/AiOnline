'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shadowPercent, shouldShadowTask } = require('./canary.cjs');

test('影子比例默认0，限制0-100', () => {
  assert.equal(shadowPercent({}), 0);
  assert.equal(shadowPercent({ GENERATION_V2_SHADOW_PERCENT: '-1' }), 0);
  assert.equal(shadowPercent({ GENERATION_V2_SHADOW_PERCENT: '5' }), 5);
  assert.equal(shadowPercent({ GENERATION_V2_SHADOW_PERCENT: '999' }), 100);
});

test('同一taskId采样结果稳定', () => {
  const env = { GENERATION_V2_SHADOW_PERCENT: '10' };
  const first = shouldShadowTask('gt-stable', env);
  for (let i = 0; i < 20; i++) assert.equal(shouldShadowTask('gt-stable', env), first);
});

test('0%全关，100%全开', () => {
  for (const id of ['a','b','c','gt-123']) {
    assert.equal(shouldShadowTask(id, { GENERATION_V2_SHADOW_PERCENT: '0' }), false);
    assert.equal(shouldShadowTask(id, { GENERATION_V2_SHADOW_PERCENT: '100' }), true);
  }
});

test('5%采样在大量ID上接近5%', () => {
  let hit = 0;
  for (let i = 0; i < 10000; i++) if (shouldShadowTask(`gt-${i}`, { GENERATION_V2_SHADOW_PERCENT: '5' })) hit++;
  assert.ok(hit >= 400 && hit <= 600, `命中数${hit}不接近5%`);
});
