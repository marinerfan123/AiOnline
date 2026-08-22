'use strict';
const ossMod = require('../../oss.cjs');

async function createProductionAdapters({pgPool,dispatcher,assetFinalize,realtime}={}) {
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

  return {
    async dispatchSingle(payload) {
      if (!dispatcher?.generate) throw new Error('dispatcher.generate unavailable');
      const r = await dispatcher.generate(pgPool, { ...payload, count: 1 });
      return r;
    },
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