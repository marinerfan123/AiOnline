'use strict';
/**
 * W3-09 — Project/workspace budget model (pure decision logic, no I/O).
 * Budget is workspace-scoped; the existing user balance remains the source of funds — this
 * module decides whether a spend request is allowed/warning/needs-approval against the project
 * budget, and enforces tenant scope.
 */
const { roleAtLeast } = require('../project-foundation/rbacRoles.cjs');

/** Thresholds are fractions (0<w<a<=1). Validate durable config. */
function validateBudget(b) {
  const errors = [];
  if (!b) { errors.push('budget required'); return { ok: false, errors }; }
  if (!b.workspace_id) errors.push('workspace_id required');
  if (!b.project_id) errors.push('project_id required');
  if (!(Number(b.budget) > 0)) errors.push('budget must be > 0');
  const w = b.warning_threshold == null ? 0.8 : Number(b.warning_threshold);
  const a = b.approval_threshold == null ? 1.0 : Number(b.approval_threshold);
  if (!(w > 0 && w < 1)) errors.push('warning_threshold must be in (0,1)');
  if (!(a > 0 && a <= 1)) errors.push('approval_threshold must be in (0,1]');
  if (a < w) errors.push('approval_threshold must be >= warning_threshold');
  return { ok: errors.length === 0, errors };
}

/**
 * Decide if a spend of `requested` against `spent` is allowed/warning/needs-approval.
 * Returns { allow, level: 'ok'|'warning'|'needs_approval'|'blocked', reason? }.
 */
function spendDecision({ spent = 0, budget, warningThreshold = 0.8, approvalThreshold = 1, requested = 0 } = {}) {
  const B = Number(budget) || 0;
  if (B <= 0) return { allow: false, level: 'blocked', reason: 'NO_BUDGET' };
  const s = Number(spent) || 0;
  const r = Number(requested) || 0;
  const projected = s + r;
  const ratio = projected / B;
  if (projected > B) return { allow: true, level: 'needs_approval', reason: 'OVER_BUDGET' };
  if (ratio >= approvalThreshold) return { allow: true, level: 'needs_approval', reason: 'AT_APPROVAL' };
  if (ratio >= warningThreshold) return { allow: true, level: 'warning', reason: 'NEAR_BUDGET' };
  return { allow: true, level: 'ok' };
}

/** Tenant scope check: a non-Owner actor cannot touch another workspace's budget. */
function budgetTenantAllowed({ actorWorkspace, workspace, actorRole }) {
  return actorWorkspace === workspace || roleAtLeast(actorRole, 'Owner');
}

module.exports = { validateBudget, spendDecision, budgetTenantAllowed };
