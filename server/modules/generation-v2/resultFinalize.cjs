'use strict';
/**
 * W4-05 — Result → Asset Processor → Asset Version (pure idempotency contract). OSS/local
 * finalization is idempotent: a duplicate callback (same callbackId) does NOT duplicate an Asset
 * Version. Builds the version record + dedup decision.
 */
const crypto = require('crypto');
const { adaptLegacyMediaToVersion } = require('../project-foundation/assetVersion.cjs');

/** Decide finalization: dedup by callbackId. Returns {ok, duplicate, versionId}. */
function processResult({ callbackId, provider, model, generationId, shotId, result } = {}) {
  if (!callbackId) return { ok: false, error: { code: 'FINALIZE_MISSING_CALLBACK' } };
  const versionId = `av-${crypto.createHash('sha256').update(callbackId).digest('hex').slice(0, 16)}`;
  // Duplicate callback (same callbackId) derives the SAME versionId -> no duplicate Asset Version.
  return {
    ok: true,
    duplicate: false, // caller checks a prior entry matching versionId/callbackId to set true
    versionId,
    assetVersion: {
      version_id: versionId,
      media_id: result && result.mediaId ? result.mediaId : `media-${versionId}`,
      project_id: (result && result.projectId) || null,
      kind: 'generated',
      status: result && result.status === 'failed' ? 'failed' : 'ready',
      generation_id: generationId || null,
      model: model || null,
      provider: provider || null,
      storage_key: result && (result.ossObjectKey || result.storageKey) || null,
      size_bytes: result && result.fileSize != null ? Number(result.fileSize) : null,
    },
  };
}

/** Idempotent dedup: if a version with the callback-derived id already exists -> duplicate. */
function finalizeDedup(versionId, existingVersionIds) {
  return existingVersionIds.includes(versionId);
}

module.exports = { processResult, finalizeDedup };
