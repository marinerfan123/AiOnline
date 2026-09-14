'use strict';
/**
 * W2-10 — RBAC enforcement on release-critical API actions (spend/export/approve/delete).
 * Uses the W1-15 role hierarchy (roleAtLeast) + W1-16 cross-workspace default-deny: unauthorized
 * actions are blocked, and a Reviewer may NOT mutate production except review actions.
 */
const { roleAtLeast } = require('../project-foundation/rbacRoles.cjs');

// action -> minimum role that may perform it. Anything not listed is default-deny (fail-closed).
const ACTION_MIN_ROLE = {
  read: 'Viewer',
  review: 'Reviewer',      // review is the only mutation a Reviewer may perform
  update: 'Editor',
  manage_billing: 'Billing Admin',
  spend: 'Admin',          // generation spend is admin-grade
  export: 'Admin',
  approve: 'Admin',
  delete: 'Admin',
  owner: 'Owner',
};

/**
 * Decide whether an actor may perform `action` on an object in `workspace`.
 * {actor:{role}, actorWorkspace, workspace, action}. Fail-closed on unknown action.
 */
function enforceAccess({ actor, actorWorkspace, workspace, action }) {
  const role = actor ? actor.role : null;
  // Cross-workspace: only Owner may act across workspace boundary.
  if (workspace && actorWorkspace && workspace !== actorWorkspace) {
    if (role !== 'Owner') return { allow: false, reason: 'CROSS_WORKSPACE_DENIED' };
  }
  const min = ACTION_MIN_ROLE[action];
  if (!min) return { allow: false, reason: 'UNKNOWN_ACTION' };
  if (!roleAtLeast(role, min)) return { allow: false, reason: 'ROLE_INSUFFICIENT' };
  return { allow: true };
}

module.exports = { enforceAccess, ACTION_MIN_ROLE };
