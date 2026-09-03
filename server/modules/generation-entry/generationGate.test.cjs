'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateEligibility, BRIEF_REQUIRED, SPEC_REQUIRED } = require('./generationGate.cjs');

const COMPLETE = {
  brief: { goal: 'Make a teaser', audience: 'Gen-Z', platform: 'douyin' },
  deliverySpec: { aspect_ratio: '9:16', duration: 30, platform: 'douyin' },
};

test('complete brief+spec is eligible', () => {
  const r = evaluateEligibility(COMPLETE);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.missing, []);
});

test('missing brief.goal reported machine-readable', () => {
  const r = evaluateEligibility({ brief: { audience: 'x' }, deliverySpec: COMPLETE.deliverySpec });
  assert.equal(r.eligible, false);
  assert.ok(r.missing.includes('brief.goal'));
});

test('missing delivery_spec.duration reported', () => {
  const r = evaluateEligibility({ brief: COMPLETE.brief, deliverySpec: { aspect_ratio: '9:16', platform: 'douyin' } });
  assert.equal(r.eligible, false);
  assert.ok(r.missing.includes('delivery_spec.duration'));
});

test('no brief => missing brief + brief.goal + brief.audience', () => {
  const r = evaluateEligibility({ deliverySpec: COMPLETE.deliverySpec });
  assert.equal(r.eligible, false);
  assert.ok(r.missing.includes('brief'));
  assert.ok(r.missing.includes('brief.goal'));
});

test('gate never grants on invalid field values', () => {
  const r = evaluateEligibility({ brief: { goal: 'x', audience: 'y' }, deliverySpec: { aspect_ratio: 'bad', duration: 30, platform: 'douyin' } });
  assert.equal(r.eligible, false);
});

test('required field lists are explicit (no-spend contract)', () => {
  assert.ok(BRIEF_REQUIRED.includes('goal'));
  assert.ok(BRIEF_REQUIRED.includes('audience'));
  assert.ok(SPEC_REQUIRED.includes('aspect_ratio'));
  assert.ok(SPEC_REQUIRED.includes('duration'));
  assert.ok(SPEC_REQUIRED.includes('platform'));
});
