'use strict';
/**
 * ModelHub V3 Phase 3 — 定价层双读单元测试
 * 运行：node --test server/modules/modelhub/pricing.test.cjs
 *
 * 不依赖真实 PG：用内存 fake pool 模拟 model_pricing / model_price_history / models /
 * provider_model_costs / model_cost_rates / settings / consumption_ledger，
 * 覆盖：
 *  - getModelPrice 双读链：model_pricing → model_price_history → models.credit_cost → none
 *  - getProviderCostCents 逐线路成本（per binding）+ 回退 (provider,model) 率 → 默认率
 *  - 同一逻辑模型的不同线路（binding A / B）成本不同（智能路由逐线路算利润的前提）
 *  - getProviderCostRate 来源判定（binding / rate / default）
 *  - recordConsumption 写入 binding_id 并使用逐线路成本；幂等；成本查询异常不阻断记账
 */

const test = require('node:test');
const assert = require('node:assert');
const accounting = require('../../accounting.cjs');

// ── 内存数据集 ───────────────────────────────────────
const MODELS = [{ model_id: 'flux-1', credit_cost: 50 }];
const PRICE_HISTORY = [{ model_id: 'flux-1', credit_cost: 80 }]; // 较新快照（晚于 models.credit_cost）
const MODEL_PRICING = [{ model_id: 'flux-1', credit_price: 100, reward_price: 20, currency: 'CNY' }];

// 逐线路成本：binding 是「线路」主键
const PROVIDER_COSTS = [
  // 线路 A（flux-1 via provider-a）：三单位各一行
  { binding_id: 'b-a', unit: 'per_1k_input_token', cost: 0.30 },
  { binding_id: 'b-a', unit: 'per_1k_output_token', cost: 0.50 },
  { binding_id: 'b-a', unit: 'per_asset', cost: 0.45 },
  // 线路 B（flux-1 via provider-b）：仅 per_asset，成本与 A 不同（0.32 ≠ 0.45）—— 核心：逐线路
  { binding_id: 'b-b', unit: 'per_asset', cost: 0.32 },
];

// 旧率表（按 provider,model）作为回退
const COST_RATES = [
  { provider_id: 'provider-a', model_id: 'flux-1', model_type: 'image', input_cost_per_1k: 0, output_cost_per_1k: 0, cost_per_unit: 0.38 },
];

const SETTINGS = { value: { creditToCents: 1, defaultBackendCost: { text: 0.05, image: 0.1, video: 0.2 } } };

/**
 * 构造 fake pool。
 * datasets 可覆盖各表数据；throwCost=true 时成本相关 SELECT 抛错（测异常兜底）。
 */
function makePool(datasets = {}, { throwCost = false } = {}) {
  const modelPricing = datasets.modelPricing !== undefined ? datasets.modelPricing : MODEL_PRICING;
  const priceHistory = datasets.priceHistory !== undefined ? datasets.priceHistory : PRICE_HISTORY;
  const models = datasets.models !== undefined ? datasets.models : MODELS;
  const providerCosts = datasets.providerCosts !== undefined ? datasets.providerCosts : PROVIDER_COSTS;
  const costRates = datasets.costRates !== undefined ? datasets.costRates : COST_RATES;
  const settings = datasets.settings !== undefined ? datasets.settings : SETTINGS;
  const LEDGER = datasets.ledger || [];

  return {
    async query(text, params = []) {
      const T = text.toUpperCase();
      // 设置表（积分折算 / 默认成本率）
      if (T.includes('FROM SETTINGS') || (T.includes('SETTINGS') && T.includes('WHERE'))) {
        return { rows: [settings] };
      }
      // 用户价：model_pricing
      if (T.includes('MODEL_PRICING')) {
        if (T.includes('SELECT')) return { rows: modelPricing.filter((r) => r.model_id === params[0]) };
        return { rows: [] }; // INSERT/UPSERT 视为成功
      }
      // 用户价回退：model_price_history
      if (T.includes('MODEL_PRICE_HISTORY')) {
        if (T.includes('SELECT')) return { rows: priceHistory.filter((r) => r.model_id === params[0]) };
        return { rows: [] };
      }
      // 模型表（回退）
      if (T.includes('FROM MODELS')) {
        return { rows: models.filter((m) => m.model_id === params[0]) };
      }
      // 逐线路成本：provider_model_costs
      if (T.includes('PROVIDER_MODEL_COSTS')) {
        if (T.includes('SELECT')) {
          if (throwCost) throw new Error('simulated cost table error');
          return { rows: providerCosts.filter((r) => r.binding_id === params[0]) };
        }
        return { rows: [] };
      }
      // 旧率表：model_cost_rates
      if (T.includes('MODEL_COST_RATES')) {
        if (T.includes('SELECT')) {
          if (throwCost) throw new Error('simulated cost rate error');
          return { rows: costRates.filter((r) => r.provider_id === params[0] && r.model_id === params[1]) };
        }
        return { rows: [] };
      }
      // 消费台账：幂等查询 + 插入
      if (T.includes('CONSUMPTION_LEDGER')) {
        if (T.includes('INSERT')) {
          LEDGER.push(params);
          return { rows: [] };
        }
        // idempotency SELECT
        const key = params[0];
        return { rows: LEDGER.some((p) => p[14] === key) ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

// ── getModelPrice 双读链 ──────────────────────────────
test('getModelPrice：命中新表 model_pricing', async () => {
  const p = await accounting.getModelPrice(makePool(), 'flux-1');
  assert.strictEqual(p.source, 'model_pricing');
  assert.strictEqual(p.creditPrice, 100);
  assert.strictEqual(p.rewardPrice, 20);
});

test('getModelPrice：新表缺失时回退 model_price_history', async () => {
  // 给空 model_pricing，但保留 price_history
  const p = await accounting.getModelPrice(makePool({ modelPricing: [] }), 'flux-1');
  assert.strictEqual(p.source, 'model_price_history');
  assert.strictEqual(p.creditPrice, 80);
  assert.strictEqual(p.rewardPrice, 0);
});

test('getModelPrice：新表+历史均缺失时回退 models.credit_cost', async () => {
  const p = await accounting.getModelPrice(makePool({ modelPricing: [], priceHistory: [] }), 'flux-1');
  assert.strictEqual(p.source, 'models');
  assert.strictEqual(p.creditPrice, 50);
});

test('getModelPrice：无任何数据时返回 0/none（不抛错）', async () => {
  const p = await accounting.getModelPrice(makePool({ modelPricing: [], priceHistory: [], models: [] }), 'unknown');
  assert.strictEqual(p.source, 'none');
  assert.strictEqual(p.creditPrice, 0);
  assert.strictEqual(p.rewardPrice, 0);
});

test('getModelPrice：空 modelId 直接返回 none', async () => {
  const p = await accounting.getModelPrice(makePool(), '');
  assert.strictEqual(p.source, 'none');
});

// ── getProviderCostCents 逐线路 + 回退 ──────────────────
test('getProviderCostCents：图像按 per_asset 逐线路成本（线路 A=0.45/资产）', async () => {
  const c = await accounting.getProviderCostCents(makePool(), { bindingId: 'b-a', modelType: 'image', outputUnits: 1 });
  assert.strictEqual(c.source, 'binding');
  assert.strictEqual(c.cents, 0.45);
});

test('getProviderCostCents：文本按输入/输出 token 逐线路成本（线路 A）', async () => {
  const c = await accounting.getProviderCostCents(makePool(), { bindingId: 'b-a', modelType: 'text', inputUnits: 1000, outputUnits: 1000 });
  // 1*0.30 + 1*0.50 = 0.80
  assert.strictEqual(c.source, 'binding');
  assert.strictEqual(c.cents, 0.8);
});

test('getProviderCostCents：同一模型不同线路成本不同（A=0.45 vs B=0.32）—— 智能路由算利润前提', async () => {
  const a = await accounting.getProviderCostCents(makePool(), { bindingId: 'b-a', modelType: 'image', outputUnits: 1 });
  const b = await accounting.getProviderCostCents(makePool(), { bindingId: 'b-b', modelType: 'image', outputUnits: 1 });
  assert.strictEqual(a.cents, 0.45);
  assert.strictEqual(b.cents, 0.32);
  assert.notStrictEqual(a.cents, b.cents);
});

test('getProviderCostCents：无 bindingId 时回退 (provider,model) 率', async () => {
  const c = await accounting.getProviderCostCents(makePool(), { providerId: 'provider-a', modelId: 'flux-1', modelType: 'image', outputUnits: 1 });
  assert.strictEqual(c.source, 'rate');
  assert.strictEqual(c.cents, 0.38); // cost_per_unit
});

test('getProviderCostCents：无 binding 无率时回退默认率（image 0.1/资产）', async () => {
  const c = await accounting.getProviderCostCents(makePool({ costRates: [] }), { providerId: 'provider-x', modelId: 'x', modelType: 'image', outputUnits: 3 });
  assert.strictEqual(c.source, 'default');
  assert.strictEqual(c.cents, 0.3); // 3 * 0.1
});

test('getProviderCostCents：文本默认率按 token 合计', async () => {
  const c = await accounting.getProviderCostCents(makePool({ costRates: [] }), { modelType: 'text', inputUnits: 1000, outputUnits: 1000 });
  assert.strictEqual(c.source, 'default');
  assert.strictEqual(c.cents, 0.1); // (1000+1000)/1000 * 0.05
});

// ── getProviderCostRate 来源判定 ──────────────────────
test('getProviderCostRate：优先返回 binding 来源明细', async () => {
  const r = await accounting.getProviderCostRate(makePool(), { bindingId: 'b-a' });
  assert.strictEqual(r.source, 'binding');
  assert.strictEqual(r.rows.length, 3);
  assert.strictEqual(r.bindingId, 'b-a');
});

test('getProviderCostRate：无 binding 时回退 rate', async () => {
  const r = await accounting.getProviderCostRate(makePool(), { providerId: 'provider-a', modelId: 'flux-1' });
  assert.strictEqual(r.source, 'rate');
  assert.ok(r.rate);
});

test('getProviderCostRate：无 binding 无率时回退 default', async () => {
  const r = await accounting.getProviderCostRate(makePool({ costRates: [] }), { providerId: 'provider-x', modelId: 'x' });
  assert.strictEqual(r.source, 'default');
  assert.strictEqual(r.fallback, true);
});

// ── recordConsumption 写入 binding_id + 逐线路成本 ──────
test('recordConsumption：写入 binding_id 并使用逐线路成本', async () => {
  const ledger = [];
  const pg = makePool({ ledger });
  const res = await accounting.recordConsumption(pg, {
    scope: 'user', actorId: 'u1', purpose: 'generate', providerId: 'provider-a', modelId: 'flux-1',
    modelType: 'image', outputUnits: 2, customerChargeCredits: 100, bindingId: 'b-a', idempotencyKey: 'idem-1',
  });
  assert.strictEqual(res.bindingId, 'b-a');
  // 2 资产 * 0.45 = 0.90 后台成本
  assert.strictEqual(res.backendCostCents, 0.9);
  // 用户收 100 积分 * 1 = 100 分；margin = 100 - 0.9 = 99.1
  assert.strictEqual(res.customerChargeCents, 100);
  assert.strictEqual(res.marginCents, 99.1);
  // 落库行含 binding_id（参数 index 8）
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(ledger[0][8], 'b-a');
  assert.strictEqual(ledger[0][9], 0.9); // backend_cost_cents
});

test('recordConsumption：无 bindingId 时仍走 (provider,model) 率（旧路径不变）', async () => {
  const ledger = [];
  const pg = makePool({ ledger });
  const res = await accounting.recordConsumption(pg, {
    scope: 'user', actorId: 'u1', purpose: 'generate', providerId: 'provider-a', modelId: 'flux-1',
    modelType: 'image', outputUnits: 1, customerChargeCredits: 100, idempotencyKey: 'idem-2',
  });
  assert.strictEqual(res.bindingId, '');
  assert.strictEqual(res.backendCostCents, 0.38); // 回退 cost_per_unit
  assert.strictEqual(ledger[0][8], ''); // binding_id 空
});

test('recordConsumption：幂等——同 idempotencyKey 不双记', async () => {
  const ledger = [];
  const pg = makePool({ ledger });
  const a = await accounting.recordConsumption(pg, { purpose: 'generate', providerId: 'provider-a', modelId: 'flux-1', modelType: 'image', outputUnits: 1, idempotencyKey: 'same-key' });
  const b = await accounting.recordConsumption(pg, { purpose: 'generate', providerId: 'provider-a', modelId: 'flux-1', modelType: 'image', outputUnits: 1, idempotencyKey: 'same-key' });
  assert.strictEqual(a.skipped, undefined);
  assert.strictEqual(b.skipped, true);
  assert.strictEqual(ledger.length, 1); // 仅记一次
});

test('recordConsumption：成本表查询异常时不阻断记账（兜底默认率）', async () => {
  const ledger = [];
  const pg = makePool({ ledger }, { throwCost: true });
  // 成本查询抛错 → getProviderCostCents 捕获 → 走默认率（image 0.1）
  const res = await accounting.recordConsumption(pg, {
    scope: 'user', purpose: 'generate', modelType: 'image', outputUnits: 1, customerChargeCredits: 10, idempotencyKey: 'idem-err',
  });
  assert.strictEqual(typeof res.backendCostCents, 'number');
  assert.strictEqual(res.backendCostCents, 0.1); // 默认率兜底
  assert.strictEqual(ledger.length, 1);
});

test('recordConsumption：缺 purpose 抛错（契约保护）', async () => {
  await assert.rejects(() => accounting.recordConsumption(makePool(), { providerId: 'p', modelId: 'm' }), /purpose/);
});
