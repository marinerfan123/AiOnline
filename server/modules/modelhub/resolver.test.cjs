'use strict';
/**
 * ModelHub V3 Phase 1 — resolver 单元测试 + 生成链路契约测试
 * 运行：node --test server/modules/modelhub/resolver.test.cjs
 *
 * 不依赖真实 PG：用内存 fake pool 模拟 models 表，覆盖：
 *  - model_id 优先匹配
 *  - display_name 兼容回退（display_name ≠ model_id 的场景）
 *  - 数组输入 / 去重
 *  - enabled 过滤（disabled 不返回 canonical，但原样回退避免硬失败）
 *  - 完全未命中 → 原样返回（交由下游裁决）
 *  - 空输入 / 无 pgPool 兜底
 *  - 契约：resolver 输出可直接驱动 dispatcher 的 model_id=ANY 查询
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const resolver = require('./resolver.cjs');
const { resolveModelIdentity } = resolver;

// ── 内存 fake models 表 ──────────────────────────────
// 关键：display_name 与 model_id 刻意不同，验证回退语义
const MODELS = [
  { model_id: 'dall-e-3', display_name: 'DALL·E 3', enabled: true },
  { model_id: 'flux-1-1-pro', display_name: 'FLUX 1.1 Pro', enabled: true },
  { model_id: 'disabled-model', display_name: 'Disabled Model', enabled: false },
  { model_id: 'dup-a', display_name: 'Dup A', enabled: true },
  { model_id: 'dup-a', display_name: 'Dup A Alias', enabled: true }, // 同 model_id 多行
];

function makePool() {
  return {
    async query(text, params) {
      const inputs = (params && params[0]) || [];
      if (text.includes('display_name = ANY')) {
        const rows = MODELS.filter(
          (m) => inputs.includes(m.display_name) && m.enabled,
        ).map((m) => ({ model_id: m.model_id }));
        return { rows };
      }
      if (text.includes('model_id = ANY')) {
        const rows = MODELS.filter(
          (m) => inputs.includes(m.model_id) && m.enabled,
        ).map((m) => ({ model_id: m.model_id }));
        return { rows };
      }
      return { rows: [] };
    },
  };
}

test('model_id 精确匹配优先返回 canonical', async () => {
  const ids = await resolveModelIdentity(makePool(), 'dall-e-3');
  assert.deepStrictEqual(ids, ['dall-e-3']);
});

test('display_name 回退：展示名映射到不同 model_id', async () => {
  const ids = await resolveModelIdentity(makePool(), 'FLUX 1.1 Pro');
  assert.deepStrictEqual(ids, ['flux-1-1-pro']);
});

test('display_name 未知时回退到 model_id 路径（输入即 model_id）', async () => {
  const ids = await resolveModelIdentity(makePool(), 'dall-e-3');
  assert.deepStrictEqual(ids, ['dall-e-3']);
});

test('数组输入 + 去重', async () => {
  const ids = await resolveModelIdentity(makePool(), ['dall-e-3', 'dall-e-3', 'FLUX 1.1 Pro']);
  assert.deepStrictEqual(ids, ['dall-e-3', 'flux-1-1-pro']);
});

test('同 model_id 多行去重为单值', async () => {
  const ids = await resolveModelIdentity(makePool(), 'Dup A');
  assert.deepStrictEqual(ids, ['dup-a']);
});

test('disabled 模型不返回 canonical，但原样回退避免硬失败', async () => {
  const ids = await resolveModelIdentity(makePool(), 'disabled-model');
  // enabled 过滤后无命中 → 兜底返回原输入
  assert.deepStrictEqual(ids, ['disabled-model']);
});

test('完全未命中 → 原样返回（下游裁决：400 / 无可用服务商）', async () => {
  const ids = await resolveModelIdentity(makePool(), 'ghost-model');
  assert.deepStrictEqual(ids, ['ghost-model']);
});

test('空输入返回空数组', async () => {
  assert.deepStrictEqual(await resolveModelIdentity(makePool(), ''), []);
  assert.deepStrictEqual(await resolveModelIdentity(makePool(), null), []);
  assert.deepStrictEqual(await resolveModelIdentity(makePool(), []), []);
});

test('无 pgPool 时原样回退', async () => {
  assert.deepStrictEqual(await resolveModelIdentity(null, 'dall-e-3'), ['dall-e-3']);
  assert.deepStrictEqual(await resolveModelIdentity(undefined, ['a', 'b']), ['a', 'b']);
});

test('pgPool.query 抛错时兜底返回输入，不抛异常', async () => {
  const badPool = { async query() { throw new Error('boom'); } };
  assert.deepStrictEqual(await resolveModelIdentity(badPool, 'dall-e-3'), ['dall-e-3']);
});

// ── 契约：resolver 输出驱动 dispatcher 的 model_id=ANY 查询 ──
test('契约：resolver 输出可直接用于 model_id=ANY 查询并仅取 enabled 行', async () => {
  // 模拟 dispatcher.generate() 第三步：SELECT * FROM models WHERE model_id=ANY($1) AND enabled=true
  const fakeDispatcherPool = {
    async query(text, params) {
      if (text.toUpperCase().includes('MODEL_ID') && text.includes('ANY')) {
        const ids = params[0];
        return { rows: MODELS.filter((m) => ids.includes(m.model_id) && m.enabled) };
      }
      return { rows: [] };
    },
  };
  const resolved = await resolveModelIdentity(makePool(), 'FLUX 1.1 Pro');
  const allModels = await fakeDispatcherPool.query(
    'SELECT * FROM models WHERE model_id=ANY($1) AND enabled=true',
    [resolved],
  );
  assert.strictEqual(allModels.rows.length, 1);
  assert.strictEqual(allModels.rows[0].model_id, 'flux-1-1-pro');
  assert.strictEqual(allModels.rows[0].display_name, 'FLUX 1.1 Pro');
});

test('契约：旧客户端传 display_name 经 resolver 后，dispatcher 仍能定位同一 model 行', async () => {
  const rawModel = 'DALL·E 3'; // 旧客户端传的展示名
  const resolved = await resolveModelIdentity(makePool(), rawModel);
  assert.strictEqual(resolved.length, 1);
  assert.strictEqual(resolved[0], 'dall-e-3'); // 归一为 canonical
});
