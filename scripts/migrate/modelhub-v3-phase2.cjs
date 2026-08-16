'use strict';
/**
 * ModelHub V3 — Phase 2 数据库迁移（幂等、可重复执行、支持已有库、不删旧字段）
 *
 * 目标：
 *   1. 确保 provider_model_bindings 表存在（逻辑模型 × 服务商 线路绑定）。
 *   2. 把「旧 models 数据」自动转换为「bindings」：
 *        - 每个 DISTINCT (model_id, provider_id) 组合生成一行绑定。
 *        - upstream_model_name 默认取原 model_id（= 现状：dispatcher 一直拿 model_id 当上游名），
 *          等价现状、零行为变化；后续可由后台把上游真实模型名改对（如 kling-v3）。
 *   3. 旧 models.provider_id / 其它字段一律保留不删（双读兼容 + 回滚安全）。
 *
 * 安全原则（来自全局迁移铁律）：
 *   - 仅 CREATE TABLE + INSERT（INSERT 用 WHERE NOT EXISTS 去重，天然幂等），绝不 DROP / 改列。
 *   - 每次执行幂等：已存在的绑定不会重复插入（UNIQUE(model_id, provider_id) + NOT EXISTS 双保险）。
 *   - 提供验证 SQL 与回滚说明（见尾部日志）。
 *
 * 执行：
 *   node scripts/migrate/modelhub-v3-phase2.cjs            # 执行：建表 + 自动生成 bindings
 *   node scripts/migrate/modelhub-v3-phase2.cjs --dry-run  # 仅统计，不写
 *
 * 环境变量（与 server.js 一致）：
 *   PG_HOST / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD
 *   或 DATABASE_URL（postgres://...）
 */

const path = require('path');
// 允许从项目根目录加载 .env（若存在）
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

async function main() {
  const pool = buildPool();
  try {
    // 1) 确保表存在（与 initDB 重复也安全：CREATE TABLE IF NOT EXISTS）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS provider_model_bindings (
        id                  TEXT PRIMARY KEY DEFAULT 'pmb-' || gen_random_uuid()::text,
        model_id            TEXT NOT NULL,
        provider_id         TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        upstream_model_name TEXT NOT NULL DEFAULT '',
        enabled             BOOLEAN NOT NULL DEFAULT TRUE,
        priority            INT NOT NULL DEFAULT 0,
        weight              INT NOT NULL DEFAULT 0,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (model_id, provider_id)
      );
    `);
    // 前向兼容：已存在表但缺列时补齐（幂等；支持老库 ALTER 升级）
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='upstream_model_name') THEN
          ALTER TABLE provider_model_bindings ADD COLUMN upstream_model_name TEXT NOT NULL DEFAULT '';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='priority') THEN
          ALTER TABLE provider_model_bindings ADD COLUMN priority INT NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='weight') THEN
          ALTER TABLE provider_model_bindings ADD COLUMN weight INT NOT NULL DEFAULT 0;
        END IF;
      END $$;
    `);
    console.log('[migrate] ✓ provider_model_bindings 表已确保存在');

    // 2) 统计待生成绑定：从 models 取所有 DISTINCT (model_id, provider_id)（enabled 且有 provider_id）
    const src = await pool.query(`
      SELECT DISTINCT model_id, provider_id
      FROM models
      WHERE enabled = true AND provider_id IS NOT NULL AND provider_id <> ''
    `);
    const srcRows = src.rows || [];
    console.log(`[migrate] models 中可生成绑定的 (model_id, provider_id) 组合数: ${srcRows.length}`);

    // 3) 统计已存在绑定（避免重复插入）
    const existRes = await pool.query(`SELECT COUNT(*)::int AS n FROM provider_model_bindings`);
    const existCount = (existRes.rows[0] && existRes.rows[0].n) || 0;
    console.log(`[migrate] 现有 bindings 行数: ${existCount}`);

    if (DRY_RUN) {
      console.log('[migrate] --dry-run：未执行写操作，退出');
      return;
    }

    // 4) 自动生成 bindings（幂等：仅插入尚不存在的组合；upstream_model_name 默认取 model_id=现状）
    if (srcRows.length > 0) {
      // 用多 VALUES + NOT EXISTS 反查，单条语句完成全部插入，重复执行安全
      const vals = srcRows
        .map((r) => {
          const mid = (r.model_id || '').replace(/'/g, "''");
          const pid = (r.provider_id || '').replace(/'/g, "''");
          return `('${mid}', '${pid}', '${mid}')`;
        })
        .join(', ');
      const ins = await pool.query(`
        INSERT INTO provider_model_bindings (model_id, provider_id, upstream_model_name)
        SELECT v.model_id, v.provider_id, v.upstream_model_name
        FROM (VALUES ${vals}) AS v(model_id, provider_id, upstream_model_name)
        WHERE NOT EXISTS (
          SELECT 1 FROM provider_model_bindings b
          WHERE b.model_id = v.model_id AND b.provider_id = v.provider_id
        )
      `);
      console.log(`[migrate] ✓ 已生成 ${ins.rowCount ?? 0} 条新 bindings（已存在的跳过）`);
    }

    // 5) 验证：每个 models 的 (model_id, provider_id) 是否都有对应 binding
    const dangling = await pool.query(`
      SELECT DISTINCT m.model_id, m.provider_id
      FROM models m
      WHERE m.enabled = true AND m.provider_id IS NOT NULL AND m.provider_id <> ''
        AND NOT EXISTS (
          SELECT 1 FROM provider_model_bindings b
          WHERE b.model_id = m.model_id AND b.provider_id = m.provider_id
        )
      LIMIT 20;
    `);
    const danglingRows = dangling.rows || [];
    if (danglingRows.length > 0) {
      console.warn('[migrate] ⚠ 仍有 (model_id, provider_id) 无对应 binding（请检查 providers 表是否缺该 provider）：');
      for (const r of danglingRows) console.warn('   -', JSON.stringify(r));
    } else {
      console.log('[migrate] ✓ 全部 models 线路均已生成 binding');
    }

    // 6) 验证：upstream_model_name 分布（应全部等于 model_id，即等价现状）
    const dist = await pool.query(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE upstream_model_name = model_id)::int AS same_as_model_id
      FROM provider_model_bindings;
    `);
    const d = dist.rows[0] || { n: 0, same_as_model_id: 0 };
    console.log(`[migrate] bindings 总数 ${d.n}，其中 upstream=model_id(等价现状) ${d.same_as_model_id}`);

    console.log('\n── 验证 SQL（可手动复核）──');
    console.log('SELECT COUNT(*) FROM provider_model_bindings; -- 应 > 0');
    console.log('SELECT model_id, provider_id, upstream_model_name, enabled FROM provider_model_bindings ORDER BY model_id, provider_id LIMIT 50;');
    console.log(`SELECT DISTINCT m.model_id, m.provider_id
FROM models m
WHERE m.enabled = true AND m.provider_id IS NOT NULL AND m.provider_id <> ''
  AND NOT EXISTS (SELECT 1 FROM provider_model_bindings b WHERE b.model_id=m.model_id AND b.provider_id=m.provider_id);
-- 期望 0 行`);
    console.log('\n── 回滚说明 ──');
    console.log('本迁移为纯增量（CREATE TABLE + INSERT），未删除任何 models 旧列或数据。');
    console.log('回滚 Phase 2 代码逻辑：直接部署旧版后端即可——旧 dispatcher 读 models.provider_id，完全忽略 bindings 表。');
    console.log('如需清空本迁移写入的绑定数据（不影响 models）：');
    console.log('  TRUNCATE provider_model_bindings;');
    console.log('此迁移脚本本身可逆：再次运行安全（INSERT ... WHERE NOT EXISTS 幂等），无DROP。');
  } finally {
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[migrate] 失败:', e && e.message);
  process.exit(1);
});
