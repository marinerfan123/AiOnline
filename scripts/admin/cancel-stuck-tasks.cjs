#!/usr/bin/env node
// 一次性运维脚本：批量取消「等待区资源长期不可用」的卡死任务。
// 行为：释放 held 积分（按池回退，幂等）+ 标记 canceled。
// 用法：node scripts/admin/cancel-stuck-tasks.cjs
require('dotenv/config');
const { Pool } = require('pg');
const billing = require('../../server/billing.cjs');

const pg = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'huabu',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '0.0.1abcd',
});

async function main() {
  // 卡死判定：仍 running 且 处于等待区（持久化 waitingOpts 或 error 含「等待区」）
  const r = await pg.query(
    `SELECT task_id, user_id, cost, cost_pool, idempotency_key, model
       FROM generation_tasks
      WHERE status='running'
        AND (resume_meta->'waitingOpts' IS NOT NULL OR error LIKE '%等待区%')`,
  );
  console.log(`[cancel-stuck] 找到待取消任务 ${r.rows.length} 个`);
  let ok = 0;
  for (const row of r.rows) {
    try {
      // ① 释放 held 积分（幂等，已 release 则跳过）
      await billing.releaseCredits(pg, row.user_id, row.cost, row.idempotency_key, row.cost_pool || 'recharge');
      // ② 标记 canceled（不 set completed_at；与 updateTaskStatus 的 CASE 一致）
      await pg.query(
        `UPDATE generation_tasks SET status='canceled', error=$2 WHERE task_id=$1`,
        [row.task_id, '管理员批量取消（等待区资源长期不可用，超过重试上限）'],
      );
      console.log(`  ✓ ${row.task_id} model=${row.model || ''} userId=${row.user_id || ''} cost=${row.cost || 0}`);
      ok++;
    } catch (e) {
      console.warn(`  ✗ ${row.task_id} 失败: ${e.message}`);
    }
  }
  console.log(`[cancel-stuck] 完成：成功 ${ok}/${r.rows.length}`);
  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
