'use strict';
/**
 * M02-A AI Control Plane — Pricing Boundary
 *
 * 严格区分四层，禁止把供应商成本当用户售价：
 *   Provider Cost      — 供应商对我方的真实成本（逐线路 binding，per provider_model_costs）
 *   Platform Sell Price — 平台对外的定价（model_pricing / models.credit_cost）
 *   Credits            — 用户账上的积分消耗（= Platform Sell Price 的积分表示）
 *   Margin             — 售价 − 成本
 *
 * quoteGeneration() 返回【估算报价】，供计费预留/展示。provider cost 仅 admin 可见，
 * 普通用户接口的 projection 通过 quoteForUser() 剥离成本与 margin。
 *
 * 本模块为纯函数：输入价格数字，输出报价对象。数据读取由 repository 负责（双读链见 accounting.cjs）。
 */

/**
 * @param {object} p
 *   - providerCost: number         估算供应商成本（元/CNY 或内部单位）
 *   - platformPrice: number        平台售价（积分或元，按 currency）
 *   - currency: string             'CNY' | 'credits' | ...
 *   - pricingRuleId: string|null   命中的价格规则（model_pricing / models / rate）
 *   - pricingSource: string        'model_pricing'|'model_price_history'|'models'|'default'
 * @returns {object} 完整报价（含成本，仅 admin）
 */
function quoteGeneration(p = {}) {
  const providerCost = Number(p.providerCost) || 0;
  const platformPrice = Number(p.platformPrice) || 0;
  return {
    estimated_provider_cost: providerCost,
    estimated_platform_price: platformPrice,
    estimated_credits: platformPrice, // 积分表示当前等于平台售价（credit_price）
    margin: Math.max(0, platformPrice - providerCost),
    currency: p.currency || 'CNY',
    pricing_rule_id: p.pricingRuleId ?? null,
    pricing_source: p.pricingSource || 'default',
  };
}

/**
 * 普通用户可见报价：剥离 provider cost 与 margin（商业敏感）。
 * @param {object} q  quoteGeneration 的输出
 * @returns {object}
 */
function quoteForUser(q) {
  if (!q) return null;
  return {
    estimated_platform_price: q.estimated_platform_price,
    estimated_credits: q.estimated_credits,
    currency: q.currency,
    pricing_rule_id: q.pricing_rule_id,
    pricing_source: q.pricing_source,
    // 故意不含 estimated_provider_cost / margin
  };
}

/** admin 才能看成本的断言（服务层用它决定 projection）。 */
function assertAdminProjection(viewer, q) {
  if (!viewer || viewer.role !== 'admin') return quoteForUser(q);
  return q;
}

module.exports = { quoteGeneration, quoteForUser, assertAdminProjection };
