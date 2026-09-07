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

module.exports = { compactMediaPayload, parseLegacyDataUrl, contentUrl, pickMediaProbeUrl };
