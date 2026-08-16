'use strict';
// 智能体文本推理模型统一解析：
// 1) per-agent 显式 setting（如 promptOptimizeModel / promptTranslateModel / styleAuditModel）
// 2) agent_providers 映射
// 3) settings.app.fallbackModel 全局兜底模型
// 4) 所有启用的 type=text 模型（按成本）
//
// 让所有调用方共享同一优先级，避免各处逻辑分叉。

const COLS = "m.id AS m_id, m.model_id, m.display_name, m.credit_cost, p.id AS p_id, p.base_url, p.api_key, p.protocol ";
const GUARD = "m.enabled=true AND p.enabled=true AND p.api_key IS NOT NULL AND LENGTH(p.api_key) >= 6 ";

async function loadAppSettings(pg) {
  try {
    const r = await pg.query("SELECT value FROM settings WHERE key='app'");
    return (r.rows[0] && r.rows[0].value) || {};
  } catch (_) { return {}; }
}

async function pushModelById(pg, candidates, modelId) {
  if (!modelId) return;
  const r = await pg.query(
    `SELECT ${COLS}FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id=$1 AND ${GUARD}`,
    [String(modelId)]
  );
  if (r.rows.length) candidates.push(r.rows[0]);
}

async function pushAgentProviders(pg, candidates, agentKey) {
  if (!agentKey) return;
  const r = await pg.query(
    `SELECT ${COLS}FROM agent_providers ap JOIN models m ON m.id = ap.model
     JOIN providers p ON p.id = m.provider_id
     WHERE ap.agent_key=$1 AND ap.enabled=true AND ${GUARD}
     ORDER BY ap.priority ASC, ap.weight DESC, m.credit_cost ASC`,
    [agentKey]
  );
  for (const row of r.rows) candidates.push(row);
}

async function pushAnyTextModel(pg, candidates) {
  const r = await pg.query(
    `SELECT ${COLS}FROM models m JOIN providers p ON p.id = m.provider_id
     WHERE m.type='text' AND ${GUARD}
     ORDER BY (p.base_url LIKE '%agnes-ai.com%') ASC, m.credit_cost ASC, m.id ASC`
  );
  for (const row of r.rows) candidates.push(row);
}

async function resolveTextCandidates(pg, agentKey, explicitSettingKey) {
  const settings = await loadAppSettings(pg);
  const candidates = [];

  // 1) 后台显式指定的 per-agent 模型
  if (explicitSettingKey && settings[explicitSettingKey]) {
    await pushModelById(pg, candidates, String(settings[explicitSettingKey]));
  }

  // 2) 智能体专属 agent_providers
  if (candidates.length === 0) {
    await pushAgentProviders(pg, candidates, agentKey);
  }

  // 3) 全局兜底模型 fallbackModel
  if (candidates.length === 0 && settings.fallbackModel) {
    await pushModelById(pg, candidates, String(settings.fallbackModel));
  }

  // 4) 回退：所有启用的 text 模型
  if (candidates.length === 0) {
    await pushAnyTextModel(pg, candidates);
  }

  return candidates;
}

module.exports = { resolveTextCandidates };
