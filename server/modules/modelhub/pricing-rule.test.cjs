'use strict';
/**
 * ModelHub — Pricing Rule 版本化计算器（L31）单元测试。
 * 运行：node --test server/modules/modelhub/pricing-rule.test.cjs
 *
 * 不依赖真实 PG：用内存 fake pool 模拟 pricing_rules 表，覆盖：
 *   - resolveRule 有效窗口解析（含过期/未来生效不命中、开放段 NULL）
 *   - 版本优先（同窗口 ACTIVE 取 rule_version 最新版）
 *   - calculate 四类可计算公式（fixed / rate_per_second / rate_per_frame / tiered）
 *   - 未知 formula_kind 拒绝（白名单，禁静默 fallback）
 *   - custom_ref 仅引用禁执行（返回引用字符串，绝不 eval/require）
 *   - 缺 rule / 非法 tiered 维度拒绝
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPricingCalculator, calculate, FORMULA_KINDS } = require('./pricing.cjs');

// ── 固定解析时刻（epoch ms），使窗口测试确定 ─────────────────────────
const T = Date.parse('2026-09-05T00:00:00Z'); // 2026-09-05T00:00:00.000Z
const HOUR = 3600 * 1000;

/** 构造 fake pool：只模拟 pricing_rules 的 resolveRule 查询。 */
function makePool(rules) {
  return {
    async query(text, params = []) {
      const sql = String(text).toUpperCase();
      if (sql.includes('PRICING_RULES')) {
        const modelId = params[0];
        const opCode = params[1];
        const atMs = params[2] instanceof Date ? params[2].getTime() : Number(params[2]);
        const matches = (rules || [])
          .filter((r) => r.model_id === modelId && r.operation_code === opCode && r.status === 'ACTIVE')
          .filter((r) => r.effective_from <= atMs && (r.effective_to == null || r.effective_to > atMs))
          .sort((a, b) => (b.rule_version - a.rule_version));
        return { rows: matches.slice(0, 1) };
      }
      return { rows: [] };
    },
  };
}

/** 便捷构造规则行（effective_from/effective_to 用 epoch ms，对齐 fake pool）。 */
function mkRule(overrides = {}) {
  return Object.assign({
    rule_id: 'pr-1',
    model_id: 'video.seedance-2.5',
    operation_code: 'video.image_to_video',
    rule_version: 1,
    effective_from: T - HOUR,
    effective_to: null,
    formula_kind: 'fixed',
    params: { amount: 100 },
    status: 'ACTIVE',
    created_at: new Date(T - HOUR),
  }, overrides);
}

// ── resolveRule：有效窗口解析 ────────────────────────────────────────
test('resolveRule：当前生效窗口命中（effective_to NULL 开放段）', async () => {
  const pg = makePool([mkRule({ rule_id: 'pr-hit' })]);
  const { resolveRule } = createPricingCalculator({ pg });
  const res = await resolveRule({ modelId: 'video.seedance-2.5', operationCode: 'video.image_to_video', atMs: T });
  assert.equal(res.ok, true);
  assert.equal(res.rule.rule_id, 'pr-hit');
});

test('resolveRule：已过期窗口（effective_to < at）不命中', async () => {
  const pg = makePool([mkRule({ rule_id: 'pr-expired', effective_to: T - HOUR })]);
  const { resolveRule } = createPricingCalculator({ pg });
  const res = await resolveRule({ modelId: 'video.seedance-2.5', operationCode: 'video.image_to_video', atMs: T });
  assert.equal(res.ok, true);
  assert.equal(res.rule, null);
});

test('resolveRule：未来生效（effective_from > at）不命中', async () => {
  const pg = makePool([mkRule({ rule_id: 'pr-future', effective_from: T + HOUR })]);
  const { resolveRule } = createPricingCalculator({ pg });
  const res = await resolveRule({ modelId: 'video.seedance-2.5', operationCode: 'video.image_to_video', atMs: T });
  assert.equal(res.ok, true);
  assert.equal(res.rule, null);
});

test('resolveRule：effective_to 开区间上界（at == effective_to 不命中）', async () => {
  const pg = makePool([mkRule({ rule_id: 'pr-boundary', effective_from: T - HOUR, effective_to: T })]);
  const { resolveRule } = createPricingCalculator({ pg });
  const res = await resolveRule({ modelId: 'video.seedance-2.5', operationCode: 'video.image_to_video', atMs: T });
  assert.equal(res.rule, null, 'at == effective_to 属开区间上界，应不命中');
});

// ── resolveRule：版本优先 ────────────────────────────────────────────
test('resolveRule：同窗口多 ACTIVE 版本，取 rule_version 最新版', async () => {
  const pg = makePool([
    mkRule({ rule_id: 'pr-v1', rule_version: 1 }),
    mkRule({ rule_id: 'pr-v3', rule_version: 3, params: { amount: 300 } }),
    mkRule({ rule_id: 'pr-v2', rule_version: 2 }),
  ]);
  const { resolveRule } = createPricingCalculator({ pg });
  const res = await resolveRule({ modelId: 'video.seedance-2.5', operationCode: 'video.image_to_video', atMs: T });
  assert.equal(res.ok, true);
  assert.equal(res.rule.rule_id, 'pr-v3');
  assert.equal(res.rule.rule_version, 3);
});

test('resolveRule：非 ACTIVE（DEPRECATED）不命中，即便版本更新', async () => {
  const pg = makePool([
    mkRule({ rule_id: 'pr-active', rule_version: 1 }),
    mkRule({ rule_id: 'pr-dep', rule_version: 9, status: 'DEPRECATED' }),
  ]);
  const { resolveRule } = createPricingCalculator({ pg });
  const res = await resolveRule({ modelId: 'video.seedance-2.5', operationCode: 'video.image_to_video', atMs: T });
  assert.equal(res.rule.rule_id, 'pr-active');
});

test('resolveRule：无任何匹配返回 ok:true + rule:null（不抛错）', async () => {
  const pg = makePool([]);
  const { resolveRule } = createPricingCalculator({ pg });
  const res = await resolveRule({ modelId: 'video.seedance-2.5', operationCode: 'video.image_to_video', atMs: T });
  assert.equal(res.ok, true);
  assert.equal(res.rule, null);
});

test('resolveRule：缺 modelId/operationCode → INVALID_ARGUMENT', async () => {
  const pg = makePool([]);
  const { resolveRule } = createPricingCalculator({ pg });
  const res = await resolveRule({ modelId: '', operationCode: 'video.image_to_video', atMs: T });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_ARGUMENT');
});

test('resolveRule：无 pg → DB_UNAVAILABLE', async () => {
  const { resolveRule } = createPricingCalculator({ pg: null });
  const res = await resolveRule({ modelId: 'video.seedance-2.5', operationCode: 'video.image_to_video' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DB_UNAVAILABLE');
});

// ── calculate：四类可计算公式 ────────────────────────────────────────
test('calculate：fixed 固定价（与 usage 无关）', () => {
  const r = calculate({ rule: mkRule({ formula_kind: 'fixed', params: { amount: 100 } }), usage: { seconds: 999 } });
  assert.equal(r.computed, true);
  assert.equal(r.amount, 100);
});

test('calculate：rate_per_second 按秒计费', () => {
  const r = calculate({ rule: mkRule({ formula_kind: 'rate_per_second', params: { rate: 0.5 } }), usage: { seconds: 20 } });
  assert.equal(r.amount, 10); // 0.5 * 20
});

test('calculate：rate_per_frame 按帧计费', () => {
  const r = calculate({ rule: mkRule({ formula_kind: 'rate_per_frame', params: { rate: 0.02 } }), usage: { frames: 100 } });
  assert.equal(r.amount, 2); // 0.02 * 100
});

test('calculate：tiered 累计阶梯（含开放段 upTo=null）', () => {
  const rule = mkRule({
    formula_kind: 'tiered',
    params: {
      dimension: 'seconds',
      tiers: [{ upTo: 10, price: 1 }, { upTo: 20, price: 0.5 }, { upTo: null, price: 0.2 }],
    },
  });
  // 25s = 10*1 + 10*0.5 + 5*0.2 = 10 + 5 + 1 = 16
  const r = calculate({ rule, usage: { seconds: 25 } });
  assert.equal(r.amount, 16);
});

test('calculate：tiered 计量维度 units（白名单维度）', () => {
  const rule = mkRule({
    formula_kind: 'tiered',
    params: { dimension: 'units', tiers: [{ upTo: 5, price: 2 }, { upTo: null, price: 1 }] },
  });
  const r = calculate({ rule, usage: { units: 7 } });
  assert.equal(r.amount, 12); // 5*2 + 2*1
});

test('calculate：usage 缺省维度按 0 计（纯函数不抛）', () => {
  const r = calculate({ rule: mkRule({ formula_kind: 'rate_per_second', params: { rate: 0.5 } }), usage: {} });
  assert.equal(r.amount, 0);
});

// ── calculate：未知 formula_kind 拒绝 ────────────────────────────────
test('calculate：未知 formula_kind 拒绝（白名单，禁静默 fallback）', () => {
  assert.throws(
    () => calculate({ rule: mkRule({ formula_kind: 'eval', params: { code: '1+1' } }), usage: {} }),
    /未知 formula_kind 被拒/,
  );
});

test('calculate：非法 tiered 维度拒绝', () => {
  const rule = mkRule({ formula_kind: 'tiered', params: { dimension: '__proto__', tiers: [] } });
  assert.throws(() => calculate({ rule, usage: { seconds: 1 } }), /非法维度被拒/);
});

test('calculate：缺 rule 拒绝', () => {
  assert.throws(() => calculate({ rule: null }), /rule 必填/);
});

// ── calculate：custom_ref 仅引用禁执行 ───────────────────────────────
test('calculate：custom_ref 仅返回引用，不计算（computed:false / amount:null）', () => {
  const r = calculate({ rule: mkRule({ formula_kind: 'custom_ref', params: { ref: 'video.seedance2_5.v1' } }), usage: { seconds: 100 } });
  assert.equal(r.computed, false);
  assert.equal(r.amount, null);
  assert.equal(r.formulaKind, 'custom_ref');
  assert.equal(r.ref, 'video.seedance2_5.v1');
});

test('calculate：custom_ref 引用内容形似代码也只原样回传，绝不执行', () => {
  const evil = 'require("fs"); globalThis.__pwned=1; (()=>{})()';
  const r = calculate({ rule: mkRule({ formula_kind: 'custom_ref', params: { ref: evil } }), usage: { seconds: 1 } });
  assert.equal(r.computed, false);
  assert.equal(r.amount, null);
  assert.equal(r.ref, evil); // 原样回传字符串，未执行
  assert.equal(globalThis.__pwned, undefined, '引用字符串不得被 eval/require 执行');
});

// ── 白名单常量自检 ──────────────────────────────────────────────────
test('FORMULA_KINDS 白名单五值固定（版本化契约）', () => {
  assert.deepEqual([...FORMULA_KINDS], ['fixed', 'rate_per_second', 'rate_per_frame', 'tiered', 'custom_ref']);
});
