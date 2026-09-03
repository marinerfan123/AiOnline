'use strict';
/**
 * W2-09 — Server-authoritative feature flags (targeting: internal/workspace/plan/region).
 * Factory-style surfaces are OFF by default. Pure module (no I/O); flags resolved server-side and
 * mirrored to the client featureFlags.ts.
 */

// Default value for each server-known flag (Factory/advanced surfaces default OFF).
const FLAG_DEFAULTS = {
  V2_STUDIO: false,          // complete Factory/Studio UI — OFF by default (1.0 scope)
  V2_APP_SHELL: false,
  SHOP_ENABLED: false,       // marketplace/skill surfaces — OFF by default
  ADVANCED_BLANTS: false,
  PLAN_GA: true,
};

// Internal/workspace/plan/region targeting overrides applied on top of defaults.
function resolveFlag(name, { context = {} } = {}) {
  const def = FLAG_DEFAULTS[name] !== undefined ? FLAG_DEFAULTS[name] : false;
  // Internal users may enable otherwise-hidden surfaces.
  if (context.internal && (name === 'V2_STUDIO' || name === 'V2_APP_SHELL' || name === 'SHOP_ENABLED')) return true;
  if (context.plan && context.plan === 'enterprise' && name === 'PLAN_GA') return true;
  if (context.region && context.region === 'qa' && name === 'V2_APP_SHELL') return true;
  // Explicit workspace allowlist.
  if (context.workspace && Array.isArray(context.workspaceAllowlist) && context.workspaceAllowlist.includes(context.workspace) && (name === 'V2_STUDIO' || name === 'SHOP_ENABLED')) return true;
  return def;
}

module.exports = { resolveFlag, FLAG_DEFAULTS };
