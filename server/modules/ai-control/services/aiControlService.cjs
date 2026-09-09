'use strict';
/**
 * M02-A/C AI Control Plane — Service (API projection boundary)
 *
 * 把 repository 的领域投影变成 API response。安全铁律在此强制：
 *  - 任何 key 相关字段只出 masked/fingerprint；完整 secret 永不进入 response。
 *  - provider cost / margin 仅 admin projection；普通用户只拿 platform price / credits。
 *  - admin 端点与 internal（机器对机器）端点分开设计，权限由调用方（server 中间件）保证。
 *
 * 本 service 不直接碰 req/res —— 纯函数 + repository 依赖注入，便于单测。
 *
 * M02-C 新增：
 *  - 模型 revision 管理（publish/retire/list）
 *  - 能力授权检查（grant CRUD + entitlement resolution）
 *  - 路由策略管理（create/update/list）
 */

const repo = require('../repositories/aiControlRepository.cjs');
const keypool = require('../domain/keypool.cjs');
const pricing = require('../domain/pricing.cjs');
const { toRoutingDecision } = require('../domain/routing.cjs');
const grantDomain = require('../domain/grant.cjs');
const routingPolicyDomain = require('../domain/routing-policy.cjs');

function isViewerAdmin(viewer) {
  return !!(viewer && viewer.role === 'admin');
}

/** GET providers（admin/internal）。返回 masked key 池 + 计数。 */
async function listProvidersForAdmin(pg) {
  const providers = await repo.listProviders(pg);
  await repo.attachKeyPool(pg, providers);
  return providers.map((p) => keypool.redactCredentialFields(p));
}

/** GET provider/:id */
async function getProviderForAdmin(pg, providerId) {
  const p = await repo.getProvider(pg, providerId);
  if (!p) return null;
  await repo.attachKeyPool(pg, [p]);
  return keypool.redactCredentialFields(p);
}

function inferredCapability(model) {
  const doc = (model.ai_capabilities && Object.keys(model.ai_capabilities).length)
    ? model.ai_capabilities
    : {};
  if (doc.type) return doc;
  const type = model.type === 'image'
    ? 'text_to_image'
    : model.type === 'video'
      ? 'text_to_video'
      : model.type === 'text'
        ? 'text_generation'
        : '';
  return type ? { ...doc, type, capabilities: { ...(doc.capabilities || {}), [type]: true } } : doc;
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
    capabilities: inferredCapability(m),
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
    })),
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
    capabilities: inferredCapability(m),
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
      type: m.ai_capabilities.type || m.type,
      content_type: m.type,
      capabilities: m.ai_capabilities.capabilities || {},
      parameter_schema: m.ai_capabilities.parameter_schema || m.ai_parameter_schemas || {},
      pricing_dimensions: m.ai_capabilities.pricing_dimensions || null,
      version: m.capability_version,
    }));
}

/**
 * 生成报价。
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

// ── M02-C: Model Revisions ───────────────────────────────────────────────────

/**
 * 发布模型 revision。
 * @param {object} pg
 * @param {string} modelId
 * @param {object} manifest  要发布的 manifest（含 capabilities、parameter_schema 等）
 * @param {string} actor     当前操作者 ID
 * @returns {object} 发布的 revision 对象
 */
async function publishModelRevision(pg, modelId, manifest, actor) {
  return repo.publishRevision(pg, modelId, manifest, actor);
}

/**
 * 获取模型的活跃 revision。
 */
async function getActiveModelRevision(pg, modelId) {
  return repo.getActiveRevision(pg, modelId);
}

/**
 * 列出模型的所有 revision。
 */
async function listModelRevisions(pg, modelId) {
  return repo.listModelRevisions(pg, modelId);
}

/**
 * 退役某 revision。
 */
async function retireModelRevision(pg, revisionId) {
  return repo.retireRevision(pg, revisionId);
}

// ── M02-C: Capability Grants ─────────────────────────────────────────────────

/**
 * 检查某用户/workspace 对某模型是否有某能力的授权。
 * @param {object} pg
 * @param {string} modelId
 * @param {object} checker { userId?, workspaceId? }
 * @returns {boolean}
 */
async function checkModelEntitlement(pg, modelId, checker = {}) {
  const grants = await repo.listGrantsForModel(pg, modelId);
  return grantDomain.hasCapability(grants, checker);
}

/**
 * 列出某模型的所有授权。
 */
async function listModelGrants(pg, modelId) {
  return repo.listGrantsForModel(pg, modelId);
}

/**
 * 创建授权。
 */
async function createModelGrant(pg, grantInput, actor) {
  return repo.createGrant(pg, grantInput, actor);
}

/**
 * 撤销授权。
 */
async function revokeModelGrant(pg, grantId) {
  return repo.revokeGrant(pg, grantId);
}

/**
 * 删除授权。
 */
async function deleteModelGrant(pg, grantId) {
  return repo.deleteGrant(pg, grantId);
}

// ── M02-C: Routing Policies ──────────────────────────────────────────────────

/**
 * 创建路由策略。
 */
async function createRoutingPolicy(pg, policyInput, actor) {
  return repo.createRoutingPolicy(pg, policyInput, actor);
}

/**
 * 更新路由策略。
 */
async function updateRoutingPolicy(pg, policyId, patch, actor) {
  return repo.updateRoutingPolicy(pg, policyId, patch, actor);
}

/**
 * 列出某模型的路由策略。
 */
async function listRoutingPolicies(pg, modelId) {
  return repo.listRoutingPolicies(pg, modelId);
}

/**
 * 解析路由决策（结合 DB 中的 canary policy）。
 * @param {object} pg
 * @param {string} modelId
 * @param {string} capability
 * @param {string} bindingId  用户请求的目标 binding
 * @param {number} seed       请求随机种子
 * @returns {{selected: string|null, policyId: string|null}}
 */
async function resolveRouting(pg, modelId, capability, bindingId, seed) {
  const policies = await repo.listRoutingPolicies(pg, modelId);
  const activePolicies = policies.filter((p) => p.status === 'active');
  const result = routingPolicyDomain.resolveRouting(activePolicies, modelId, capability, seed);
  if (result) {
    return { selected: result.bindingId, policyId: result.policyId };
  }
  // No policy or not in canary → return the requested binding
  return { selected: bindingId, policyId: null };
}

/**
 * 记录带 revision 绑定的路由决策。
 */
async function recordRoutingWithRevision(pg, decision, { requestId, generationTaskId, modelRevisionId, routingPolicyId } = {}) {
  return repo.recordRoutingDecisionWithRevision(pg, decision, { requestId, generationTaskId, modelRevisionId, routingPolicyId });
}

module.exports = {
  isViewerAdmin,
  listProvidersForAdmin, getProviderForAdmin,
  listModelsForUser, getModelForUser, listCapabilities,
  quoteForViewer, recordRouting,
  // M02-C: Revisions
  publishModelRevision, getActiveModelRevision, listModelRevisions, retireModelRevision,
  // M02-C: Grants
  checkModelEntitlement, listModelGrants, createModelGrant, revokeModelGrant, deleteModelGrant,
  // M02-C: Routing Policies
  createRoutingPolicy, updateRoutingPolicy, listRoutingPolicies, resolveRouting,
  // M02-C: Decisions with revision
  recordRoutingWithRevision,
};
