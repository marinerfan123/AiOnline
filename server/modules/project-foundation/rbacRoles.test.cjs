'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { ACCESS_ROLES, resolveAccessRole, roleAtLeast, isAccessRole } = require('./rbacRoles.cjs');

test('workspace owner resolves to Owner', () => {
  assert.equal(resolveAccessRole({ workspaceOwnerId: 'u1', userId: 'u1', membershipRole: 'member' }), 'Owner');
});

test('legacy owner maps to Owner deterministically', () => {
  assert.equal(resolveAccessRole({ workspaceOwnerId: 'w9', userId: 'u2', membershipRole: 'owner' }), 'Owner');
});

test('legacy member maps to Viewer (least privilege)', () => {
  assert.equal(resolveAccessRole({ workspaceOwnerId: 'w9', userId: 'u3', membershipRole: 'member' }), 'Viewer');
});

test('missing/unknown membership defaults to Viewer', () => {
  assert.equal(resolveAccessRole({ workspaceOwnerId: 'w9', userId: 'u4', membershipRole: '' }), 'Viewer');
  assert.equal(resolveAccessRole({ userId: 'u5' }), 'Viewer');
});

test('roleAtLeast respects the hierarchy', () => {
  assert.ok(roleAtLeast('Owner', 'Viewer'));
  assert.ok(roleAtLeast('Admin', 'Editor'));
  assert.ok(roleAtLeast('Editor', 'Viewer'));
  assert.ok(!roleAtLeast('Viewer', 'Editor'));
  assert.ok(!roleAtLeast('Reviewer', 'Admin'));
});

test('all six roles present and valid', () => {
  assert.deepEqual(ACCESS_ROLES, ['Owner', 'Admin', 'Billing Admin', 'Editor', 'Reviewer', 'Viewer']);
  for (const r of ACCESS_ROLES) assert.ok(isAccessRole(r));
  assert.ok(!isAccessRole('god'));
});
