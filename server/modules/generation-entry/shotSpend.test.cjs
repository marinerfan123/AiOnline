'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { reserve, finalize } = require('./shotSpend.cjs');

const QUOTE = { estimatedCost: 2.5, currency: 'CNY' };
const BUDGET = { budget: 100, spent: 0 };

test('reserve: shot-bound, amount from quote, status reserved, no over-budget', () => {
  const r = reserve({ shotId: 's1', quote: QUOTE, budget: BUDGET });
  assert.equal(r.ok, true);
  assert.equal(r.shotId, 's1');
  assert.equal(r.amount, 2.5);
  assert.equal(r.status, 'reserved');
});

test('reserve blocked when no budget (fail-closed)', () => {
  const r = reserve({ shotId: 's1', quote: QUOTE, budget: { budget: 0, spent: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BUDGET_BLOCKED');
});

test('reserve warns/needs-approval near budget', () => {
  const r = reserve({ shotId: 's1', quote: QUOTE, budget: { budget: 2.6, spent: 0 } }); // cost 2.5 ~ 96% of 2.6
  assert.ok(['warning', 'needs_approval'].includes(r.level));
});

test('finalize: commit success -> settled; commit fail -> released; release -> released', () => {
  assert.equal(finalize({ reserveId: 'rs1', action: 'commit', outcome: 'success' }).status, 'settled');
  assert.equal(finalize({ reserveId: 'rs1', action: 'commit', outcome: 'failure' }).status, 'released');
  assert.equal(finalize({ reserveId: 'rs1', action: 'release' }).status, 'released');
});

test('finalize rejects bad action / missing reserve', () => {
  assert.equal(finalize({ action: 'delete' }).ok, false);
  assert.equal(finalize({ reserveId: 'rs1' }).ok, false);
});
