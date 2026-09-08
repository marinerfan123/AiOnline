'use strict';

const IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i;

function isDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:');
}

function contentUrl(id) {
  return `/api/media/${encodeURIComponent(String(id))}/content`;
}

function pickMediaProbeUrl(...values) {
  return values.find((value) => (
    typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.startsWith('data:')
  )) || '';
}

function mediaListSelectColumns() {
  // provider_url may hold multi-megabyte legacy data URIs. The list route must
  // never fetch it: PostgreSQL would materialize/transfer every blob before
  // compactMediaPayload could strip it, multiplying heap use under concurrency.
  return [
    'id', 'title', 'type', 'thumbnail', 'full_url', 'prompt', 'model', 'ratio', 'source',
    'is_favorite', 'is_deleted', 'oss_url', 'oss_object_key', 'oss_uploaded', 'category',
    'status', 'error_message', 'failed_at', 'file_size', 'task_id', 'created_at', 'character_id',
    'user_id', 'is_default', 'default_key', 'tags', 'reference_style_id', 'workspace_id',
    'project_id', 'mime_type', 'width', 'height', 'duration_ms', 'origin',
    'generation_batch_id', 'updated_at', 'checksum_sha256', 'reference_images',
  ].join(', ');
}

function compactMediaPayload(list) {
  return (Array.isArray(list) ? list : []).map((item) => {
    if (!item || !item.id) return item;
    const hasLegacyInlineImage = isDataUrl(item.thumbnail) || isDataUrl(item.fullUrl) || isDataUrl(item.ossUrl) || isDataUrl(item.providerUrl);
    if (!hasLegacyInlineImage) return item;
    const url = contentUrl(item.id);
    return { ...item, thumbnail: url, fullUrl: url, ossUrl: '', providerUrl: '' };
  });
}

function parseLegacyDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(IMAGE_DATA_URL_RE);
  if (!match) return null;
  try {
    return {
      contentType: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'),
      body: Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64'),
    };
  } catch {
    return null;
  }
}

module.exports = { compactMediaPayload, parseLegacyDataUrl, contentUrl, pickMediaProbeUrl, mediaListSelectColumns };
