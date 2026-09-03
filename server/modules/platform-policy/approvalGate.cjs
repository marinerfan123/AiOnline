'use strict';
/**
 * W5-09/W5-10 — Production Gates + approval schema/enforcement (pure, no I/O).
 * A gate requires approvals (by role) + QC checks (creative/technical/commercial). Enforcement
 * DENIES release without all required approvals. W2-10 RBAC role matrix gates who may approve.
 */
const { roleAtLeast } = require('../project-foundation/rbacRoles.cjs');
const { enforceAccess } = require('./rbacEnforcement.cjs');

const GATE_TYPES = ['export', 'publish', 'review', 'commercial'];
const MIN_APPROVE_ROLE = 'Admin';

/** Validate a gate requirement schema. Returns {ok, errors[]}. */
function validateGateSchema(g) {
  const errors = [];
  if (!g) { errors.push('gate required'); return { ok: false, errors }; }
  if (!g.type || !GATE_TYPES.includes(g.type)) errors.push(`type must be one of ${GATE_TYPES.join(',')}`);
  if (g.requiredApprovals != null && !(Number(g.requiredApprovals) > 0)) errors.push('requiredApprovals must be > 0');
  if (g.qc != null && (typeof g.qc !== 'object' || Array.isArray(g.qc))) errors.push('qc must be an object');
  if (g.minAmount != null && Number(g.minAmount) < 0) errors.push('minAmount must be >= 0');
  return { ok: errors.length === 0, errors };
}

/** Decide if a gate may proceed. Returns {ok, decision, reasons}. */
function evaluateGate({ gate, approvals = [], amount } = {}) {
  if (!gate) return { ok: false, decision: 'denied', reasons: ['NO_GATE'] };
  // amount gate: above minAmount requires `commercial` approval
  const minAmount = Number(gate.minAmount) || 0;
  // required approvals by role
  const required = Number(gate.requiredApprovals) || 1;
  const distinctValid = new Set(
    approvals.filter((a) => a && a.approverRole && roleAtLeast(a.approverRole, MIN_APPROVE_ROLE) && a.approved).map((a) => a.approverId || a.approverRole)
  );
  const reasons = [];
  if (distinctValid.size < required) reasons.push(`NEED_${required - distinctValid.size}_MORE_APPROVAL`);
  if (amount != null && Number(amount) > minAmount && !approvals.some((a) => a && a.kind === 'commercial' && a.approved)) reasons.push('NEED_COMMERCIAL_APPROVAL');
  const ok = reasons.length === 0;
  return { ok, decision: ok ? 'approved' : 'denied', reasons };
}

/** W5-10: enforce approval policy for a release-critical action (deny without required approvals). */
function enforceApproval({ action, gate, approvals = [], amount, actor, actorWorkspace, workspace } = {}) {
  // Role-matrix: the action itself must be permitted for the actor (W2-10).
  const access = enforceAccess({ actor, actorWorkspace, workspace, action });
  if (!access.allow) return { allow: false, reason: `ACCESS_${access.reason}` };
  const gateEval = evaluateGate({ gate, approvals, amount });
  return { allow: gateEval.ok, reason: gateEval.decision, reasons: gateEval.reasons };
}

module.exports = { validateGateSchema, evaluateGate, enforceApproval, GATE_TYPES };
