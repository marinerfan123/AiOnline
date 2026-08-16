'use strict';
/**
 * ModelHub V3 Phase 3 — bindings 层透传 bindingId 单测
 * 运行：node --test server/modules/modelhub/bindings.test.cjs
 *
 * 不依赖真实 PG：fake pool 模拟 provider_model_bindings / models / providers，
 * 验证 loadDispatchPairs 把 provider_model_bindings.id（「线路」主键）透传为 pair.bindingId，
 * 且 legacy fallback（无绑定行）路径 pair.bindingId === ''（账单回退 (provider,model) 率，旧路径不变）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadDispatchPairs } = require('./bindings.cjs');

const BINDINGS = [
  { id: 'b-a', model_id: 'flux-1', provider_id: 'provider-a', upstream_model_name: 'flux-1', enabled: true, priority: 0, weight: 0 },
];
const MODELS = [{ model_id: 'flux-1', provider_id: 'provider-a', enabled: true }];
const PROVIDERS = [{ id: 'provider-a', enabled: true, api_key: 'sk-test-key-123', endpoint: '' }];

function makePool({ bindings = BINDINGS, models = MODELS, providers = PROVIDERS } = {}) {
  return {
    async query(text, params = []) {
      const T = text.toUpperCase();
      // 绑定读取：provider_model_bindings（已启用）
      if (T.includes('PROVIDER_MODEL_BINDINGS') && T.includes('SELECT')) {
        const ids = params[0] || [];
        return { rows: bindings.filter((b) => b.enabled && ids.includes(b.model_id)) };
      }
      // 模型行
      if (T.includes('FROM MODELS')) {
        return { rows: models.filter((m) => m.enabled) };
      }
      // 服务商行
      if (T.includes('FROM PROVIDERS')) {
        return { rows: providers };
      }
      return { rows: [] };
    },
  };
}

test('loadDispatchPairs：绑定 id 透传为 pair.bindingId', async () => {
  const pairs = await loadDispatchPairs(makePool(), ['flux-1']);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].bindingId, 'b-a');          // 线路主键已透传
  assert.strictEqual(pairs[0].model.model_id, 'flux-1');   // 既有字段不受影响
  assert.strictEqual(pairs[0].provider.id, 'provider-a');
});

test('loadDispatchPairs：legacy fallback（无绑定行）pair.bindingId 为空串', async () => {
  const pool = makePool({ bindings: [], models: [{ model_id: 'legacy-1', provider_id: 'provider-a', enabled: true }] });
  const pairs = await loadDispatchPairs(pool, ['legacy-1']);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].bindingId, '');             // 无线路 → 旧 (provider,model) 率路径
});

test('loadDispatchPairs：服务商不可用 → 返回空数组', async () => {
  const pool = makePool({ providers: [{ id: 'provider-a', enabled: false, api_key: '' }] });
  const pairs = await loadDispatchPairs(pool, ['flux-1']);
  assert.strictEqual(pairs.length, 0);
});
