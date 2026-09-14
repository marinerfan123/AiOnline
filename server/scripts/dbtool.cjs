// server/scripts/dbtool.cjs
// ─────────────────────────────────────────────────────────────────────────────
// 通用 DB 诊断 / 修复子命令工具。所有脚本（check.sh / repair.sh / restart.sh）
// 复用此文件，避免重复造连接与 SQL。
//
// 依赖：../db.cjs 导出的 pool（自动读 .env）。
// 环境变量：
//   SAFETY_MINUTES  僵尸任务安全线（分钟），默认 90（与项目「超时铁律」一致）。
//
// 子命令：
//   ping                       测试 PG 连接是否可用
//   stats                      输出基础计数（media 总数 / 死链数 / 僵尸数 / 超时数）
//   deadlinks [--dry-run]      列出 status IN(failed,success) 且三列 URL 全空的占位行
//   zombies  [--dry-run]       列出 created_at 超过安全线仍 running 的 generation_tasks
//   clean-deadlinks [--dry-run] 删除上述死链占位行（幂等：删完即 0）
//   timeout-zombies [--dry-run] 将超过安全线仍 running 的任务标 status='timeout'（幂等）
//
// 用法：node server/scripts/dbtool.cjs <subcommand> [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../db.cjs');

const SAFETY_MINUTES = parseInt(process.env.SAFETY_MINUTES || '90', 10);
const DRY_RUN = process.argv.includes('--dry-run');

// 死链判定：终态(failed/success) 且 三列 URL 全空（覆盖 '' 与 NULL）。
// 来源：failed 占位；或 done 结果缺 mediaId/ossUrl 被前端回退转正的 success 占位。
const DEAD_CRITERIA = `status IN ('failed', 'success')
  AND COALESCE(full_url, '') = ''
  AND COALESCE(thumbnail, '') = ''
  AND COALESCE(oss_url, '') = ''`;

function pct(n) { return Number(n); }

async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  const ok = rows[0] && rows[0].ok === 1;
  console.log(ok ? 'PG_OK' : 'PG_FAIL');
  return ok;
}

async function getDeadLinks() {
  const { rows } = await pool.query(
    `SELECT id, status, title, type, user_id, created_at
     FROM media
     WHERE ${DEAD_CRITERIA}
     ORDER BY created_at DESC`
  );
  return rows;
}

async function getZombies() {
  const { rows } = await pool.query(
    `SELECT task_id, status, model, created_at
     FROM generation_tasks
     WHERE status = 'running'
       AND created_at < NOW() - ($1::int || ' minutes')::interval
     ORDER BY created_at ASC`,
    [SAFETY_MINUTES]
  );
  return rows;
}

async function stats() {
  const total = await pool.query('SELECT COUNT(*)::int AS c FROM media');
  const dead = await getDeadLinks();
  const zombies = await getZombies();
  const timeout = await pool.query(
    `SELECT COUNT(*)::int AS c FROM generation_tasks WHERE status = 'timeout'`
  );
  console.log('media_total   :', pct(total.rows[0].c));
  console.log('dead_links    :', dead.length, '(failed/success 且三列 URL 全空)');
  console.log('zombie_tasks  :', zombies.length, `(running 且 > ${SAFETY_MINUTES}min)`);
  console.log('timeout_tasks :', pct(timeout.rows[0].c));
  return { total: pct(total.rows[0].c), dead: dead.length, zombies: zombies.length };
}

async function deadlinks() {
  const rows = await getDeadLinks();
  console.log(`死链占位记录：${rows.length} 条`);
  for (const r of rows.slice(0, 50)) {
    console.log(`  ${r.id} | ${r.status} | ${(r.title || '').slice(0, 30)} | ${r.created_at}`);
  }
  if (rows.length > 50) console.log(`  ... 还有 ${rows.length - 50} 条`);
  return rows;
}

async function zombies() {
  const rows = await getZombies();
  console.log(`僵尸任务（running 且 > ${SAFETY_MINUTES}min）：${rows.length} 条`);
  for (const r of rows.slice(0, 50)) {
    console.log(`  ${r.task_id} | ${r.model || ''} | ${r.created_at}`);
  }
  if (rows.length > 50) console.log(`  ... 还有 ${rows.length - 50} 条`);
  return rows;
}

async function cleanDeadLinks() {
  const rows = await getDeadLinks();
  console.log(`死链待删：${rows.length} 条`);
  if (rows.length === 0) return 0;
  if (DRY_RUN) {
    console.log('DRY-RUN：未删除。去掉 --dry-run 执行真实删除。');
    return 0;
  }
  const ids = rows.map((r) => r.id);
  const { rowCount } = await pool.query('DELETE FROM media WHERE id = ANY($1::text[])', [ids]);
  console.log(`已删除 ${rowCount} 条死链占位记录。`);
  return rowCount;
}

async function timeoutZombies() {
  const rows = await getZombies();
  console.log(`超时僵尸待标记：${rows.length} 条（> ${SAFETY_MINUTES}min 仍 running）`);
  if (rows.length === 0) return 0;
  if (DRY_RUN) {
    console.log('DRY-RUN：未修改。去掉 --dry-run 执行真实标记。');
    return 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE generation_tasks
     SET status = 'timeout'
     WHERE status = 'running'
       AND created_at < NOW() - ($1::int || ' minutes')::interval`,
    [SAFETY_MINUTES]
  );
  console.log(`已将 ${rowCount} 条任务标记为 timeout（防僵尸安全线，非失败、不退积分）。`);
  return rowCount;
}

async function main() {
  const cmd = process.argv[2] || 'ping';
  let result;
  switch (cmd) {
    case 'ping':           result = await ping(); break;
    case 'stats':          result = await stats(); break;
    case 'deadlinks':      result = await deadlinks(); break;
    case 'zombies':        result = await zombies(); break;
    case 'clean-deadlinks':result = await cleanDeadLinks(); break;
    case 'timeout-zombies':result = await timeoutZombies(); break;
    default:
      console.error('未知子命令：', cmd);
      console.error('可用：ping | stats | deadlinks | zombies | clean-deadlinks | timeout-zombies');
      process.exitCode = 2;
      return;
  }
  // 仅 ping 返回布尔时不影响退出码；其余命令成功退出 0。
  if (cmd === 'ping' && result !== true) process.exitCode = 1;
}

main()
  .catch((e) => { console.error('[dbtool] 错误：', e.message); process.exitCode = 1; })
  .finally(() => { try { pool.end(); } catch (_) {} });
