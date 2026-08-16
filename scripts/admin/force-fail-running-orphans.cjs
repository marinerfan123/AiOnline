#!/usr/bin/env node
// 一次性运维脚本：强制失败「running 超过指定时间仍未终态」的孤儿任务。
// 行为：释放 held 积分（按池回退，幂等）+ 标记 failed + 写入 completed_at。
// 用法：node scripts/admin/force-fail-running-orphans.cjs [minutes=90]
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

const MINUTES = parseInt(process.argv[2] || '90', 10);

async function main() {
  const r = await pg.query(
    `SELECT task_id, user_id, cost, cost_pool, idempotency_key, model, created_at,
            EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS elapsed_min
       FROM generation_tasks
      WHERE status='running' AND created_at < NOW() - INTERVAL '${MINUTES} minutes'`,
  );
  console.log(`[force-fail] 找到 running 超过 ${MINUTES} 分钟的任务 ${r.rows.length} 个`);
  let ok = 0;
  for (const row of r.rows) {
    try {
      await billing.releaseCredits(pg, row.user_id, row.cost, row.idempotency_key, row.cost_pool || 'recharge');
      await pg.query(
        `UPDATE generation_tasks
            SET status='failed',
                completed_at=NOW(),
                error=$2
          WHERE task_id=$1`,
        [row.task_id, `管理员强制失败：running 超过 ${MINUTES} 分钟未收到生成端终态，回收孤儿任务`],
      );
      console.log(`  ✓ ${row.task_id} model=${row.model || ''} elapsed=${row.elapsed_min?.toFixed?.(1) || '?'}min cost=${row.cost || 0} pool=${row.cost_pool || 'recharge'}`);
      ok++;
    } catch (e) {
      console.warn(`  ✗ ${row.task_id} 失败: ${e.message}`);
    }
  }
  console.log(`[force-fail] 完成：成功 ${ok}/${r.rows.length}`);
  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
