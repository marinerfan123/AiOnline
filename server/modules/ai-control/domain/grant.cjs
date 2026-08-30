'use strict';
/**
 * M02-C — Capability Grant Domain (workspace/user entitlements)
 *
 * Grants are optional: with NO grant rows for a model, it's OPEN.
 * Once any grant row exists, the model is ENFORCED (default-deny inside the set).
 */
const GRANT_STATUSES = ['granted', 'revoked'];

/**
 * Validate a grant input (pre-write).
 * @param {object} grant  { workspace_id?, user_id?, model_id, capability, granted_by? }
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
function validateGrant(grant) {
  const errors = [];
  if (!grant || typeof grant !== 'object') return { ok: false, errors: ['grant 必须是对象'] };
  if (!grant.model_id) errors.push('缺少 model_id');
  if (!grant.user_id && !grant.workspace_id) {
    errors.push('必须提供 user_id 或 workspace_id');
  }
  if (grant.user_id && grant.workspace_id) {
    errors.push('user_id 和 workspace_id 不能同时提供');
  }
  if (grant.capability !== undefined && typeof grant.capability !== 'string') {
    errors.push('capability 必须是字符串或省略');
  }
  if (grant.granted_by !== undefined && typeof grant.granted_by !== 'string') {
    errors.push('granted_by 必须是字符串');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Project a grant row to domain object.
 */
function toGrant(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    workspace_id: row.workspace_id ?? null,
    user_id: row.user_id ?? null,
    model_id: row.model_id ?? null,
    capability: row.capability ?? null,
    status: row.status ?? 'granted',
    granted_by: row.granted_by ?? null,
    expires_at: row.expires_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * Check if a user/workspace has capability for a model.
 * Returns true if:
 *   - No grants exist for this model (OPEN)
 *   - Grant exists and is 'granted' and not expired
 * Returns false if:
 *   - Grant exists and is 'revoked'
 *   - Grant exists but user/workspace doesn't match
 *   - Grant is expired
 * @param {object[]} grants  All grants for the model (from DB)
 * @param {object}   checker { userId?, workspaceId? }
 * @returns {boolean}
 */
function hasCapability(grants, checker = {}) {
  const userId = checker.userId;
  const workspaceId = checker.workspaceId;

  // No grants at all = OPEN (backward compatible)
  if (!grants || !grants.length) return true;

  // Find matching grants
  const matching = grants.filter((g) => {
    if (g.status !== 'granted') return false;
    if (userId && g.user_id === userId) return true;
    if (workspaceId && g.workspace_id === workspaceId) return true;
    return false;
  });

  // No matching grants = ENFORCED but not authorized
  if (!matching.length) return false;

  // Check expiration
  const now = new Date();
  return matching.some((g) => {
    if (!g.expires_at) return true;
    return new Date(g.expires_at) > now;
  });
}

/**
 * Resolve effective capabilities for a model given its grants.
 * If grants are empty, model is fully OPEN (all capabilities allowed).
 * If grants exist, only explicitly granted capabilities are allowed.
 * @param {string[]} allCapabilities  All known capabilities for the model
 * @param {object[]} grants           Grants for this model
 * @param {object}   checker          { userId?, workspaceId? }
 * @returns {string[]} Allowed capabilities
 */
function resolveEffectiveCapabilities(allCapabilities, grants, checker = {}) {
  if (!grants || !grants.length) return allCapabilities;
  const userId = checker.userId;
  const workspaceId = checker.workspaceId;
  const now = new Date();

  const allowed = new Set();
  for (const cap of allCapabilities) {
    const hasGrant = grants.some((g) => {
      if (g.status !== 'granted') return false;
      if (userId && g.user_id !== userId) return false;
      if (workspaceId && g.workspace_id !== workspaceId) return false;
      if (g.capability && g.capability !== cap && g.capability !== '*') return false;
      if (g.expires_at && new Date(g.expires_at) <= now) return false;
      return true;
    });
    if (hasGrant) allowed.add(cap);
  }
  return Array.from(allowed);
}

module.exports = {
  GRANT_STATUSES,
  validateGrant,
  toGrant,
  hasCapability,
  resolveEffectiveCapabilities,
};
