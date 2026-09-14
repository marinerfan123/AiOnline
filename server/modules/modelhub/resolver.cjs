'use strict';
/**
 * ModelHub V3 — Phase 1 唯一模型身份 resolver。
 *
 * 职责：把"任意来源的身份字符串"（model_id / display_name / 遗留 model 字符串）
 * 收敛为 canonical model_id 数组，作为生成全链路（generate → billing → dispatcher）
 * 唯一可信标识。displayName 自此仅作为 UI 展示字段，不再参与路由身份判定。
 *
 * 规则：
 *  1) model_id 精确匹配（canonical，优先）；
 *  2) display_name 兼容回退（旧客户端 / 遗留孤儿任务）；
 *  3) 仍未命中：原样返回输入，交由下游（dispatcher 的 enabled 过滤 / server 的 400 校验）裁决。
 *
 * 设计约束（来自 Phase 1 禁止项）：
 *  - 不引入 Redis、不改路由算法、不改 pricing、不拆表、不大规模重构 server.js。
 *  - 本模块是 dispatcher / server 内"散落 display_name 处理"的唯一收敛点。
 */

/**
 * 解析模型身份。
 * @param {object} pgPool  pg 连接池（必须可提供 .query）
 * @param {string|string[]} raw  用户输入（model_id / display_name / 混合 / 数组）
 * @returns {Promise<string[]>} canonical model_id 数组（去重，按出现序）
 */
async function resolveModelIdentity(pgPool, raw) {
  // 规范化输入为字符串数组
  let inputs = Array.isArray(raw)
    ? raw.filter(Boolean)
    : (raw ? [raw] : []);
  inputs = [...new Set(inputs.map(String))];
  if (inputs.length === 0) return [];

  // 无 DB 时不尝试查询，原样回退（调用方应自行处理缺失 DB 的情况）
  if (!pgPool || typeof pgPool.query !== 'function') return [...inputs];

  try {
    // 1) model_id 精确匹配（canonical，优先）
    const r = await pgPool.query(
      'SELECT DISTINCT model_id FROM models WHERE model_id = ANY($1) AND enabled = true',
      [inputs],
    );
    const byModelId = new Set((r.rows || []).map((x) => x.model_id).filter(Boolean));

    // 2) 未命中 model_id 的输入，按 display_name 兼容回退（旧客户端 / 遗留孤儿任务）
    const remaining = inputs.filter((i) => !byModelId.has(i));
    let byDisplayName = new Set();
    if (remaining.length) {
      const r2 = await pgPool.query(
        'SELECT DISTINCT model_id FROM models WHERE display_name = ANY($1) AND enabled = true',
        [remaining],
      );
      byDisplayName = new Set((r2.rows || []).map((x) => x.model_id).filter(Boolean));
    }

    const ids = [...new Set([...byModelId, ...byDisplayName])];
    if (ids.length) return ids;

    // 3) 兜底：输入本身即合法 model_id（可能 disabled / 历史 / 未命中），返回原值避免硬失败
    return [...inputs];
  } catch (e) {
    console.warn('[modelhub resolver] resolveModelIdentity 失败:', e && e.message);
    return [...inputs];
  }
}

/**
 * 取 model_id 对应的展示名（display_name 优先，缺省 model_id）。
 * 用于恢复链 / 展示兜底，不参与路由。
 * @param {object} pgPool
 * @param {string} modelId
 * @returns {Promise<string>}
 */
async function getDisplayNameForModelId(pgPool, modelId) {
  if (!modelId) return '';
  if (!pgPool || typeof pgPool.query !== 'function') return modelId;
  try {
    const r = await pgPool.query(
      'SELECT display_name, model_id FROM models WHERE model_id=$1 LIMIT 1',
      [modelId],
    );
    const row = r.rows && r.rows[0];
    if (row) return row.display_name || row.model_id || modelId;
  } catch (_) { /* 忽略：返回原值 */ }
  return modelId;
}

module.exports = { resolveModelIdentity, getDisplayNameForModelId };
