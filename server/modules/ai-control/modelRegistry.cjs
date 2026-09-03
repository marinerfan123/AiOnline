'use strict';
/**
 * W3-07 — Model Registry: provider/model/capability/input/reference/duration/resolution/cost/latency/
 * region/version/enabled/deprecation fields normalized, with a user-safe projection that strips
 * locked/internal fields. Pure module (no I/O).
 */
const NORMALIZED_FIELDS = ['id', 'provider', 'model', 'capabilities', 'input', 'reference', 'duration', 'resolution', 'cost', 'latency', 'region', 'version', 'enabled', 'deprecation'];
const LOCKED_FIELDS = new Set(['apiKey', 'api_key', 'secret', 'credential', 'credentials', 'internalCost', 'margin', 'internalNote', 'keyPool']);

/** Normalize a raw registry record into the canonical shape. */
function normalizeModelRegistry(raw = {}) {
  const out = {};
  for (const k of NORMALIZED_FIELDS) if (raw[k] !== undefined) out[k] = raw[k];
  out.id = raw.id || raw.model || null;
  out.enabled = raw.enabled !== false;
  out.deprecation = raw.deprecation || null;
  out.capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  return out;
}

/** Validate a normalized registry record. Returns {ok, errors[]}. */
function validateModelRegistry(n) {
  const errors = [];
  if (!n) { errors.push('model required'); return { ok: false, errors }; }
  if (!n.id) errors.push('id required');
  if (!n.provider) errors.push('provider required');
  if (n.cost == null || Number(n.cost) < 0) errors.push('cost must be a non-negative number');
  if (n.latency != null && Number(n.latency) < 0) errors.push('latency must be >= 0');
  if (!Array.isArray(n.capabilities)) errors.push('capabilities must be an array');
  return { ok: errors.length === 0, errors };
}

/** User-safe projection: expose only non-locked, non-internal fields (no key/margin/notes). */
function projectToUserModel(n) {
  const out = {};
  for (const [k, v] of Object.entries(n || {})) {
    if (LOCKED_FIELDS.has(k) || k.startsWith('internal') || k.startsWith('key')) continue;
    out[k] = v;
  }
  return out;
}

module.exports = { normalizeModelRegistry, validateModelRegistry, projectToUserModel, NORMALIZED_FIELDS, LOCKED_FIELDS };
