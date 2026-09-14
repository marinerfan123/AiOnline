'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { decide, ACTION_MIN_ROLE } = require('./policyDecider.cjs');

test('cross-workspace denied by default', () => {
  const r = decide({ actor: { role: 'Editor' }, actorWorkspace: 'w1', workspace: 'w2', action: 'read', object: { id: 'p1' } });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'CROSS_WORKSPACE_DENIED');
});

test('same-workspace read allowed for Viewer', () => {
  const r = decide({ actor: { role: 'Viewer' }, actorWorkspace: 'w1', workspace: 'w1', action: 'read', object: { id: 'p1' } });
  assert.equal(r.allow, true);
});

test('Editor can update, cannot delete', () => {
  const u = { actor: { role: 'Editor' }, actorWorkspace: 'w1', workspace: 'w1', object: { id: 'p1' } };
  assert.equal(decide({ ...u, action: 'update' }).allow, true);
  assert.equal(decide({ ...u, action: 'delete' }).allow, false);
});

test('Billing Admin can manage_billing, Owner can owner', () => {
  const ba = { actor: { role: 'Billing Admin' }, actorWorkspace: 'w1', workspace: 'w1', object: { id: 'p1' } };
  assert.equal(decide({ ...ba, action: 'manage_billing' }).allow, true);
  const o = { actor: { role: 'Owner' }, actorWorkspace: 'w1', workspace: 'w1', object: { id: 'p1' } };
  assert.equal(decide({ ...o, action: 'owner' }).allow, true);
});

test('unknown action default-deny + explicit reason', () => {
  const r = decide({ actor: { role: 'Owner' }, actorWorkspace: 'w1', workspace: 'w1', action: 'fly', object: { id: 'p1' } });
  assert.equal(r.allow, false);
  assert.match(r.reason, /UNKNOWN_ACTION/);
});

test('actions map to roles', () => {
  assert.equal(ACTION_MIN_ROLE.read, 'Viewer');
  assert.equal(ACTION_MIN_ROLE.delete, 'Admin');
  assert.equal(ACTION_MIN_ROLE.owner, 'Owner');
});
