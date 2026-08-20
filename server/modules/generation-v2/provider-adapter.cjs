'use strict';

async function loadItemContext(pg, itemId) {
  const r = await pg.query(
    `SELECT i.*,b.model_id,b.content_type,b.request_payload,b.user_id,b.idempotency_key
       FROM generation_items_v2 i
       JOIN generation_batches_v2 b ON b.batch_id=i.batch_id
      WHERE i.item_id=$1`, [itemId]);
  return r.rows && r.rows[0] ? r.rows[0] : null;
}

function buildSingleImagePayload(item) {
  const src = item.request_payload || {};
  const pendingIds = Array.isArray(src.pendingIds) && src.pendingIds[item.item_index] != null
    ? [src.pendingIds[item.item_index]] : [];
  return {
    ...src,
    model: item.model_id,
    modelId: item.model_id,
    contentType: item.content_type || 'image',
    count: 1,
    pendingIds,
  };
}

function normalizeProviderResult(result) {
  const r = result || {};
  if (r.status === 'success') {
    const providerUrl = Array.isArray(r.images) ? r.images[0] : (r.providerUrl || r.imageUrl || null);
    return { status:'success',providerUrl,providerId:r.providerId||null,keyId:r.keyId||null,providerRequestId:r.providerTaskId||r.providerRequestId||null,httpStatus:r.httpStatus||200 };
  }
  return {
    status:'error',providerId:r.providerId||null,keyId:r.keyId||null,
    providerRequestId:r.providerTaskId||r.providerRequestId||null,
    httpStatus:r.httpStatus||(r.rateLimited?429:null),
    errorCode:r.errorCode||(r.rateLimited?'RATE_LIMITED':'PROVIDER_ERROR'),
    errorMessage:r.error||r.errorMessage||'provider error',retryAfter:r.retryAfter||null,
  };
}

function createProviderAdapter({ dispatchSingle } = {}) {
  if (typeof dispatchSingle !== 'function') throw new TypeError('dispatchSingle is required');
  return async function providerGenerate(item) {
    const payload = buildSingleImagePayload(item);
    return normalizeProviderResult(await dispatchSingle(payload,item));
  };
}

module.exports = { loadItemContext, buildSingleImagePayload, normalizeProviderResult, createProviderAdapter };
