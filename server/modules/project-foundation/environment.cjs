'use strict';
/**
 * W2-02 — Project-scoped Environment domain (validation + reference link), pure module (no I/O).
 */
const JSON_OBJECT_FIELDS = ['geometry', 'props', 'lighting', 'palette'];

/** Validate an environment record. Returns {ok, errors[]}. */
function validateEnvironment(e) {
  const errors = [];
  if (!e) { errors.push('environment required'); return { ok: false, errors }; }
  if (!e.workspace_id) errors.push('workspace_id required');
  if (!e.project_id) errors.push('project_id required');
  if (!e.name || (typeof e.name === 'string' && !e.name.trim())) errors.push('name required');
  for (const k of JSON_OBJECT_FIELDS) {
    if (e[k] != null && (typeof e[k] !== 'object' || Array.isArray(e[k]))) errors.push(`${k} must be a JSON object`);
  }
  if (e.generated_views != null && !Array.isArray(e.generated_views)) errors.push('generated_views must be an array');
  if (e.master_reference_id != null && (typeof e.master_reference_id !== 'string' || !e.master_reference_id.trim())) errors.push('master_reference_id must be a non-empty string');
  return { ok: errors.length === 0, errors };
}

module.exports = { validateEnvironment };
