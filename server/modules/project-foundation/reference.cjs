'use strict';
/**
 * W2-03 — First-class project Reference model (type matrix + validation), pure module (no I/O).
 * Reference types: character / environment / product / object / style / camera / composition /
 * motion / brand / audio. Each reference is project-scoped and carries optional role/source.
 */

const REFERENCE_TYPES = [
  'character', 'environment', 'product', 'object', 'style', 'camera',
  'composition', 'motion', 'brand', 'audio',
];

/** Validate a reference record. Returns {ok, errors[]}. */
function validateReference(ref) {
  const errors = [];
  if (!ref) { errors.push('reference required'); return { ok: false, errors }; }
  if (!ref.project_id) errors.push('project_id required');
  if (!REFERENCE_TYPES.includes(ref.type)) errors.push(`type must be one of ${REFERENCE_TYPES.join('/', ',')}`);
  if (!ref.name || (typeof ref.name === 'string' && !ref.name.trim())) errors.push('name required');
  if (ref.role != null && (typeof ref.role !== 'string' || !ref.role.trim())) errors.push('role must be a non-empty string');
  if (ref.source != null && typeof ref.source !== 'string') errors.push('source must be a string');
  if (ref.attributes != null && (typeof ref.attributes !== 'object' || Array.isArray(ref.attributes))) errors.push('attributes must be a JSON object');
  return { ok: errors.length === 0, errors };
}

module.exports = { REFERENCE_TYPES, validateReference };
