'use strict';
/**
 * W1-16 — Tenant scope + policy decision foundation.
 *
 * Security backbone: every access decision takes explicit { actor, workspace, action, object }
 * inputs and DENIES cross-workspace access by default. Pure module (no I/O) so it is unit
 * testable; the project-foundation routes call decide() instead of ad-hoc role checks.
 */

const { roleAtLeast } = require('../project-foundation/rbacRoles.cjs');

// action -> minimum role (RBAC hierarchy: Owner > Admin > Billing Admin > Editor > Reviewer > Viewer)
const ACTION_MIN_ROLE = Object.freeze({
  read: 'Viewer',
  create: 'Editor',
  update: 'Editor',
  delete: 'Admin',
  manage_billing: 'Billing Admin',
  publish: 'Editor',
  admin: 'Admin',
  owner: 'Owner',
});

function resolveRole(actor) {
  return (actor && actor.role) || 'Viewer';
}

/**
 * Decide access. Explicit inputs. Cross-workspace is DENIED unless the actor's membership
 * workspace matches the target workspace. Default deny.
 * @returns {{allow:boolean, reason:string, role:string}}
 */
function decide({ actor, actorWorkspace, workspace, action, object }) {
  const role = resolveRole(actor);
  // Cross-workspace denial by default: the actor must be acting within their own workspace.
  if (workspace && actorWorkspace && String(workspace) !== String(actorWorkspace) && role !== 'Owner') {
    return { allow: false, reason: 'CROSS_WORKSPACE_DENIED', role };
  }
  // Owner bypasses the role gate (global roll-up) only for their own resources; global admin handled by caller.
  const min = ACTION_MIN_ROLE[action];
  if (!min) return { allow: false, reason: `UNKNOWN_ACTION:${action}`, role };
  if (roleAtLeast(role, min)) return { allow: true, reason: 'ok', role };
  return { allow: false, reason: `ROLE_TOO_LOW:${role} < ${min}`, role };
}

module.exports = { decide, ACTION_MIN_ROLE };
