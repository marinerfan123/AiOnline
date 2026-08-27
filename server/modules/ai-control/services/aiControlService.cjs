'use strict';
/**
 * M02-A AI Control Plane — Service (API projection boundary)
 *
 * 把 repository 的领域投影变成 API response。安全铁律在此强制：
 *  - 任何 key 相关字段只出 masked/fingerprint；完整 secret 永不进入 response。
 *  - provider cost / margin 仅 admin projection；普通用户只拿 platform price / credits。
 *  - admin 端点与 internal（机器对机器）端点分开设计，权限由调用方（server 中间件）保证。
 *
 * 本 service 不直接碰 req/res —— 纯函数 + repository 依赖注入，便于单测。
 */

const repo = require('../repositories/aiControlRepository.cjs');
const keypool = require('../domain/keypool.cjs');
const pricing = require('../domain/pricing.cjs');
const { toRoutingDecision } = require('../domain/routing.cjs');

function isViewerAdmin(viewer) {
  return !!(viewer && viewer.role === 'admin');
}

/** GET providers（admin/internal）。返回 masked key 池 + 计数。 */
async function listProvidersForAdmin(pg) {
  const providers = await repo.listProviders(pg);
  await repo.attachKeyPool(pg, providers);
  // 双重保险：redact 任何意外泄漏的 secret 字段
  return providers.map((p) => keypool.redactCredentialFields(p));
}

/** GET provider/:id */
async function getProviderForAdmin(pg, providerId) {
  const p = await repo.getProvider(pg, providerId);
  if (!p) return null;
  await repo.attachKeyPool(pg, [p]);
  return keypool.redactCredentialFields(p);
}

/** GET models（逻辑模型目录；用户可见，不含 provider cost）。 */
async function listModelsForUser(pg, viewer) {
  const models = await repo.listLogicalModels(pg, { includeBindings: true });
  const admin = isViewerAdmin(viewer);
  return models.map((m) => ({
    model_id: m.model_id,
    display_name: m.display_name,
    type: m.type,
    enabled: m.enabled,
    capabilities: m.ai_capabilities || {},
    capability_version: m.capability_version,
    parameter_schema: m.ai_parameter_schemas || {},
    credit_cost: m.credit_cost,
    // 用户可见：线路的“数量与 provider 名”，不含逐线路成本
    bindings: (m.provider_bindings || []).map((b) => ({
      binding_id: b.id,
      provider_id: b.provider_id,
      provider_model_code: b.provider_model_code,
      enabled: b.enabled,
      priority: b.priority,
      weight: b.weight,
      legacy_fallback: b.legacy_fallback,
    })),
    // admin 额外可见逐线路成本来源（不含原始 cost 数字本身，数字走 quote 接口）
    ...(admin ? { has_pricing_rules: true } : {}),
  }));
}

/** GET model/:id 详情（admin 可见逐线路 binding 参数；用户不可）。 */
async function getModelForUser(pg, modelId, viewer) {
  const m = await repo.getLogicalModel(pg, modelId);
  if (!m) return null;
  const admin = isViewerAdmin(viewer);
  return {
    model_id: m.model_id,
    display_name: m.display_name,
    type: m.type,
    enabled: m.enabled,
    capabilities: m.ai_capabilities || {},
    capability_version: m.capability_version,
    parameter_schema: m.ai_parameter_schemas || {},
    credit_cost: m.credit_cost,
    bindings: (m.provider_bindings || []).map((b) => ({
      binding_id: b.id,
      provider_id: b.provider_id,
      provider_model_code: b.provider_model_code,
      enabled: b.enabled,
      priority: b.priority,
      weight: b.weight,
      legacy_fallback: b.legacy_fallback,
      // binding 特定参数仅 admin 可见（endpoint/param 模板可能含敏感配置）
      ...(admin ? { parameter_overrides: b.parameter_overrides, endpoint: b.endpoint, base_url: b.base_url } : {}),
    })),
  };
}

/** GET capabilities（结构化能力目录；machine-readable）。 */
async function listCapabilities(pg) {
  const models = await repo.listLogicalModels(pg, { includeBindings: false });
  return models
    .filter((m) => m.ai_capabilities && Object.keys(m.ai_capabilities).length)
    .map((m) => ({
      model_id: m.model_id,
      // type 取自 capability doc（如 text_to_video），不是 models.type 内容类型列（如 video）
      type: m.ai_capabilities.type || m.type,
      content_type: m.type,
      capabilities: m.ai_capabilities.capabilities || {},
      parameter_schema: m.ai_capabilities.parameter_schema || m.ai_parameter_schemas || {},
      pricing_dimensions: m.ai_capabilities.pricing_dimensions || null,
      version: m.capability_version,
    }));
}

/**
 * 生成报价。输入为原始价格数字（providerCost/platformPrice/currency/...），
 * 内部先构造完整报价，普通用户拿 user projection（剥离成本/margin），
 * admin 拿完整（含 provider cost）。两条路径对同一输入。
 * @param {object} viewer  { role }
 * @param {object} q  { providerCost, platformPrice, currency, pricingRuleId, pricingSource }
 */
function quoteForViewer(viewer, q) {
  const full = pricing.quoteGeneration(q);
  return isViewerAdmin(viewer) ? full : pricing.quoteForUser(full);
}

/**
 * 路由决策审计（internal）。接受 modelhub/router.routeBindings 的原始结果，
 * 规范化为 toRoutingDecision 并落库，返回审计记录。
 */
async function recordRouting(pg, routeResult, ctx, { requestId, generationTaskId } = {}) {
  const decision = toRoutingDecision(routeResult, ctx);
  await repo.recordRoutingDecision(pg, decision, { requestId, generationTaskId });
  return decision;
}

module.exports = {
  isViewerAdmin,
  listProvidersForAdmin, getProviderForAdmin,
  listModelsForUser, getModelForUser, listCapabilities,
  quoteForViewer, recordRouting,
};
