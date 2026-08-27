'use strict';
/**
 * M02-A AI Control Plane — Repository (DB access boundary)
 *
 * 复用现有 pg pool（不引 ORM、不改全项目 DB layer）。提供 control-plane 的
 * 读/写投影。安全：key 相关读法只经 keypool.keyMetadata 脱敏，完整 secret
 * 只在选择 credential 供 adapter 出站时使用（且不出现在任何 API/日志）。
 *
 * 演进现有表：providers / models / provider_model_bindings / api_keys +
 * 0010 新增列与 ai_routing_decisions / ai_provider_health。
 */

const keypool = require('../domain/keypool.cjs');
const { toBinding, validateBinding } = require('../domain/binding.cjs');
const { deriveHealth } = require('../domain/health.cjs');
const { validateCapability } = require('../domain/capability.cjs');

function logicalModel(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    model_id: row.model_id ?? null,
    display_name: row.display_name ?? null,
    type: row.type ?? null,
    enabled: row.enabled !== false,
    ai_capabilities: row.ai_capabilities ?? {},
    ai_parameter_schemas: row.ai_parameter_schemas ?? {},
    capability_version: Number.isFinite(row.capability_version) ? row.capability_version : 1,
    credit_cost: row.credit_cost != null ? Number(row.credit_cost) : null,
    provider_bindings: null, // 由 listLogicalModels 填充
  };
}

async function listProviders(pg) {
  const r = await pg.query('SELECT id, name, type, base_url, protocol, enabled, supported_types, capacity_model, api_key, created_at, updated_at FROM providers ORDER BY created_at');
  return (r.rows || []).map((p) => {
    const { api_key, ...rest } = p; // strip secret before projection
    return {
      ...rest,
      // providers.api_key 是 legacy 回退权威 —— 只暴露 masked，完整 secret 不出 repository
      credential: {
        has_legacy_key: !!(api_key && String(api_key).length >= 6),
        masked_legacy_key: keypool.maskKey(api_key),
      },
      key_pool_count: null, // 由 attachKeyPool 填充
    };
  });
}

async function getProvider(pg, providerId) {
  const r = await pg.query('SELECT * FROM providers WHERE id=$1', [providerId]);
  const row = r.rows && r.rows[0];
  if (!row) return null;
  return {
    id: row.id, name: row.name, type: row.type, base_url: row.base_url,
    protocol: row.protocol, enabled: row.enabled !== false,
    supported_types: row.supported_types || [], capacity_model: row.capacity_model,
    created_at: row.created_at, updated_at: row.updated_at,
    credential: {
      has_legacy_key: !!(row.api_key && String(row.api_key).length >= 6),
      masked_legacy_key: keypool.maskKey(row.api_key),
    },
    key_pool_count: null,
  };
}

async function attachKeyPool(pg, providers) {
  if (!providers || !providers.length) return providers;
  const ids = providers.map((p) => p.id);
  const kr = await pg.query(
    'SELECT id, provider_id, api_key, label, status, weight, rpm, concurrency, health, cooldown_until, last_used_at, last_error_code, created_at, updated_at FROM api_keys WHERE provider_id=ANY($1) ORDER BY provider_id, created_at',
    [ids],
  );
  const byProv = {};
  for (const row of kr.rows || []) {
    (byProv[row.provider_id] = byProv[row.provider_id] || []).push(keypool.keyMetadata(row));
  }
  for (const p of providers) {
    const keys = byProv[p.id] || [];
    p.key_pool = keys;
    p.key_pool_count = keys.length;
    p.active_key_count = keys.filter((k) => k.enabled).length;
  }
  return providers;
}

/** 逻辑模型目录（用户只选逻辑模型；bindings 作为其线路）。 */
async function listLogicalModels(pg, { includeBindings = true } = {}) {
  const mr = await pg.query('SELECT * FROM models WHERE enabled=true ORDER BY created_at');
  const models = (mr.rows || []).map(logicalModel);
  if (!models.length) return models;
  const modelIds = models.map((m) => m.model_id);
  if (includeBindings) {
    const br = await pg.query(
      'SELECT b.id, b.model_id, b.provider_id, b.upstream_model_name, b.enabled, b.priority, b.weight, m.endpoint, m.param_template, p.base_url, p.enabled AS p_enabled, p.name AS p_name FROM provider_model_bindings b LEFT JOIN models m ON m.model_id=b.model_id AND m.provider_id=b.provider_id AND m.enabled=true LEFT JOIN providers p ON p.id=b.provider_id WHERE b.model_id=ANY($1) AND b.enabled=true ORDER BY b.model_id, b.priority DESC, b.weight DESC',
      [modelIds],
    );
    const pr = await pg.query('SELECT id, name, base_url, enabled FROM providers WHERE id=ANY($1)', [...new Set((br.rows || []).map((x) => x.provider_id))]);
    const provById = new Map((pr.rows || []).map((x) => [x.id, x]));
    const byModel = {};
    for (const row of br.rows || []) {
      const binding = toBinding(row, row.endpoint ? { endpoint: row.endpoint, param_template: row.param_template } : {}, provById.get(row.provider_id) || {});
      if (binding) (byModel[row.model_id] = byModel[row.model_id] || []).push(binding);
    }
    for (const m of models) m.provider_bindings = byModel[m.model_id] || [];
  }
  return models;
}

async function getLogicalModel(pg, modelId) {
  const r = await pg.query('SELECT * FROM models WHERE model_id=$1', [modelId]);
  const row = r.rows && r.rows[0];
  if (!row) return null;
  const model = logicalModel(row);
  const br = await pg.query(
    'SELECT b.id, b.model_id, b.provider_id, b.upstream_model_name, b.enabled, b.priority, b.weight, m.endpoint, m.param_template, p.base_url, p.enabled AS p_enabled FROM provider_model_bindings b LEFT JOIN models m ON m.model_id=b.model_id AND m.provider_id=b.provider_id AND m.enabled=true LEFT JOIN providers p ON p.id=b.provider_id WHERE b.model_id=$1 AND b.enabled=true ORDER BY b.priority DESC, b.weight DESC',
    [modelId],
  );
  model.provider_bindings = (br.rows || []).map((x) => toBinding(x, x.endpoint ? { endpoint: x.endpoint, param_template: x.param_template } : {}, {}));
  return model;
}

/** 校验并写入逻辑模型能力（入库前 domain 校验；失败抛错，不静默）。 */
async function upsertModelCapability(pg, modelId, capabilityDoc, { version = 1 } = {}) {
  const check = validateCapability(capabilityDoc);
  if (!check.ok) throw new Error('capability 校验失败: ' + check.errors.join('; '));
  const r = await pg.query(
    `UPDATE models SET ai_capabilities=$2, ai_parameter_schemas=COALESCE($3, ai_parameter_schemas), capability_version=$4, updated_at=NOW()
       WHERE model_id=$1 RETURNING model_id, capability_version`,
    [modelId, JSON.stringify(capabilityDoc || {}), JSON.stringify((capabilityDoc || {}).parameter_schema || {}), version],
  );
  return (r.rows && r.rows[0]) || null;
}

async function recordRoutingDecision(pg, decision, { requestId, generationTaskId } = {}) {
  const r = await pg.query(
    `INSERT INTO ai_routing_decisions (id, model_id, capability, region, selected_binding_id, selected_provider_id, reason, fallback_candidates, rejected, weights, seed, request_id, generation_task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, created_at`,
    [
      decision.routing_decision_id, decision.model_id, decision.capability, decision.region,
      decision.selected ? decision.selected.bindingId : null,
      decision.selected ? decision.selected.providerId : null,
      decision.reason,
      JSON.stringify(decision.fallback_candidates || []),
      JSON.stringify(decision.rejected || []),
      decision.weights ? JSON.stringify(decision.weights) : null,
      decision.seed, requestId || null, generationTaskId || null,
    ],
  );
  return (r.rows && r.rows[0]) || { id: decision.routing_decision_id };
}

async function upsertProviderHealth(pg, providerId, signals) {
  const { state, reasons } = deriveHealth(signals);
  await pg.query(
    `INSERT INTO ai_provider_health (provider_id, state, reasons, circuit_state, success_rate, p95_latency_ms, rate_limited, key_availability, consecutive_failures, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (provider_id) DO UPDATE SET
       state=EXCLUDED.state, reasons=EXCLUDED.reasons, circuit_state=EXCLUDED.circuit_state,
       success_rate=EXCLUDED.success_rate, p95_latency_ms=EXCLUDED.p95_latency_ms,
       rate_limited=EXCLUDED.rate_limited, key_availability=EXCLUDED.key_availability,
       consecutive_failures=EXCLUDED.consecutive_failures, updated_at=NOW()`,
    [
      providerId, state, JSON.stringify(reasons), signals.circuit || null,
      typeof signals.successRate === 'number' ? signals.successRate : null,
      typeof signals.p95LatencyMs === 'number' ? signals.p95LatencyMs : null,
      signals.rateLimited == null ? null : !!signals.rateLimited,
      typeof signals.keyAvailability === 'number' ? signals.keyAvailability : null,
      signals.consecutiveFailures || 0,
    ],
  );
  return { provider_id: providerId, state, reasons };
}

async function getProviderHealth(pg, providerId) {
  const r = await pg.query('SELECT * FROM ai_provider_health WHERE provider_id=$1', [providerId]);
  return (r.rows && r.rows[0]) || null;
}

module.exports = {
  listProviders, getProvider, attachKeyPool,
  listLogicalModels, getLogicalModel, upsertModelCapability,
  recordRoutingDecision, upsertProviderHealth, getProviderHealth,
  keypool, toBinding, validateBinding,
};
