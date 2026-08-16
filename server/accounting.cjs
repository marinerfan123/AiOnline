// server/accounting.cjs — 全局双边账务（后台量 vs 客户量），无例外、精确算量
// 设计铁律（用户 2026-08-08）：
//   - 全局所有模型消耗（含系统自身调用大模型）都必须走账，无任何例外。
//   - 账是双边的：后台量（平台向上游服务商实际付出的成本）vs 客户量（向客户收的积分/钱）。
//   - 差值 = 亏损或盈利（margin_cents = 客户收费折算分 − 后台成本分）。
// 用法：accounting.recordConsumption(pg, {...}) —— 唯一记账入口，幂等 + 调用方须 try/catch 包裹。
const accounting = {
  // 积分→分 折算（settings.app.creditToCents，默认 1 积分 = 1 分）
  async getCreditToCents(pg) {
    try {
      const r = await pg.query("SELECT value FROM settings WHERE key='app'");
      const v = r.rows[0] && r.rows[0].value;
      const n = v && typeof v.creditToCents === 'number' ? v.creditToCents : 1;
      return n > 0 ? n : 1;
    } catch { return 1; }
  },

  // 默认后台成本率（settings.app.defaultBackendCost[type]，默认 0；未知服务商/模型时的兜底）
  async getDefaultBackendCost(pg, modelType) {
    try {
      const r = await pg.query("SELECT value FROM settings WHERE key='app'");
      const v = r.rows[0] && r.rows[0].value;
      const map = (v && v.defaultBackendCost) || {};
      const n = map[modelType];
      return typeof n === 'number' ? n : 0;
    } catch { return 0; }
  },

  // 写/更新某 provider+model 的上游成本价率（manual 后台手填 | llm_inferred AI 推断）
  async upsertCostRate(pg, { providerId, modelId, modelType = 'text', inputCostPer1k = 0, outputCostPer1k = 0, costPerUnit = 0, source = 'manual' }) {
    await pg.query(`
      INSERT INTO model_cost_rates
        (provider_id, model_id, model_type, input_cost_per_1k, output_cost_per_1k, cost_per_unit, source, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (provider_id, model_id) DO UPDATE SET
        model_type=EXCLUDED.model_type,
        input_cost_per_1k=EXCLUDED.input_cost_per_1k,
        output_cost_per_1k=EXCLUDED.output_cost_per_1k,
        cost_per_unit=EXCLUDED.cost_per_unit,
        source=EXCLUDED.source,
        updated_at=NOW()
    `, [providerId, modelId, modelType, inputCostPer1k, outputCostPer1k, costPerUnit, source]);
  },

  // ── Phase 3 定价层：双读（新表 → 旧表 → 默认值）──

  // 用户侧价（单逻辑模型）：模型积分售价。双读链：
  //   model_pricing → model_price_history(最新快照) → models.credit_cost → 0
  async getModelPrice(pg, modelId) {
    if (!modelId) return { creditPrice: 0, rewardPrice: 0, currency: 'CNY', source: 'none' };
    try {
      const r = await pg.query('SELECT credit_price, reward_price, currency FROM model_pricing WHERE model_id=$1', [modelId]);
      if (r.rows[0]) {
        return {
          creditPrice: Number(r.rows[0].credit_price) || 0,
          rewardPrice: Number(r.rows[0].reward_price) || 0,
          currency: r.rows[0].currency || 'CNY',
          source: 'model_pricing',
        };
      }
    } catch { /* 新表不存在 → 回退 */ }
    try {
      const r = await pg.query("SELECT credit_cost FROM model_price_history WHERE model_id=$1 ORDER BY updated_at DESC LIMIT 1", [modelId]);
      if (r.rows[0]) return { creditPrice: Number(r.rows[0].credit_cost) || 0, rewardPrice: 0, currency: 'CNY', source: 'model_price_history' };
    } catch { /* 旧快照不存在 → 回退 */ }
    try {
      const r = await pg.query('SELECT credit_cost FROM models WHERE model_id=$1 LIMIT 1', [modelId]);
      if (r.rows[0]) return { creditPrice: Number(r.rows[0].credit_cost) || 0, rewardPrice: 0, currency: 'CNY', source: 'models' };
    } catch { /* 无 */ }
    return { creditPrice: 0, rewardPrice: 0, currency: 'CNY', source: 'none' };
  },

  // 写/更新某逻辑模型的用户价（ON CONFLICT 覆盖）
  async upsertModelPrice(pg, { modelId, creditPrice = 0, rewardPrice = 0, currency = 'CNY' }) {
    await pg.query(`
      INSERT INTO model_pricing (model_id, credit_price, reward_price, currency, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (model_id) DO UPDATE SET
        credit_price=EXCLUDED.credit_price, reward_price=EXCLUDED.reward_price,
        currency=EXCLUDED.currency, updated_at=NOW()
    `, [modelId, Number(creditPrice) || 0, Number(rewardPrice) || 0, currency]);
  },

  // 写/更新某线路的某单位成本（复合主键 (binding_id, unit) 幂等 upsert）
  async upsertProviderCost(pg, { bindingId, providerId, modelId, unit = 'per_1k_input_token', cost = 0, currency = 'CNY' }) {
    await pg.query(`
      INSERT INTO provider_model_costs (binding_id, provider_id, model_id, cost, currency, unit, effective_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
      ON CONFLICT (binding_id, unit) DO UPDATE SET
        provider_id=EXCLUDED.provider_id, model_id=EXCLUDED.model_id, cost=EXCLUDED.cost,
        currency=EXCLUDED.currency, updated_at=NOW()
    `, [bindingId, providerId, modelId, Number(cost) || 0, currency, unit]);
  },

  // 取某线路/某 (provider,model) 的成本率明细（供后台「线路 A/B/C 各 ¥」展示）
  // 双读链：provider_model_costs(binding_id) → model_cost_rates(provider,model) → 默认率
  // 返回 { source, bindingId?, rows, fallback }
  async getProviderCostRate(pg, { bindingId, providerId, modelId } = {}) {
    if (bindingId) {
      try {
        const r = await pg.query('SELECT unit, cost, currency, effective_at FROM provider_model_costs WHERE binding_id=$1 ORDER BY unit', [bindingId]);
        if (r.rows.length) return { source: 'binding', bindingId, rows: r.rows, fallback: null };
      } catch { /* 新表不存在 → 回退 */ }
    }
    if (providerId && modelId) {
      try {
        const r = await pg.query('SELECT model_type, input_cost_per_1k, output_cost_per_1k, cost_per_unit, currency FROM model_cost_rates WHERE provider_id=$1 AND model_id=$2', [providerId, modelId]);
        if (r.rows[0]) return { source: 'rate', bindingId: null, rate: r.rows[0], fallback: null };
      } catch { /* 旧率表不存在 → 回退 */ }
    }
    return { source: 'default', bindingId: null, rows: [], fallback: true };
  },

  // 计算某次消耗的上游成本（分）。双读链：
  //   provider_model_costs(binding_id) → model_cost_rates(provider,model) → 默认率(settings.app.defaultBackendCost)
  // bindingId 优先（逐线路精确成本），否则按 (provider,model) 率，最后按默认率。
  async getProviderCostCents(pg, { bindingId, providerId, modelId, modelType, inputUnits = 0, outputUnits = 0 } = {}) {
    const iu = Number(inputUnits) || 0;
    const ou = Number(outputUnits) || 0;
    const round = (x) => Math.round(x * 100) / 100;

    // 1) 逐线路成本（per binding, per unit）
    if (bindingId) {
      try {
        const r = await pg.query('SELECT unit, cost FROM provider_model_costs WHERE binding_id=$1', [bindingId]);
        if (r.rows.length) {
          const byUnit = {};
          for (const row of r.rows) byUnit[row.unit] = Number(row.cost) || 0;
          const cents = modelType === 'text'
            ? iu / 1000 * (byUnit.per_1k_input_token || 0) + ou / 1000 * (byUnit.per_1k_output_token || 0)
            : ou * (byUnit.per_asset || 0);
          return { cents: round(cents), source: 'binding', bindingId };
        }
      } catch { /* 新表不存在 → 回退 */ }
    }
    // 2) 回退 model_cost_rates（按 provider, model）
    if (providerId && modelId) {
      try {
        const r = await pg.query('SELECT * FROM model_cost_rates WHERE provider_id=$1 AND model_id=$2', [providerId, modelId]);
        const rate = r.rows[0];
        if (rate) {
          let cents = 0;
          if (modelType === 'text' || (!modelType && (rate.input_cost_per_1k || rate.output_cost_per_1k))) {
            cents = iu / 1000 * (Number(rate.input_cost_per_1k) || 0) + ou / 1000 * (Number(rate.output_cost_per_1k) || 0);
          } else {
            cents = ou * (Number(rate.cost_per_unit) || 0);
          }
          return { cents: round(cents), source: 'rate', bindingId: null };
        }
      } catch { /* 旧率表不存在 → 回退 */ }
    }
    // 3) 回退默认率
    const def = await this.getDefaultBackendCost(pg, modelType);
    const cents = modelType === 'text'
      ? (iu + ou) / 1000 * def
      : ou * def;
    return { cents: round(cents), source: 'default', bindingId: null };
  },

  // ── 唯一记账入口 ──
  // 写 consumption_ledger：后台量(backend_cost_cents) vs 客户量(customer_charge_*)，margin = 客户 − 后台
  // 参数：
  //   scope            'user' | 'system'（系统自身调用大模型计为 system，客户收费=0，如实显示为平台成本）
  //   actorId          用户 id 或 'system'
  //   purpose          用途标签：generate | skill:prompt_optimize | agent:optimize-prompt | provider_onboarding | ...
  //   providerId/modelId/modelType  归因键（精确算量的基础）
  //   inputUnits/outputUnits  文本=token 数；图/视频=生成资产数（output）
  //   customerChargeCredits  向客户收的积分（system 时传 0）
  //   idempotencyKey   幂等键（同一消耗不重复记账）
  async recordConsumption(pg, {
    scope = 'user', actorId = '', purpose, providerId = '', modelId = '', modelType = '',
    inputUnits = 0, outputUnits = 0, customerChargeCredits = 0, taskRef = '', idempotencyKey = '', status = 'ok',
    bindingId = '',
  }) {
    if (!purpose) throw new Error('recordConsumption 需要 purpose');
    if (!pg || !pg.query) throw new Error('recordConsumption 需要 pg');

    // 幂等：同 idempotency_key 已记则跳过（崩溃重试不双记）
    if (idempotencyKey) {
      try {
        const ex = await pg.query('SELECT 1 FROM consumption_ledger WHERE idempotency_key=$1 LIMIT 1', [idempotencyKey]);
        if (ex.rows.length) return { skipped: true };
      } catch { /* 表不存在等极端情况放行，下方 insert 会再报错 */ }
    }

    // ── 后台成本（上游实际付出）── 双读：逐线路成本 → (provider,model) 率 → 默认率
    // 通过 getProviderCostCents 统一走 Phase 3 双读链；失败时兜回默认率，绝不阻断记账。
    let backendCostCents = 0;
    try {
      const c = await this.getProviderCostCents(pg, { bindingId, providerId, modelId, modelType, inputUnits, outputUnits });
      backendCostCents = c.cents || 0;
    } catch {
      const def = await this.getDefaultBackendCost(pg, modelType);
      backendCostCents = modelType === 'text'
        ? ((Number(inputUnits) || 0) + (Number(outputUnits) || 0)) / 1000 * def
        : (Number(outputUnits) || 0) * def;
    }
    backendCostCents = Math.round(backendCostCents * 100) / 100;

    // ── 客户量折算 ──
    const creditToCents = await this.getCreditToCents(pg);
    const customerChargeCents = Math.round((Number(customerChargeCredits) || 0) * creditToCents * 100) / 100;
    const marginCents = Math.round((customerChargeCents - backendCostCents) * 100) / 100;

    await pg.query(`
      INSERT INTO consumption_ledger
        (scope, actor_id, purpose, provider_id, model_id, model_type, input_units, output_units, binding_id,
         backend_cost_cents, customer_charge_credits, customer_charge_cents, margin_cents, task_ref, idempotency_key, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [
      scope, actorId || '', purpose, providerId || '', modelId || '', modelType || '',
      Number(inputUnits) || 0, Number(outputUnits) || 0, bindingId || '',
      backendCostCents, Number(customerChargeCredits) || 0, customerChargeCents, marginCents,
      taskRef || '', idempotencyKey || '', status,
    ]);
    return { backendCostCents, customerChargeCents, marginCents, bindingId: bindingId || '' };
  },

  // 经营看板聚合：按 scope/purpose 汇总后台成本、客户收费、margin（盈亏）
  async summarize(pg, { scope, from, to } = {}) {
    const where = [];
    const params = [];
    if (scope) { params.push(scope); where.push(`scope=$${params.length}`); }
    if (from) { params.push(from); where.push(`created_at>='$${params.length}'`); }
    if (to) { params.push(to); where.push(`created_at<='$${params.length}'`); }
    const w = where.length ? where.join(' AND ') : '1=1';
    const r = await pg.query(`
      SELECT scope, purpose, COUNT(*) AS calls,
             SUM(input_units) AS sum_input, SUM(output_units) AS sum_output,
             SUM(backend_cost_cents) AS sum_backend,
             SUM(customer_charge_cents) AS sum_customer,
             SUM(margin_cents) AS sum_margin
      FROM consumption_ledger WHERE ${w}
      GROUP BY scope, purpose ORDER BY sum_margin ASC
    `, params);
    return r.rows;
  },
};

module.exports = accounting;
