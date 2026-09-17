'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGenerationRequest,
  durableResultFromTask,
  createStudioGenerationBridge,
} = require('./studioGenerationBridge.cjs');

test('buildGenerationRequest maps image node parameters and upstream text', () => {
  const request = buildGenerationRequest({
    nodeType: 'image-generation',
    input: { parameters: { logicalModelId: 'm-img', aspectRatio: '16:9', resolution: '1280x720', negativePrompt: 'blur' } },
    upstreamResults: { prompt: { result: { text: 'a cat' } } },
  });
  assert.deepEqual(request, {
    model: 'm-img', prompt: 'a cat', ratio: '16:9', resolution: '1280x720',
    contentType: 'image', count: 1, negative: 'blur', referenceImages: [], durationSec: 6, videoMode: undefined,
  });
});

test('durableResultFromTask keeps media IDs and omits URLs', () => {
  const result = durableResultFromTask({
    status: 'done',
    taskId: 'gt-1',
    result: { images: [{ mediaId: 'media-1', ossUrl: 'https://cdn.example/temporary' }] },
  }, { cost: 2, nodeType: 'image-generation' });
  assert.deepEqual(result, {
    nodeType: 'image-generation', executionKind: 'GENERATION', contentType: 'image',
    taskId: 'gt-1', cost: 2, mediaIds: ['media-1'], imageAssetIds: ['media-1'], assetIds: ['media-1'],
  });
  assert.equal(JSON.stringify(result).includes('cdn.example'), false);
});

test('durableResultFromTask rejects provider URLs even when returned as strings', () => {
  const result = durableResultFromTask({
    status: 'done',
    taskId: 'gt-2',
    result: {
      images: ['https://provider.example/image.png', { mediaId: 'media-2' }],
      videoMedia: { mediaId: 'https://provider.example/video.mp4', id: 'https://provider.example/video-id' },
    },
  }, { cost: 2, nodeType: 'image-generation' });
  assert.deepEqual(result.mediaIds, ['media-2']);
  assert.deepEqual(result.imageAssetIds, ['media-2']);
  assert.equal(JSON.stringify(result).includes('provider.example'), false);
});

function makeBridgeHarness({ taskStatus = 'done', existingTask = null } = {}) {
  const calls = { queries: [], reserve: [], release: [], generate: [], status: [], heartbeat: 0 };
  const task = existingTask || { task_id: 'gt-new', status: 'running' };
  let generated = false;
  const pg = {
    async query(sql, params) {
      calls.queries.push({ sql, params });
      if (sql.includes('FROM generation_tasks WHERE idempotency_key')) {
        return { rows: existingTask ? [task] : [] };
      }
      if (sql.includes('supports_reward_balance')) return { rows: [{ supports_reward_balance: false }] };
      return { rows: [] };
    },
  };
  const dispatcher = {
    async generateAsync(_pg, opts) {
      generated = true;
      calls.generate.push(opts);
      return { taskId: 'gt-new' };
    },
    async getTaskStatus(_pg, taskId) {
      calls.status.push(taskId);
      if (taskStatus === 'done') return { taskId, status: 'done', result: { images: [{ mediaId: 'media-1' }] } };
      return { taskId, status: taskStatus, error: 'provider failed' };
    },
  };
  const billing = {
    async resolvePayment() { return { pool: 'recharge', amount: 2 }; },
    async reserveCredits(_pg, userId, amount, ref, pool) { calls.reserve.push({ userId, amount, ref, pool }); },
    async releaseCredits(_pg, userId, amount, ref, pool) { calls.release.push({ userId, amount, ref, pool }); },
  };
  const accounting = { async getModelPrice() { return { creditPrice: 2, rewardPrice: 0 }; } };
  const bridge = createStudioGenerationBridge({
    pg, dispatcher, billing, accounting,
    modelResolver: { async resolveModelIdentity() { return ['m-img']; } },
    pollIntervalMs: 0, maxWaitMs: 100, sleep: async () => {},
  });
  return { bridge, calls, get generated() { return generated; } };
}

test('bridge reserves once and polls to a durable result', async () => {
  const h = makeBridgeHarness();
  const executor = h.bridge.createExecutor({
    runId: 'run-1', nodeId: 'node-1', nodeType: 'image-generation', requestedBy: 'user-1',
    input: { parameters: { logicalModelId: 'm-img', prompt: 'cat' } }, upstreamResults: {},
    heartbeat: async () => { h.calls.heartbeat += 1; return true; },
  });
  const out = await executor.execute();
  assert.equal(out.result.mediaIds[0], 'media-1');
  assert.equal(h.calls.reserve.length, 1);
  assert.equal(h.calls.reserve[0].ref, 'studio:run-1:node-1');
  assert.equal(h.calls.generate.length, 1);
  assert.equal(h.generated, true);
});

test('bridge reuses an existing running task without another reservation', async () => {
  const h = makeBridgeHarness({ existingTask: { task_id: 'gt-existing', status: 'running' } });
  const executor = h.bridge.createExecutor({
    runId: 'run-1', nodeId: 'node-1', nodeType: 'image-generation', requestedBy: 'user-1',
    input: { parameters: { logicalModelId: 'm-img', prompt: 'cat' } }, upstreamResults: {},
  });
  const out = await executor.execute();
  assert.equal(out.result.taskId, 'gt-existing');
  assert.equal(h.calls.reserve.length, 0);
  assert.equal(h.calls.generate.length, 0);
});

test('bridge releases the reservation when submission fails', async () => {
  const h = makeBridgeHarness();
  h.bridge = createStudioGenerationBridge({
    pg: { query: async (sql) => sql.includes('supports_reward_balance') ? { rows: [{ supports_reward_balance: false }] } : { rows: [] } },
    dispatcher: {
      async generateAsync() { return { taskId: null, error: 'dispatcher unavailable' }; },
      async getTaskStatus() { return { status: 'failed', error: 'unreachable' }; },
    },
    billing: h.bridge ? {
      async resolvePayment() { return { pool: 'recharge', amount: 2 }; },
      async reserveCredits() {},
      async releaseCredits(_pg, userId, amount, ref, pool) { h.calls.release.push({ userId, amount, ref, pool }); },
    } : null,
    accounting: { async getModelPrice() { return { creditPrice: 2, rewardPrice: 0 }; } },
    modelResolver: { async resolveModelIdentity() { return ['m-img']; } },
    pollIntervalMs: 0,
  });
  const executor = h.bridge.createExecutor({
    runId: 'run-1', nodeId: 'node-1', nodeType: 'image-generation', requestedBy: 'user-1',
    input: { parameters: { logicalModelId: 'm-img', prompt: 'cat' } }, upstreamResults: {},
  });
  await assert.rejects(executor.execute(), (e) => e.code === 'GENERATION_SUBMIT_FAILED');
  assert.equal(h.calls.release.length, 1);
});

test('bridge fails with the persisted provider error', async () => {
  const h = makeBridgeHarness({ taskStatus: 'failed' });
  const executor = h.bridge.createExecutor({
    runId: 'run-1', nodeId: 'node-1', nodeType: 'image-generation', requestedBy: 'user-1',
    input: { parameters: { logicalModelId: 'm-img', prompt: 'cat' } }, upstreamResults: {},
  });
  await assert.rejects(executor.execute(), (e) => e.code === 'GENERATION_TASK_FAILED' && e.message === 'provider failed');
});
