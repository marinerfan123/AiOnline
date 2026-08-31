'use strict';
const crypto = require('crypto');
const { releaseKeyLease } = require('./key-lease.cjs');
const { distributedProviderAdmission, admissionDenied } = require('./provider-admission.cjs');

/**
 * 分布式准入式 provider adapter（生成 V2 路径）
 *
 * 在每次 providerGenerate 前调用 distributedProviderAdmission 抢占 key 租约 + RPM。
 * 兼容旧路径：若无 redis/providerId/keys 则退化为直出。
 */
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
    idempotencyKey: item.client_request_id || src.idempotencyKey,
    clientRequestId: item.client_request_id || null,
    pendingIds,
  };
}

function normalizeProviderResult(result) {
  const r = result || {};
  if (r.status === 'success') {
    const providerUrl = Array.isArray(r.images) ? r.images[0] : (r.providerUrl || r.imageUrl || null);
    return { status:'success',providerUrl,providerId:r.providerId||null,keyId:r.keyId||null,providerRequestId:r.providerTaskId||r.providerRequestId||null,httpStatus:r.httpStatus||200 };
  }
  // 处理准入拒绝
  if (r.status === 'error' && (r.errorCode === 'REDIS_UNAVAILABLE' || r.errorCode === 'CAPACITY_EXHAUSTED' || r.errorCode === 'RATE_LIMITED')) {
    return {
      status: 'error',
      httpStatus: r.httpStatus || (r.errorCode === 'RATE_LIMITED' ? 429 : 503),
      errorCode: r.errorCode,
      errorMessage: r.errorMessage || 'provider error',
      retryAfter: r.retryAfterMs ? Math.round(r.retryAfterMs / 1000) : (typeof r.retryAfter === 'string' ? r.retryAfter : null),
    };
  }
  return {
    status:'error',providerId:r.providerId||null,keyId:r.keyId||null,
    providerRequestId:r.providerTaskId||r.providerRequestId||null,
    httpStatus:r.httpStatus||(r.rateLimited?429:null),
    errorCode:r.errorCode||(r.rateLimited?'RATE_LIMITED':'PROVIDER_ERROR'),
    errorMessage:r.error||r.errorMessage||'provider error',retryAfter:r.retryAfter||null,
  };
}

/**
 * createProviderAdapter({ dispatchSingle, redis, providerId, keys })
 * 返回 providerGenerate(item, signal) => result
 */
function createProviderAdapter({ dispatchSingle, redis, providerId, keys } = {}) {
  if (typeof dispatchSingle !== 'function') throw new TypeError('dispatchSingle is required');
  return async function providerGenerate(item, signal) {
    const payload = buildSingleImagePayload(item);
    // 有准入上下文时走 admission 路径
    if (redis && providerId && Array.isArray(keys) && keys.length > 0) {
      const adm = await distributedProviderAdmission(redis, {
        providerId,
        keys,
        rpm: 60,
        maxConcurrent: 1,
        ttlMs: 120000,
        token: payload.clientRequestId || crypto.randomUUID(),
      });
      if (!adm) {
        return normalizeProviderResult({ status: 'error', errorCode: 'REDIS_UNAVAILABLE', errorMessage: 'Redis unavailable' });
      }
      if (adm.denied) {
        // 背压拒绝：释放租约并返回 error
        if (typeof adm.release === 'function') await adm.release().catch(() => {});
        return normalizeProviderResult({
          status: 'error',
          errorCode: adm.denied === 'rpm' ? 'RATE_LIMITED' : 'CAPACITY_EXHAUSTED',
          errorMessage: adm.denied,
          retryAfterMs: adm.untilAt ? adm.untilAt - Date.now() : null,
        });
      }
      try {
        const result = await dispatchSingle(payload, item);
        result.providerId = result.providerId || providerId;
        result.keyId = result.keyId || adm.keyId;
        return normalizeProviderResult(result);
      } finally {
        if (typeof adm.release === 'function') await adm.release();
      }
    }
    return normalizeProviderResult(await dispatchSingle(payload, item));
  };
}

module.exports = { loadItemContext, buildSingleImagePayload, normalizeProviderResult, createProviderAdapter };
