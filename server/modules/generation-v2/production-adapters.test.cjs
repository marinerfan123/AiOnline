'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductionAdapters } = require('./production-adapters.cjs');

// Minimal pgPool stub so getOssEnabled() can call loadOssConfigs without throwing.
const fakePg = { query: async () => ({ rows: [] }) };

test('generation适配器调用dispatcher.generate并标准化单图结果', async () => {
  let seen;
  const a = await createProductionAdapters({
    pgPool: fakePg,
    dispatcher: { generate: async (_pg, p) => { seen = p; return { status: 'success', images: ['u'], usedProviders: ['p1'] }; } },
    assetFinalize: {},
    realtime: {},
  });
  const r = await a.dispatchSingle({ count: 1, prompt: 'x' });
  assert.equal(seen.count, 1);
  assert.equal(r.status, 'success');
  assert.equal(r.images[0], 'u');
});

test('upload适配器调用assetFinalize.finalizeUrl并返回ossUrl', async () => {
  let seen;
  const a = await createProductionAdapters({
    pgPool: fakePg,
    dispatcher: {},
    assetFinalize: { finalizeUrl: async (_pg, p) => { seen = p; return { ossUrl: 'oss', status: 'success' }; } },
    realtime: {},
  });
  const r = await a.uploadToOss({
    providerUrl: 'up',
    objectKey: 'generation-v2/b/0.png',
    item: { item_id: 'i', batch_id: 'b', item_index: 0, user_id: 'u', model_id: 'm', request_payload: { prompt: 'x', ratio: '1:1' } },
  });
  assert.equal(seen.providerUrl, 'up');
  assert.equal(seen.pendingId, 'i');
  assert.equal(r.ossUrl, 'oss');
});

test('outbox适配器通过realtime按userId发布', async () => {
  const calls = [];
  const a = await createProductionAdapters({
    pgPool: fakePg,
    dispatcher: {},
    assetFinalize: {},
    realtime: { emitTaskUpdate: (u, p) => calls.push([u, p]) },
  });
  await a.publish({ aggregate_id: 'i', event_type: 'item.done', payload: { userId: 'u', x: 1 } });
  assert.equal(calls[0][0], 'u');
  assert.equal(calls[0][1].type, 'item.done');
});
