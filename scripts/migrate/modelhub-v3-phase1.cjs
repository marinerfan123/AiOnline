'use strict';
/**
 * ModelHub V3 — Phase 1 数据库迁移（幂等、可重复执行、支持已有库）
 *
 * 目标：把 generation_tasks.model_id 历史空值回填为 canonical model_id，
 *       使旧任务（图片任务 / 提交前任务）也能被崩溃恢复链按 model_id 恢复。
 *
 * 安全原则（来自全局迁移铁律）：
 *  - 仅 ADD COLUMN + 回填，绝不 DROP / 改列；display_name 列原样保留。
 *  - 每次执行幂等：已回填的行 WHERE model_id IS NULL 不再命中。
 *  - 提供验证 SQL 与回滚说明（见尾部日志）。
 *
 * 执行：
 *   node scripts/migrate/modelhub-v3-phase1.cjs            # 执行回填
 *   node scripts/migrate/modelhub-v3-phase1.cjs --dry-run  # 仅统计，不写
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
    // 1) 确保列存在（与 initDB 重复也安全：ADD COLUMN IF NOT EXISTS）
    await pool.query(
      `ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS model_id TEXT;`,
    );
    console.log('[migrate] ✓ model_id 列已确保存在');

    // 2) 统计待回填行
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM generation_tasks WHERE model_id IS NULL;`,
    );
    const nullCount = before.rows[0] ? before.rows[0].n : 0;
    console.log(`[migrate] 待回填 model_id 空值行数: ${nullCount}`);

    if (DRY_RUN) {
      console.log('[migrate] --dry-run：未执行写操作，退出');
      return;
    }

    if (nullCount > 0) {
      // 3) 回填：display_name → model_id；否则 model 本身即 model_id；否则保留原值
      const upd = await pool.query(`
        UPDATE generation_tasks
           SET model_id = COALESCE(
                 (SELECT m.model_id FROM models m WHERE m.display_name = generation_tasks.model LIMIT 1),
                 (SELECT m.model_id FROM models m WHERE m.model_id    = generation_tasks.model LIMIT 1),
                 generation_tasks.model)
         WHERE model_id IS NULL;
      `);
      console.log(`[migrate] ✓ 已回填 ${upd.rowCount ?? nullCount} 行`);
    }

    // 4) 验证：剩余空值
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM generation_tasks WHERE model_id IS NULL;`,
    );
    const remaining = after.rows[0] ? after.rows[0].n : 0;
    console.log(`[migrate] 回填后剩余 model_id 空值行数: ${remaining}`);

    if (remaining > 0) {
      // 列出来源（model 列）便于人工定位无法解析的孤儿
      const orphans = await pool.query(
        `SELECT DISTINCT model FROM generation_tasks WHERE model_id IS NULL LIMIT 20;`,
      );
      console.warn('[migrate] ⚠ 仍存在无法解析的 model 值（请检查 models 表是否缺失对应记录）：');
      for (const r of orphans.rows || []) console.warn('   -', JSON.stringify(r.model));
    } else {
      console.log('[migrate] ✓ 全部 model_id 已就绪');
    }

    console.log('\n── 验证 SQL（可手动复核）──');
    console.log('SELECT COUNT(*) FROM generation_tasks WHERE model_id IS NULL; -- 期望 0');
    console.log('SELECT model, model_id, COUNT(*) FROM generation_tasks GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;');
    console.log('\n── 回滚说明 ──');
    console.log('本迁移为纯增量回填（ADD COLUMN + UPDATE），未删除任何列或数据。');
    console.log('如需回退 Phase 1 代码逻辑：直接部署旧版后端即可，model_id 列的额外数据不影响旧逻辑');
    console.log('（旧代码中 generation_tasks.model 仍为展示名，model_id 列被忽略）。display_name 列从未删除。');
    console.log('此迁移脚本本身可逆：再次运行安全（幂等），无DROP。');
  } finally {
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[migrate] 失败:', e && e.message);
  process.exit(1);
});
