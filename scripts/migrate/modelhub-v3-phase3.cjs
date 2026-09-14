'use strict';
/**
 * ModelHub V3 — Phase 3 定价层迁移（幂等、可重复执行、支持已有库、不删旧字段）
 *
 * 目标：
 *   1. 确保 model_pricing（用户价）与 provider_model_costs（每线路成本）两张新表存在。
 *   2. consumption_ledger 补 binding_id 列（逐线路利润归因；缺列才补）。
 *   3. 回填 model_pricing：
 *        - 优先 model_price_history 最新快照（credit_cost），回退 models.credit_cost。
 *        - reward_price 暂无历史来源，默认 0（后续后台可填）。
 *   4. 回填 provider_model_costs（按线路 binding_id）：
 *        - 从 model_cost_rates 按 (provider_id, model_id) 取率，拆成 3 单位行：
 *            per_1k_input_token  ← input_cost_per_1k
 *            per_1k_output_token ← output_cost_per_1k
 *            per_asset           ← cost_per_unit
 *        - 仅 cost > 0 的单位才写（零成本单位不污染逐线路利润）。
 *        - binding_id 冗余存 provider_id/model_id，满足「线路 A/B/C 各 ¥」查询与回退。
 *
 * 安全原则（来自全局迁移铁律）：
 *   - 仅 CREATE TABLE + INSERT（INSERT 用 WHERE NOT EXISTS 幂等），绝不 DROP 旧表/旧列。
 *   - 提供 --rollback（DROP 两张新表 + 删 binding_id 列）与 --dry-run（仅统计）。
 *
 * 执行：
 *   node scripts/migrate/modelhub-v3-phase3.cjs            # 执行建表 + 回填
 *   node scripts/migrate/modelhub-v3-phase3.cjs --dry-run  # 仅统计，不写
 *   node scripts/migrate/modelhub-v3-phase3.cjs --rollback # 回滚本 Phase（DROP 新表 + 删列）
 *
 * 环境变量（与 server.js 一致）：
 *   PG_HOST / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD 或 DATABASE_URL
 */

const path = require('path');
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
} catch (_) { /* dotenv 可选 */ }

const { Pool } = require('pg');

function buildPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  }
  return new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'huabu',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '0.0.1abcd',
    max: 1,
  });
}

const DRY_RUN = process.argv.includes('--dry-run');
const ROLLBACK = process.argv.includes('--rollback');

async function rollback(pool) {
  console.log('[migrate:phase3] 执行回滚：DROP 两张新表 + 删 binding_id 列');
  await pool.query('DROP TABLE IF EXISTS provider_model_costs;');
  await pool.query('DROP TABLE IF EXISTS model_pricing;');
  await pool.query(`ALTER TABLE consumption_ledger DROP COLUMN IF EXISTS binding_id;`);
  console.log('[migrate:phase3] ✓ 回滚完成。旧 model_price_history / models.credit_cost / model_cost_rates 完全未动。');
  console.log('[migrate:phase3] 再次部署 Phase 3 之前端代码（读新表）会回退到旧表，等价于未升级。');
}

async function main() {
  const pool = buildPool();
  try {
    if (ROLLBACK) {
      await rollback(pool);
      return;
    }

    // 1) 确保两张新表存在（与 initDB 重复安全：CREATE TABLE IF NOT EXISTS）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_pricing (
        model_id     TEXT PRIMARY KEY,
        credit_price INT NOT NULL DEFAULT 0,
        reward_price INT NOT NULL DEFAULT 0,
        currency     TEXT DEFAULT 'CNY',
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS provider_model_costs (
        binding_id   TEXT NOT NULL REFERENCES provider_model_bindings(id) ON DELETE CASCADE,
        provider_id  TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        cost         NUMERIC NOT NULL DEFAULT 0,
        currency     TEXT DEFAULT 'CNY',
        unit         TEXT NOT NULL DEFAULT 'per_1k_input_token',
        effective_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (binding_id, unit)
      );
    `);
    // 前向兼容 ADD COLUMN（consumption_ledger.binding_id）
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='consumption_ledger' AND column_name='binding_id') THEN
          ALTER TABLE consumption_ledger ADD COLUMN binding_id TEXT DEFAULT '';
        END IF;
      END $$;
    `);
    console.log('[migrate:phase3] ✓ model_pricing / provider_model_costs 表已确保存在，consumption_ledger.binding_id 已确保');

    // 2) 统计：待回填 model_pricing（models 里尚未在 model_pricing 的 model_id）
    const pricSrc = await pool.query(`
      SELECT COUNT(DISTINCT m.model_id)::int AS n
      FROM models m
      WHERE m.model_id IS NOT NULL AND m.model_id <> ''
        AND NOT EXISTS (SELECT 1 FROM model_pricing p WHERE p.model_id = m.model_id)
    `);
    const pricTodo = (pricSrc.rows[0] && pricSrc.rows[0].n) || 0;
    console.log(`[migrate:phase3] 待回填 model_pricing 的逻辑模型数: ${pricTodo}`);

    // 3) 统计：待回填 provider_model_costs（有率且尚未写入的 binding×unit）
    const costSrc = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM provider_model_bindings b
      JOIN model_cost_rates r ON r.provider_id = b.provider_id AND r.model_id = b.model_id
      CROSS JOIN LATERAL (VALUES
        ('per_1k_input_token', COALESCE(r.input_cost_per_1k,0)),
        ('per_1k_output_token', COALESCE(r.output_cost_per_1k,0)),
        ('per_asset', COALESCE(r.cost_per_unit,0))
      ) AS v(unit, cost)
      WHERE v.cost > 0
        AND NOT EXISTS (SELECT 1 FROM provider_model_costs c WHERE c.binding_id = b.id AND c.unit = v.unit)
    `);
    const costTodo = (costSrc.rows[0] && costSrc.rows[0].n) || 0;
    console.log(`[migrate:phase3] 待回填 provider_model_costs 的 (binding×unit) 行数: ${costTodo}`);

    if (DRY_RUN) {
      console.log('[migrate:phase3] --dry-run：未执行写操作，退出');
      return;
    }

    // 4) 回填 model_pricing：优先 model_price_history 最新快照，回退 models.credit_cost
    if (pricTodo > 0) {
      const ins = await pool.query(`
        INSERT INTO model_pricing (model_id, credit_price, reward_price, currency, updated_at)
        SELECT DISTINCT m.model_id,
               COALESCE(
                 (SELECT h.credit_cost FROM model_price_history h WHERE h.model_id = m.model_id ORDER BY h.updated_at DESC LIMIT 1),
                 m.credit_cost, 0
               )::int AS credit_price,
               0, 'CNY', NOW()
        FROM models m
        WHERE m.model_id IS NOT NULL AND m.model_id <> ''
          AND NOT EXISTS (SELECT 1 FROM model_pricing p WHERE p.model_id = m.model_id)
      `);
      console.log(`[migrate:phase3] ✓ 已回填 ${ins.rowCount ?? 0} 行 model_pricing（已存在的跳过）`);
    } else {
      console.log('[migrate:phase3] model_pricing 无需回填');
    }

    // 5) 回填 provider_model_costs：按线路拆分 model_cost_rates 3 单位（cost>0 才写）
    if (costTodo > 0) {
      const ins = await pool.query(`
        INSERT INTO provider_model_costs (binding_id, provider_id, model_id, cost, currency, unit, effective_at, updated_at)
        SELECT b.id, b.provider_id, b.model_id, v.cost, COALESCE(r.currency,'CNY'), v.unit, NOW(), NOW()
        FROM provider_model_bindings b
        JOIN model_cost_rates r ON r.provider_id = b.provider_id AND r.model_id = b.model_id
        CROSS JOIN LATERAL (VALUES
          ('per_1k_input_token', COALESCE(r.input_cost_per_1k,0)),
          ('per_1k_output_token', COALESCE(r.output_cost_per_1k,0)),
          ('per_asset', COALESCE(r.cost_per_unit,0))
        ) AS v(unit, cost)
        WHERE v.cost > 0
          AND NOT EXISTS (SELECT 1 FROM provider_model_costs c WHERE c.binding_id = b.id AND c.unit = v.unit)
      `);
      console.log(`[migrate:phase3] ✓ 已回填 ${ins.rowCount ?? 0} 行 provider_model_costs（已存在的跳过）`);
    } else {
      console.log('[migrate:phase3] provider_model_costs 无需回填（无 model_cost_rates 或均已存在）');
    }

    // 6) 验证：有 model_cost_rates 的 binding 是否都已落到 provider_model_costs
    const dangling = await pool.query(`
      SELECT b.id AS binding_id, b.model_id, b.provider_id
      FROM provider_model_bindings b
      JOIN model_cost_rates r ON r.provider_id = b.provider_id AND r.model_id = b.model_id
      WHERE NOT EXISTS (SELECT 1 FROM provider_model_costs c WHERE c.binding_id = b.id)
      LIMIT 20;
    `);
    const danglingRows = dangling.rows || [];
    if (danglingRows.length > 0) {
      console.warn('[migrate:phase3] ⚠ 仍有 binding 配了率却无 provider_model_costs 行（通常是 cost 全为 0，属正常）：');
      for (const r of danglingRows) console.warn('   -', JSON.stringify(r));
    } else {
      console.log('[migrate:phase3] ✓ 全部有率的 binding 均已生成 provider_model_costs 行');
    }

    // 7) 分布验证
    const dist = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM model_pricing) AS pricing_rows,
        (SELECT COUNT(*)::int FROM provider_model_costs) AS cost_rows,
        (SELECT COUNT(DISTINCT binding_id)::int FROM provider_model_costs) AS bindings_priced
    `);
    const d = dist.rows[0] || {};
    console.log(`[migrate:phase3] 分布: model_pricing=${d.pricing_rows} 行, provider_model_costs=${d.cost_rows} 行, 覆盖线路数=${d.bindings_priced}`);

    console.log('\n── 验证 SQL（可手动复核）──');
    console.log('SELECT * FROM model_pricing ORDER BY model_id LIMIT 50;');
    console.log(`SELECT c.binding_id, c.provider_id, c.model_id, c.unit, c.cost, c.currency
FROM provider_model_costs c ORDER BY c.binding_id, c.unit LIMIT 50;`);
    console.log(`-- 逐线路成本一览（每条线路一行聚合）：
SELECT binding_id, model_id, provider_id,
       MAX(cost) FILTER (WHERE unit='per_1k_input_token')  AS in_1k,
       MAX(cost) FILTER (WHERE unit='per_1k_output_token') AS out_1k,
       MAX(cost) FILTER (WHERE unit='per_asset')           AS per_asset
FROM provider_model_costs GROUP BY binding_id, model_id, provider_id ORDER BY model_id, provider_id;`);
    console.log(`SELECT column_name FROM information_schema.columns WHERE table_name='consumption_ledger' AND column_name='binding_id';
-- 期望 1 行（列已存在）`);

    console.log('\n── 回滚说明 ──');
    console.log('本迁移为纯增量（CREATE TABLE + INSERT + ADD COLUMN），未删除任何旧表/旧列。');
    console.log('旧 model_price_history / models.credit_cost / model_cost_rates 完全保留，作双读回退与回滚安全网。');
    console.log('回滚命令（清空本 Phase 写入并移除新结构，不影响旧数据）：');
    console.log('  node scripts/migrate/modelhub-v3-phase3.cjs --rollback');
    console.log('回滚后部署旧版后端即可（读新表不存在 → 自动回退旧表）。');
  } finally {
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[migrate:phase3] 失败:', e && e.message);
  process.exit(1);
});
