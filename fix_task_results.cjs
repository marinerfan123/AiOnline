const { pool } = require('/app/server/db.cjs');

async function fix() {
  const { rows: mediaRows } = await pool.query(
    "SELECT id, task_id, oss_url, oss_object_key, oss_uploaded, file_size, status FROM media WHERE status='success' AND id LIKE 'gen-pending-17867041%' AND task_id LIKE 'gt-17867041%'"
  );
  console.log(`[fix] 找到 ${mediaRows.length} 条已修复 media`);

  let fixed = 0;
  for (const m of mediaRows) {
    const taskRes = await pool.query('SELECT result FROM generation_tasks WHERE task_id=$1', [m.task_id]);
    if (!taskRes.rows.length) continue;
    const result = taskRes.rows[0].result || {};
    const images = result.images || [];
    if (!images.length) continue;

    images[0] = {
      ...images[0],
      mediaId: m.id,
      ossUrl: m.oss_url,
      ossObjectKey: m.oss_object_key,
      ossUploaded: true,
      status: 'success',
      fileSize: Number(m.file_size) || 0,
    };
    result.images = images;
    result.status = 'success';
    delete result.finalizeErrors;

    await pool.query('UPDATE generation_tasks SET result=$2 WHERE task_id=$1', [m.task_id, JSON.stringify(result)]);
    fixed++;
    console.log(`[fix] ✅ ${m.task_id}`);
  }
  console.log(`[fix] 完成: 更新 ${fixed} 条任务`);
  await pool.end();
}

fix().catch((e) => { console.error('[fix] 致命错误:', e.message); process.exit(1); });
