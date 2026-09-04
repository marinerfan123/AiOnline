'use strict';
/**
 * ModelHub V3 Phase 2 — Provider Model Bindings 读取层
 *
 * 职责：把「逻辑模型 model_id」展开为一组可用的「模型行 × 服务商」配对（pairs），
 *       供 dispatcher.generate 的 round-robin 调度使用。
 *
 * 数据来源（双读兼容，零 DELETE）：
 *   1. 优先读 provider_model_bindings：每行 = (model_id, provider_id, upstream_model_name)。
 *      —— 上游真实模型名（wire name）取自 upstream_model_name，而非 model_id 本身。
 *   2. 若某 model_id 在 bindings 中没有任何绑定（迁移中途 / 旧数据未回填 / 新模型尚未配绑定），
 *      回退到旧 models.provider_id 单绑定，upstream_model_name 取 model_id（= 现状行为）。
 *
 * 重要约束（来自迁移铁律 + Phase 1 禁令）：
 *   - 绝不 DROP / 改 models 旧列；旧 models.provider_id 仍被本模块的 fallback 与崩溃恢复链路读取。
 *   - 不改变路由算法（round-robin 由 dispatcher 负责）；本模块只产出 pairs，不排序（priority/weight 仅透传供 Phase 3）。
 *   - model_id 始终保留在 model 行上，供账务归因（canonical）与视频适配器的家族/能力判定使用；
 *     仅「上游 wire name」改用 model.upstreamModelName。
 */

/**
 * 加载某批 model_id 对应的可用 (模型行 × 服务商) 配对。
 * @param {object} pgPool      PG 连接池
 * @param {string[]} modelIds  已归一化的 canonical model_id 数组（来自 resolver）
 * @param {string} [contentType] 'image' | 'video' | undefined（预留，当前不影响配对）
 * @returns {Promise<Array<{model:object, provider:object, bindingId:string}>>}  bindingId = provider_model_bindings.id（线路主键；legacy fallback 为空串）
 */
async function loadDispatchPairs(pgPool, modelIds, contentType) {
  if (!pgPool || !Array.isArray(modelIds) || modelIds.length === 0) return [];
  try {
  // 1) 读取这批 model_id 的绑定（仅启用）
  const bRes = await pgPool.query(
    `SELECT id, model_id, provider_id, upstream_model_name, enabled, priority, weight
       FROM provider_model_bindings
      WHERE model_id = ANY($1) AND enabled = true`,
    [modelIds],
  );
  const bindings = bRes.rows || [];
  const modelIdsWithBindings = new Set(bindings.map((b) => b.model_id));

  // 2) 没有绑定的 model_id → 标记走 legacy fallback（读 models.provider_id）
  const fallbackModelIds = modelIds.filter((id) => !modelIdsWithBindings.has(id));

  // 组装目标 (model_id, provider_id) 列表，准备加载 provider 特定的模型行
  const targets = bindings.map((b) => ({
    bindingId: b.id || '', // provider_model_bindings.id 即「线路」主键，供账务逐线路成本归因
    model_id: b.model_id,
    provider_id: b.provider_id,
    upstream_model_name: (b.upstream_model_name && b.upstream_model_name.length)
      ? b.upstream_model_name
      : b.model_id, // 上游名为空时回退 model_id（等价现状）
    priority: b.priority || 0,
    weight: b.weight || 0,
  }));

  if (fallbackModelIds.length) {
    const fRes = await pgPool.query(
      `SELECT model_id, provider_id
         FROM models
        WHERE model_id = ANY($1) AND enabled = true AND provider_id IS NOT NULL AND provider_id <> ''`,
      [fallbackModelIds],
    );
    for (const r of fRes.rows || []) {
      targets.push({
        bindingId: '', // legacy fallback：无绑定行，账单走 (provider,model) 率（旧路径不变）
        model_id: r.model_id,
        provider_id: r.provider_id,
        upstream_model_name: r.model_id, // legacy：wire name 即 model_id（现状）
        priority: 0,
        weight: 0,
      });
    }
  }

  if (targets.length === 0) return [];

  // 3) 加载涉及的模型行（按 model_id，保留 provider 特定配置：endpoint/capabilities/param_template/...）
  const rowModelIds = [...new Set(targets.map((t) => t.model_id))];
  const mRes = await pgPool.query(
    `SELECT * FROM models WHERE model_id = ANY($1) AND enabled = true
      ORDER BY model_id ASC, provider_id ASC, id ASC`,
    [rowModelIds],
  );
  // key = model_id|provider_id → 行（同组合多行取首个，保持确定性）
  const modelRowByCombo = new Map();
  // key = model_id → 行（canonical 兜底：binding 可指向非模型主 provider，
  // 此时组合键命中不到模型行，须按 model_id 回退到该模型的 canonical 行，否则多 provider 线路被静默丢弃）
  const modelRowByModelId = new Map();
  for (const mr of mRes.rows || []) {
    const key = `${mr.model_id}|${mr.provider_id}`;
    if (!modelRowByCombo.has(key)) modelRowByCombo.set(key, mr);
    if (!modelRowByModelId.has(mr.model_id)) modelRowByModelId.set(mr.model_id, mr);
  }

  // 4) 加载涉及的服务商行
  const neededProviderIds = [...new Set(targets.map((t) => t.provider_id))];
  const pRes = await pgPool.query(
    `SELECT * FROM providers WHERE id = ANY($1)`,
    [neededProviderIds],
  );
  const kRes = await pgPool.query(
    `SELECT * FROM api_keys WHERE provider_id = ANY($1)`,
    [neededProviderIds],
  );
  const keysByProvider = new Map();
  for (const r of kRes.rows || []) {
    if (!keysByProvider.has(r.provider_id)) keysByProvider.set(r.provider_id, []);
    keysByProvider.get(r.provider_id).push(r);
  }
  const providerById = new Map();
  for (const pr of pRes.rows || []) {
    pr.__apiKeys = keysByProvider.get(pr.id) || []; // 附带 key 池原始行，供 dispatcher 对账运行时态
    providerById.set(pr.id, pr);
  }

  // 5) 组装 pairs（过滤：服务商启用 + 有可用 key）
  //    可用 key = 老列 providers.api_key（legacy fallback） OR 池中至少一把 active 且长度≥6 的 key
  const pairs = [];
  for (const t of targets) {
    const mr = modelRowByCombo.get(`${t.model_id}|${t.provider_id}`) || modelRowByModelId.get(t.model_id);
    const pr = providerById.get(t.provider_id);
    if (!mr || !pr) continue;                       // 模型行或服务商缺失 → 跳过
    if (!pr.enabled) continue;                      // 服务商未启用
    const poolKeys = (pr.__apiKeys || []);
    const activePoolKeys = poolKeys.filter((k) => (k.status || 'active') === 'active' && (k.api_key || '').length >= 6);
    const hasKey = (pr.api_key && pr.api_key.length >= 6) || activePoolKeys.length > 0;
    if (!hasKey) continue;                          // 无任何可用密钥
    // 克隆模型行并注入上游 wire name（model_id 原样保留供账务/能力判定）
    const model = {
      ...mr,
      upstreamModelName: t.upstream_model_name,
      bindingPriority: t.priority,
      bindingWeight: t.weight,
    };
    pairs.push({ model, provider: pr, bindingId: t.bindingId || '' });
  }

  return pairs;
  } catch (e) {
    // 任一查询失败（DB 抖动/连接中断）→ 优雅降级：返回空 pairs，
    // 由 dispatcher.generate 统一报「没有可用的已启用服务商」，不向上抛异常中断请求。
    return [];
  }
}

module.exports = { loadDispatchPairs };
