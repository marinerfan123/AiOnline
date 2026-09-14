'use strict';
/**
 * W3-11 — Asset Version model (validation + legacy media.id compatibility), pure no-I/O.
 * A version preserves `media_id` (=== media.id === assetId) while adding version identity/status.
 */
const KINDS = ['upload', 'generated', 'derived'];
const STATUSES = ['pending', 'ready', 'failed'];

function validateAssetVersion(v) {
  const errors = [];
  if (!v) { errors.push('version required'); return { ok: false, errors }; }
  if (!v.version_id) errors.push('version_id required');
  if (!v.media_id) errors.push('media_id required (media.id compatibility)');
  if (!v.project_id) errors.push('project_id required');
  if (!KINDS.includes(v.kind)) errors.push(`kind must be one of ${KINDS.join(',')}`);
  if (!STATUSES.includes(v.status)) errors.push(`status must be one of ${STATUSES.join(',')}`);
  if (v.size_bytes != null && (typeof v.size_bytes !== 'number' || v.size_bytes < 0)) errors.push('size_bytes must be a non-negative number');
  return { ok: errors.length === 0, errors };
}

/** Legacy compatibility: a media row (legacy single-image model) maps to a v1 version preserving id. */
function adaptLegacyMediaToVersion(media) {
  if (!media) return null;
  return {
    version_id: `v1-${media.id}`,
    media_id: media.id,               // media.id is preserved (assetId === media.id)
    project_id: media.project_id || media.projectId || null,
    kind: media.source === 'generated' ? 'generated' : 'upload',
    status: media.status === 'ready' ? 'ready' : 'pending',
    origin_asset_id: media.id,
    model: media.model || null,
    storage_key: media.storage_key || media.ossKey || null,
    size_bytes: media.file_size != null ? Number(media.file_size) : null,
  };
}

module.exports = { validateAssetVersion, adaptLegacyMediaToVersion, KINDS, STATUSES };
