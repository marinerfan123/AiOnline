'use strict';
/**
 * M02-A — Generation V2 COMPATIBILITY PROOF.
 *
 * Requirement (STEP 20): do NOT rewrite the Generation V2 durable workflow.
 * Prove the new Control Plane can serve as its UPSTREAM config/resolution layer
 * while the existing production path still works.
 *
 * Strategy: the certified runtime reads (logical model → provider×model pairs)
 * via modelhub/bindings.loadDispatchPairs and resolves identity via
 * modelhub/resolver.resolveModelIdentity. This test shows:
 *   1) the M02 repository's logical-model view and the certified loadDispatchPairs
 *      agree on the SAME underlying (model_id, provider_id, binding) rows —
 *      i.e. the control plane is a read-side projection of the runtime's source of truth,
 *      not a parallel table.
 *   2) a resolved M02 binding can be handed to the certified agnes adapter (fake transport)
 *      end-to-end without any change to the runtime.
 * No real DB, no paid upstream.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('./repositories/aiControlRepository.cjs');
const { createAgnesAdapter } = require('./adapters/agnes.cjs');
const loadDispatchPairs = require('../modelhub/bindings.cjs').loadDispatchPairs;

function fakePgForCompat() {
  const providers = [{ id: 'p1', name: 'Agnes', base_url: 'https://api.agnes-ai.cn/v1', enabled: true, api_key: '' }];
  const apiKeys = [{ id: 'k1', provider_id: 'p1', api_key: 'sk-pool-11111', status: 'active', label: '', weight: 100 }];
  const models = [{
    id: 'm1', model_id: 'kling-x', display_name: 'Kling X', type: 'video', enabled: true,
    provider_id: 'p1', capabilities: { text_to_video: true }, credit_cost: 120,
    ai_capabilities: { type: 'text_to_video' }, ai_parameter_schemas: {}, capability_version: 1,
    endpoint: { generate: { path: '/videos' } }, param_template: {},
  }];
  const bindings = [{ id: 'b1', model_id: 'kling-x', provider_id: 'p1', upstream_model_name: 'agnes-kling-x', enabled: true, priority: 5, weight: 80 }];

  return {
    async query(sql, params = []) {
      const T = sql.toUpperCase();
      if (T.includes('FROM PROVIDER_MODEL_BINDINGS')) return { rows: bindings };
      if (T.includes('FROM API_KEYS WHERE PROVIDER_ID = ANY')) return { rows: apiKeys };
      if (T.includes('FROM MODELS')) return { rows: models };
      if (T.includes('FROM PROVIDERS')) return { rows: providers };
      return { rows: [] };
    },
  };
}

test('compat: M02 logical-model view and certified loadDispatchPairs agree on the same binding row', async () => {
  const pg = fakePgForCompat();
  // certified runtime path
  const pairs = await loadDispatchPairs(pg, ['kling-x'], 'video');
  assert.equal(pairs.length, 1, 'certified runtime resolves exactly one pair');
  const pair = pairs[0];
  assert.equal(pair.bindingId, 'b1');
  assert.equal(pair.provider.id, 'p1');
  assert.equal(pair.model.upstreamModelName, 'agnes-kling-x');

  // M02 control-plane read-side view of the same source of truth
  const model = await repo.getLogicalModel(pg, 'kling-x');
  assert.ok(model, 'M02 repository resolves the logical model');
  assert.equal(model.model_id, 'kling-x');
  assert.equal(model.provider_bindings.length, 1);
  const m02binding = model.provider_bindings[0];
  assert.equal(m02binding.id, pair.bindingId, 'SAME binding id — projection of the runtime source, not a parallel table');
  assert.equal(m02binding.provider_id, pair.provider.id);
  assert.equal(m02binding.provider_model_code, pair.model.upstreamModelName);
});

test('compat: a resolved M02 binding drives the certified agnes adapter end-to-end (fake upstream)', async () => {
  const pg = fakePgForCompat();
  const model = await repo.getLogicalModel(pg, 'kling-x');
  const b = model.provider_bindings[0];

  // Build the provider+model the adapter expects, straight from the M02 binding projection.
  const provider = { base_url: 'https://api.agnes-ai.cn/v1' };
  const logicalModel = { model_id: b.logical_model_id, upstreamModelName: b.provider_model_code };
  const transport = {
    submit: async () => ({ status: 200, body: { video_id: 'vt-c1' } }),
    poll: async () => ({ status: 200, body: { status: 'completed', metadata: { url: 'https://cdn/v.mp4' } } }),
  };
  const adapter = createAgnesAdapter({ transport });

  const sub = await adapter.submit({ credential: 'sk-pool-11111', provider, logicalModel, input: { prompt: 'hi' } });
  assert.equal(sub.status, 'SUBMITTED');
  const poll = await adapter.poll({ credential: 'sk-pool-11111', provider, logicalModel, taskId: sub.taskId });
  assert.equal(poll.status, 'SUCCEEDED');
  assert.equal(poll.url, 'https://cdn/v.mp4');
  // credential authority stays with the key pool (injected), not the adapter
  assert.ok(!JSON.stringify(poll).includes('sk-pool-11111'));
});
