// server/scripts/repair-base64-media.cjs
// 一次性修复：把 media 表中 full_url 为 data:image/...;base64,... 的历史记录重新上传到 OSS。
// 背景：assetFinalize.fetchBytes 之前不支持 data: URI，导致 provider 返回 b64_json 时直接落库为 base64 内联。
// 用法：node server/scripts/repair-base64-media.cjs

const { pool } = require('../db.cjs');
const assetFinalize = require('../assetFinalize.cjs');

async function main() {
  const { rows } = await pool.query(
    `SELECT id, task_id, user_id, full_url, type, prompt, model, ratio
     FROM media
     WHERE full_url LIKE 'data:image%'
     ORDER BY created_at DESC`
  );

  if (!rows.length) {
    console.log('没有找到 base64 内联图片记录，无需修复。');
    await pool.end();
    return;
  }

  console.log(`找到 ${rows.length} 条 base64 内联图片记录，开始重新最终化到 OSS...`);
  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (const row of rows) {
    const tag = `[${row.id}]`;
    try {
      if (!row.user_id) {
        console.log(`${tag} SKIP: 缺少 user_id`);
        skipped++;
        continue;
      }
      if (!row.full_url || !row.full_url.startsWith('data:image')) {
        console.log(`${tag} SKIP: 非图片 data URI`);
        skipped++;
        continue;
      }

      const r = await assetFinalize.finalizeUrl(pool, {
        userId: row.user_id,
        taskId: row.task_id || `repair-${row.id}`,
        idx: 0,
        providerUrl: row.full_url,
        type: row.type || 'image',
        prompt: row.prompt || '',
        model: row.model || '',
        ratio: row.ratio || '1:1',
        pendingId: row.id,
      });

      const urlPreview = r.ossUrl ? r.ossUrl.slice(0, 80) + '...' : '(empty)';
      console.log(`${tag} ${r.status} -> ${urlPreview}`);
      if (r.status === 'success') ok++;
      else fail++;
    } catch (e) {
      console.error(`${tag} ERR: ${e.message}`);
      fail++;
    }
  }

  console.log(`\n修复完成：成功=${ok} 失败=${fail} 跳过=${skipped}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
