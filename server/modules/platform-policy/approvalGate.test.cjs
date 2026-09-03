'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateGateSchema, evaluateGate, enforceApproval } = require('./approvalGate.cjs');

const GATE = { type: 'export', requiredApprovals: 1, minAmount: 100, qc: { creative: true } };

test('validateGateSchema: type/requiredApprovals/minAmount validated', () => {
  assert.equal(validateGateSchema(GATE).ok, true);
  assert.equal(validateGateSchema({ type: 'warp' }).ok, false);
  assert.equal(validateGateSchema({ type: 'export', requiredApprovals: 0 }).ok, false);
  assert.equal(validateGateSchema({ type: 'export', minAmount: -5 }).ok, false);
});

test('evaluateGate: denies without enough Admin approvals, approves with', () => {
  assert.equal(evaluateGate({ gate: GATE, approvals: [] }).ok, false);
  const ok = evaluateGate({ gate: GATE, approvals: [{ approverRole: 'Admin', approverId: 'u1', approved: true }] });
  assert.equal(ok.ok, true);
});

test('amount gate: high amount needs commercial approval', () => {
  const noComm = evaluateGate({ gate: GATE, approvals: [{ approverRole: 'Admin', approved: true, kind: 'review' }], amount: 200 });
  assert.equal(noComm.ok, false);
  const withComm = evaluateGate({ gate: GATE, approvals: [{ approverRole: 'Admin', approved: true, kind: 'commercial' }], amount: 200 });
  assert.equal(withComm.ok, true);
});

test('enforceApproval: role-matrix access + gate both required (W5-10 + W2-10)', () => {
  // Viewer cannot export (role-matrix denies) even with approvals
  const denied = enforceApproval({ action: 'export', gate: GATE, approvals: [{ approverRole: 'Admin', approved: true, kind: 'commercial' }], amount: 50, actor: { role: 'Viewer' }, actorWorkspace: 'w1', workspace: 'w1' });
  assert.equal(denied.allow, false);
  // Admin + approval -> allow
  const ok = enforceApproval({ action: 'export', gate: GATE, approvals: [{ approverRole: 'Admin', approved: true, kind: 'commercial' }], amount: 50, actor: { role: 'Admin' }, actorWorkspace: 'w1', workspace: 'w1' });
  assert.equal(ok.allow, true);
  // Admin but no approval -> deny
  const noAppr = enforceApproval({ action: 'export', gate: GATE, approvals: [], amount: 50, actor: { role: 'Admin' }, actorWorkspace: 'w1', workspace: 'w1' });
  assert.equal(noAppr.allow, false);
});
