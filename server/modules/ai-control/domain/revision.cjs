'use strict';
/**
 * M02-C — Model Revision Domain
 *
 * Immutable revision manifests: once published, content_hash never changes.
 * New revisions supersede active; retired revisions mark the previous active.
 * content_hash = sha256(manifest) enables audit-verified traceability.
 */
const crypto = require('node:crypto');

const REVISION_STATUSES = ['active', 'retired'];

/**
 * Compute content hash for a manifest.
 * @param {object} manifest
 * @returns {string} hex SHA-256
 */
function computeContentHash(manifest) {
  const canonical = JSON.stringify(manifest);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Validate a revision input (pre-write).
 * @param {object} rev  { model_id, manifest, published_by? }
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
function validateRevision(rev) {
  const errors = [];
  if (!rev || typeof rev !== 'object') return { ok: false, errors: ['revision 必须是对象'] };
  if (!rev.model_id) errors.push('缺少 model_id');
  if (!rev.manifest || typeof rev.manifest !== 'object' || Array.isArray(rev.manifest)) {
    errors.push('manifest 必须是对象');
  } else if (!rev.manifest.capabilities && !rev.manifest.capability_version) {
    // At minimum, a manifest should declare capabilities or a capability_version
    errors.push('manifest 必须包含 capabilities 或 capability_version');
  }
  if (rev.published_by !== undefined && typeof rev.published_by !== 'string') {
    errors.push('published_by 必须是字符串');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Project a revision row to domain object.
 * @param {object} row  DB row
 * @returns {object|null}
 */
function toRevision(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    model_id: row.model_id ?? null,
    revision: Number(row.revision) ?? null,
    content_hash: row.content_hash ?? null,
    manifest: row.manifest ?? {},
    status: row.status ?? 'active',
    supersedes: row.supersedes ?? null,
    published_by: row.published_by ?? null,
    published_at: row.published_at ?? null,
    retired_at: row.retired_at ?? null,
  };
}

/**
 * Get the latest revision number for a model (for next-publish).
 * @param {number[]} existingRevisions
 * @returns {number} next revision (max + 1, or 1 if none)
 */
function nextRevisionNumber(existingRevisions) {
  if (!existingRevisions || !existingRevisions.length) return 1;
  return Math.max(...existingRevisions) + 1;
}

module.exports = {
  REVISION_STATUSES,
  computeContentHash,
  validateRevision,
  toRevision,
  nextRevisionNumber,
};
