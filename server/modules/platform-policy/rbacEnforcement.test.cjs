'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { enforceAccess, ACTION_MIN_ROLE } = require('./rbacEnforcement.cjs');

const mk = (role, actorWorkspace = 'w1', workspace = 'w1') => ({ actor: { role }, actorWorkspace, workspace, project: 'p1', object: { id: 'o1' } });

test('role matrix blocks unauthorized spend/export/approve/delete', () => {
  // Editor cannot spend/export/approve/delete
  for (const a of ['spend', 'export', 'approve', 'delete']) {
    const r = enforceAccess({ ...mk('Editor'), action: a });
    assert.equal(r.allow, false, `${a} blocked for Editor`);
  }
  // Admin can
  for (const a of ['spend', 'export', 'approve', 'delete']) {
    const r = enforceAccess({ ...mk('Admin'), action: a });
    assert.equal(r.allow, true, `${a} allowed for Admin`);
  }
});

test('Reviewer may review but NOT mutate production', () => {
  assert.equal(enforceAccess({ ...mk('Reviewer'), action: 'review' }).allow, true);
  for (const a of ['update', 'spend', 'delete', 'approve', 'export']) {
    assert.equal(enforceAccess({ ...mk('Reviewer'), action: a }).allow, false, `${a} blocked for Reviewer`);
  }
});

test('cross-tenant denial (workspace mismatch)', () => {
  const r = enforceAccess({ ...mk('Admin', 'w1', 'w2'), action: 'delete' });
  assert.equal(r.allow, false);
  assert.match(r.reason, /CROSS_WORKSPACE_DENIED/);
});

test('unknown action default-deny (fail-closed)', () => {
  const r = enforceAccess({ ...mk('Owner'), action: 'teleport' });
  assert.equal(r.allow, false);
  assert.match(r.reason, /UNKNOWN_ACTION/);
});

test('role matrix list is explicit (release-critical actions enumerated)', () => {
  assert.equal(ACTION_MIN_ROLE.spend, 'Admin');
  assert.equal(ACTION_MIN_ROLE.export, 'Admin');
  assert.equal(ACTION_MIN_ROLE.approve, 'Admin');
  assert.equal(ACTION_MIN_ROLE.delete, 'Admin');
  assert.equal(ACTION_MIN_ROLE.review, 'Reviewer');
  assert.equal(ACTION_MIN_ROLE.read, 'Viewer');
});
