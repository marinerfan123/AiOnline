// server/scripts/cleanup-dead-media.cjs
// 一次性清理：删除 media 表中「三列 URL 全空」的死链占位行。
// 死链来源：
//   1) failed 占位（GenerationBar 标记失败，thumbnail/fullUrl 为空）；
//   2) success 占位（pollTaskUntilDone 收到后端 done 但 result 缺 mediaId/ossUrl，
//      回退用 pendingId 转正为 success 且三列 URL 全空）—— 这是「刷新后仍莫名出现死链」的根因。
// 仅删除 status IN ('failed','success') 且三列 URL 全空的行；其余状态（如 pending_upload 中间态）不动。
// 用法：node server/scripts/cleanup-dead-media.cjs [--dry-run]

const { pool } = require('../db.cjs');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // 死链判定：status 为终态(failed/success) 且 三列 URL 全空（覆盖 '' 与 NULL）
  const deadCriteria = `status IN ('failed', 'success')
    AND COALESCE(full_url, '') = ''
    AND COALESCE(thumbnail, '') = ''
    AND COALESCE(oss_url, '') = ''`;

  const { rows: dead } = await pool.query(
    `SELECT id, status, title, type, created_at, user_id
     FROM media
     WHERE ${deadCriteria}
     ORDER BY created_at DESC`
  );

  // 额外审计：是否存在任意「三列 URL 全空但不在删除范围」的行（如 pending_upload 等），仅提示不删
  const { rows: otherEmpty } = await pool.query(
    `SELECT id, status, created_at
     FROM media
     WHERE status NOT IN ('failed', 'success')
       AND COALESCE(full_url, '') = ''
       AND COALESCE(thumbnail, '') = ''
       AND COALESCE(oss_url, '') = ''
     ORDER BY created_at DESC`
  );

  console.log(`死链待删记录：${dead.length} 条（status=failed/success 且三列 URL 全空）`);
  console.log(`其余空 URL 记录（不删）：${otherEmpty.length} 条`);

  if (dead.length === 0) {
    await pool.end();
    return;
  }

  if (dryRun) {
    console.log('DRY-RUN：仅统计，未删除。如需删除请去掉 --dry-run');
    for (const r of dead.slice(0, 30)) {
      console.log(`  ${r.id} | status=${r.status} | title=${(r.title || '').slice(0, 30)} | created_at=${r.created_at}`);
    }
    if (dead.length > 30) console.log(`  ... 还有 ${dead.length - 30} 条`);
    await pool.end();
    return;
  }

  console.log(`准备删除 ${dead.length} 条死链占位记录...`);
  const ids = dead.map((r) => r.id);
  const { rowCount } = await pool.query(
    `DELETE FROM media WHERE id = ANY($1::text[])`,
    [ids]
  );
  console.log(`已删除 ${rowCount} 条死链占位记录。`);

  if (otherEmpty.length > 0) {
    console.log(`另有 ${otherEmpty.length} 条非 failed/success 的空 URL 记录未动（可能是 pending_upload 等中间态），如需处理请人工确认。`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
