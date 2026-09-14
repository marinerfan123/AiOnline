'use strict';
/**
 * W1-15 — Workspace RBAC role schema (authority model).
 *
 * Six-role access hierarchy: Owner > Admin > Billing Admin > Editor > Reviewer > Viewer.
 * Additive to the legacy `role` ('owner'/'member') — this module resolves the durable
 * `access_role` and exposes comparisons for gating. Pure (no I/O) for unit-testability.
 */

const ACCESS_ROLES = Object.freeze(['Owner', 'Admin', 'Billing Admin', 'Editor', 'Reviewer', 'Viewer']);

// Higher = more authority (permission rank for roleAtLeast).
const ROLE_RANK = Object.freeze({ Owner: 5, Admin: 4, 'Billing Admin': 3, Editor: 2, Reviewer: 1, Viewer: 0 });

/**
 * Deterministic mapping from the legacy 2-role model + workspace ownership to the 6-role access_role.
 * - workspace owner -> 'Owner'
 * - legacy 'owner'  -> 'Owner'
 * - legacy 'member' -> 'Viewer' (least privilege)
 * - otherwise      -> 'Viewer'
 */
function resolveAccessRole({ workspaceOwnerId, userId, membershipRole }) {
  if (workspaceOwnerId && userId && workspaceOwnerId === userId) return 'Owner';
  const role = String(membershipRole || '').toLowerCase();
  if (role === 'owner') return 'Owner';
  if (role === 'member') return 'Viewer';
  return 'Viewer';
}

function roleAtLeast(role, minRole) {
  const a = ROLE_RANK[role];
  const b = ROLE_RANK[minRole];
  return a !== undefined && b !== undefined && a >= b;
}

function isAccessRole(value) {
  return ACCESS_ROLES.includes(value);
}

module.exports = { ACCESS_ROLES, ROLE_RANK, resolveAccessRole, roleAtLeast, isAccessRole };
