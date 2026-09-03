'use strict';
/**
 * W2-05 — Minimum rights/provenance metadata for commercial assets (pure validation, no I/O).
 */
const ORIGINS = ['uploaded', 'generated', 'imported'];
const FIELDS = ['origin', 'uploaded_by', 'generated_by', 'provider', 'model', 'generation_id', 'owner', 'license'];

/** Validate an asset-rights record. Returns {ok, errors[]}. Fail-closed on missing commercial_usage default. */
function validateAssetRights(r) {
  const errors = [];
  if (!r) { errors.push('rights required'); return { ok: false, errors }; }
  if (!r.asset_id) errors.push('asset_id required');
  if (r.origin != null && !ORIGINS.includes(r.origin)) errors.push(`origin must be one of ${ORIGINS.join('/', ',')}`);
  for (const f of FIELDS) {
    if (r[f] != null && typeof r[f] !== 'string') errors.push(`${f} must be a string`);
  }
  if (r.reference_assets != null && !Array.isArray(r.reference_assets)) errors.push('reference_assets must be an array');
  if (r.consent != null && (typeof r.consent !== 'object' || Array.isArray(r.consent))) errors.push('consent must be a JSON object');
  if (r.commercial_usage != null && typeof r.commercial_usage !== 'boolean') errors.push('commercial_usage must be a boolean');
  return { ok: errors.length === 0, errors };
}

module.exports = { validateAssetRights, ORIGINS };
