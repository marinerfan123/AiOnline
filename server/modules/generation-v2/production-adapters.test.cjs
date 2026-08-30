'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductionAdapters } = require('./production-adapters.cjs');

test('createProductionAdapters 返回标准接口', async () => {
  const prod = await createProductionAdapters({
    pgPool: { query: async () => ({ rows: [{ enabled: true }] }) },
    dispatcher: { generate: async () => ({ status: 'success', images: ['url'] }) },
    assetFinalize: {},
    realtime: {},
  });
  assert.ok(typeof prod.dispatchSingle === 'function');
  assert.ok(typeof prod.uploadToOss === 'function');
  assert.ok(typeof prod.publish === 'function');
  assert.ok(typeof prod.providerGenerateWithAdmission === 'function');
});

test('dispatchSingle 委托 dispatcher.generate', async () => {
  let received;
  const prod = await createProductionAdapters({
    pgPool: {},
    dispatcher: { generate: async (pg, opts) => { received = opts; return { status: 'success', images: ['url'] }; } },
    assetFinalize: {},
    realtime: {},
  });
  const result = await prod.dispatchSingle({ prompt: 'x' });
  assert.equal(received.prompt, 'x');
  assert.equal(received.count, 1);
  assert.equal(result.status, 'success');
});

test('publish 在有 userId 时调用 realtime', async () => {
  let emitted = null;
  const prod = await createProductionAdapters({
    pgPool: {},
    dispatcher: { generate: async () => ({ status: 'success' }) },
    assetFinalize: {},
    realtime: { emitTaskUpdate: async (uid, event) => { emitted = { uid, event }; } },
  });
  const ok = await prod.publish({ payload: { userId: 'u1' }, event_type: 'batch.accepted' });
  assert.ok(ok);
  assert.equal(emitted.uid, 'u1');
});

test('publish 无 userId 时返回 false', async () => {
  const prod = await createProductionAdapters({
    pgPool: {},
    dispatcher: { generate: async () => ({}) },
    assetFinalize: {},
    realtime: {},
  });
  const ok = await prod.publish({ payload: {}, event_type: 'x' });
  assert.equal(ok, false);
});

test('providerGenerateWithAdmission 当无 providerId 时退化为 dispatchSingle', async () => {
  let received;
  const prod = await createProductionAdapters({
    pgPool: {},
    dispatcher: { generate: async (pg, opts) => { received = opts; return { status: 'success', images: ['url'] }; } },
    assetFinalize: {},
    realtime: {},
    redis: null,
  });
  const result = await prod.providerGenerateWithAdmission({ prompt: 'x' }, {});
  assert.ok(result);
  assert.equal(result.status, 'success');
});

test('providerGenerateWithAdmission 准入失败返回 error', async () => {
  // Mock: Redis eval returns ['deny', '5000'] -> rpm denial
  const redis = {
    eval: async () => ['deny', '5000'],
  };
  const prod = await createProductionAdapters({
    pgPool: {},
    dispatcher: { generate: async () => ({ status: 'success' }) },
    assetFinalize: {},
    realtime: {},
    redis,
  });
  const result = await prod.providerGenerateWithAdmission(
    { prompt: 'x' },
    { providerId: 'p1', keys: [{ id: 'k1' }] }
  );
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'RATE_LIMITED');
});

test('providerGenerateWithAdmission 准入成功注入 providerId/keyId', async () => {
  // Mock: Redis eval returns ['ok', 'k1', 't1', '123456']
  const redis = {
    eval: async () => ['ok', 'k1', 't1', '123456'],
  };
  const prod = await createProductionAdapters({
    pgPool: {},
    dispatcher: { generate: async () => ({ status: 'success', images: ['url'] }) },
    assetFinalize: {},
    realtime: {},
    redis,
  });
  const result = await prod.providerGenerateWithAdmission(
    { prompt: 'x', clientRequestId: 'cr-1' },
    { providerId: 'p1', keys: [{ id: 'k1' }] }
  );
  assert.equal(result.status, 'success');
  assert.equal(result.providerId, 'p1');
  assert.equal(result.keyId, 'k1');
});
