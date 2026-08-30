'use strict';
const ossMod = require('../../oss.cjs');

async function createProductionAdapters({ pgPool, dispatcher, assetFinalize, realtime, redis } = {}) {
  // 预检OSS启用状态，避免每次调用都查DB
  let ossEnabled = null;
  async function getOssEnabled() {
    if (ossEnabled !== null) return ossEnabled;
    try {
      const { enabled } = await ossMod.loadOssConfigs(pgPool);
      ossEnabled = enabled;
    } catch (e) {
      ossEnabled = false;
    }
    return ossEnabled;
  }

  async function dispatchSingle(payload, context = {}) {
    if (!dispatcher?.generate) throw new Error('dispatcher.generate unavailable');
    const r = await dispatcher.generate(pgPool, { ...payload, count: 1 });
    return r;
  }

  /**
   * 带分布式准入的 providerGenerate：
   * - 从 context 中提取 providerId / keys（来自 batch request_payload 或 item 上下文）
   * - 准入失败返回 null（由调用方重试或记 retry_wait）
   * - 准入成功后注入 providerId / keyId 到结果
   */
  async function providerGenerateWithAdmission(payload, context = {}) {
    const { providerId, keys } = context || {};
    if (!providerId || !Array.isArray(keys) || !keys.length) {
      return await dispatchSingle(payload, context);
    }
    if (!redis) {
      return await dispatchSingle(payload, context);
    }

    const adm = await require('./provider-admission.cjs').distributedProviderAdmission(redis, {
      providerId,
      keys,
      rpm: 60,
      maxConcurrent: 1,
      ttlMs: 120000,
      token: (payload && payload.clientRequestId) || '',
    });
    if (!adm) {
      // Redis 协调不可用 → fail-closed：返回 error
      return { status: 'error', errorCode: 'REDIS_UNAVAILABLE', errorMessage: 'Redis coordination unavailable' };
    }
    if (adm.denied) {
      // 背压拒绝
      if (adm.denied === 'rpm') {
        return { status: 'error', errorCode: 'RATE_LIMITED', errorMessage: 'per-key RPM exhausted', retryAfterMs: Math.max(0, adm.untilAt - Date.now()) };
      }
      return { status: 'error', errorCode: 'CAPACITY_EXHAUSTED', errorMessage: 'all keys at capacity' };
    }

    // 准入成功：dispatch 并注入 key 元数据
    let result;
    try {
      result = await dispatchSingle(payload, context);
    } finally {
      // 无论如何释放租约
      await adm.release();
    }

    // 注入 providerId / keyId 到结果（供 worker 落库）
    result.providerId = result.providerId || providerId;
    result.keyId = result.keyId || adm.keyId;
    return result;
  }

  return {
    dispatchSingle,
    providerGenerateWithAdmission,
    async uploadToOss({ providerUrl, objectKey, item }) {
      if (!assetFinalize?.finalizeUrl) throw new Error('assetFinalize.finalizeUrl unavailable');

      // OSS已禁用：直接使用providerUrl，跳过上传
      if (!(await getOssEnabled())) {
        return { ossUrl: providerUrl, mediaId: item.item_id };
      }

      const src = item.request_payload || {};
      const r = await assetFinalize.finalizeUrl(pgPool, {
        userId: item.user_id,
        taskId: item.batch_id,
        idx: item.item_index,
        providerUrl,
        type: item.content_type || 'image',
        prompt: src.prompt || '',
        model: item.model_id || src.model || '',
        ratio: src.ratio || '1:1',
        pendingId: item.item_id,
        objectKey
      });
      if (!r || r.status !== 'success' || !r.ossUrl) throw new Error((r && r.error) || 'asset finalize failed');
      return { ossUrl: r.ossUrl, mediaId: r.mediaId };
    },
    async publish(event) {
      const userId = event.payload && event.payload.userId;
      if (!userId) return false;
      realtime?.emitTaskUpdate?.(userId, { type: event.event_type, aggregateId: event.aggregate_id, ...event.payload });
      return true;
    }
  };
}

module.exports = { createProductionAdapters };
