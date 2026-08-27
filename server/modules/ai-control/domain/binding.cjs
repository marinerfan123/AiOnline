'use strict';
/**
 * M02-A AI Control Plane — Provider Binding Domain
 *
 * 逻辑模型 × 服务商 的一条「线路」。一个 logical model_id 允许 N 个 binding。
 * 用户只选 logical model；routing engine 决定实际 binding。
 *
 * 本模块是 binding 行的【领域投影 + 校验】，直接演进现有 provider_model_bindings 表
 * （不新建平行表）。字段：logical_model_id(provider_model_bindings.model_id) / provider_id /
 * upstream_model_name(provider code) / enabled / priority / weight + capability overrides +
 * binding-specific parameters（来自 models 行 provider 特定列 + provider_model_costs）。
 */

/**
 * 校验一份 binding 候选（入库前 / 解析时）。
 * @param {object} b
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
function validateBinding(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return { ok: false, errors: ['binding 必须是对象'] };
  if (!b.logical_model_id) errors.push('缺少 logical_model_id');
  if (!b.provider_id) errors.push('缺少 provider_id');
  if (b.provider_model_code != null && typeof b.provider_model_code !== 'string') errors.push('provider_model_code 必须是字符串');
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') errors.push('enabled 必须是 boolean');
  if (b.priority !== undefined && !Number.isInteger(b.priority)) errors.push('priority 必须是整数');
  if (b.weight !== undefined && !Number.isFinite(b.weight)) errors.push('weight 必须是数');
  if (b.region !== undefined && typeof b.region !== 'string') errors.push('region 必须是字符串');
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * 把 provider_model_bindings 原始行 + 关联 models/provider 行 投影成领域 Binding。
 * @param {object} row      provider_model_bindings 行（model_id, provider_id, upstream_model_name, enabled, priority, weight）
 * @param {object} [model]  models 行（provider 特定 endpoint/capabilities/param_template）
 * @param {object} [provider] providers 行（base_url, enabled, ...）
 * @returns {object}
 */
function toBinding(row, model = {}, provider = {}) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    logical_model_id: row.model_id ?? null,
    provider_id: row.provider_id ?? null,
    provider_model_code: row.upstream_model_name || row.model_id || null,
    enabled: row.enabled !== false,
    priority: Number.isFinite(row.priority) ? row.priority : 0,
    weight: Number.isFinite(row.weight) ? row.weight : 0,
    // binding-specific parameters（透传 provider 特定模型配置）
    parameter_overrides: model.param_template ?? null,
    endpoint: model.endpoint ?? null,
    // provider 连通信息（masked 由上层 keypool 负责，这里不带 secret）
    base_url: provider.base_url ?? null,
    provider_enabled: provider.enabled !== false,
    legacy_fallback: row.id ? false : true, // 无 binding 行（models.provider_id 单绑定回退）→ legacy
  };
}

module.exports = { validateBinding, toBinding };
