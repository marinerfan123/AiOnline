'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateBudget, spendDecision, budgetTenantAllowed } = require('./budget.cjs');

test('validateBudget: durable thresholds validated (0<w<a<=1)', () => {
  assert.equal(validateBudget({ workspace_id: 'w1', project_id: 'p1', budget: 100 }).ok, true);
  assert.equal(validateBudget({ workspace_id: 'w1', project_id: 'p1', budget: 100, warning_threshold: 0.9, approval_threshold: 0.8 }).ok, false);
  assert.equal(validateBudget({ workspace_id: 'w1', project_id: 'p1', budget: 0 }).ok, false);
  assert.equal(validateBudget({ workspace_id: 'w1', project_id: 'p1', budget: 100, warning_threshold: 0 }).ok, false);
});

test('spendDecision: levels ok -> warning -> needs_approval -> over-budget', () => {
  assert.equal(spendDecision({ spent: 10, budget: 100, requested: 50 }).level, 'ok');          // 60/100=0.6
  assert.equal(spendDecision({ spent: 60, budget: 100, requested: 30 }).level, 'warning');     // 90/100=0.9 >= 0.8
  assert.equal(spendDecision({ spent: 90, budget: 100, requested: 15 }).level, 'needs_approval'); // 105>100
  assert.equal(spendDecision({ budget: 0, requested: 1 }).level, 'blocked');
});

test('spendDecision: empty budget blocked (fail-closed)', () => {
  const r = spendDecision({ spent: 0, budget: 0, requested: 1 });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'NO_BUDGET');
});

test('budgetTenantAllowed: non-Owner denied cross-workspace', () => {
  assert.equal(budgetTenantAllowed({ actorWorkspace: 'w1', workspace: 'w2', actorRole: 'Editor' }), false);
  assert.equal(budgetTenantAllowed({ actorWorkspace: 'w1', workspace: 'w1', actorRole: 'Viewer' }), true);
  assert.equal(budgetTenantAllowed({ actorWorkspace: 'w1', workspace: 'w2', actorRole: 'Owner' }), true);
});

test('spendDecision deterministic (concurrent-safe pure function)', () => {
  const a = spendDecision({ spent: 90, budget: 100, requested: 15 });
  const b = spendDecision({ spent: 90, budget: 100, requested: 15 });
  assert.deepEqual(a, b);
});
