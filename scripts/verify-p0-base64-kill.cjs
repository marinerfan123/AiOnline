'use strict';
// P0 Base64 Kill — 真库 SQL 证据：真实 finalizeUrl 落库后，media 行不含任何 data URI/base64。
// 用法：node scripts/verify-p0-base64-kill.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { finalizeUrl } = require('../server/assetFinalize.cjs');
const { createLocalMediaStore } = require('../server/modules/media/localMediaStore.cjs');

const cfg = {
  host: process.env.PGHOST || '/home/dministrator/pg-local/sock',
  port: Number(process.env.PGPORT || 5441),
  database: process.env.PGDATABASE || 'moling',
  user: process.env.PGUSER || 'moling',
  password: process.env.PGPASSWORD || '',
};

const PAYLOAD = crypto.randomBytes(128);
const DATA_URI = `data:image/png;base64,${PAYLOAD.toString('base64')}`;
const TASK_ID = `p0-evid-${Date.now()}`;
const MEDIA_ID = `mf-p0-evid-${Date.now()}`;

async function main() {
  const pool = new Pool(cfg);
  const store = createLocalMediaStore({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'p0-evidence-')) });
  try {
    const before = (await pool.query(`SELECT count(*)::int n FROM media WHERE provider_url LIKE 'data:%'`)).rows[0].n;

    const res = await finalizeUrl(pool, {
      userId: 'u-local-admin', taskId: TASK_ID, idx: 0, providerUrl: DATA_URI, type: 'image',
      prompt: 'p0-evidence', model: 'p0', ratio: '1:1', pendingId: MEDIA_ID, managedStore: store,
    });

    const row = (await pool.query(`SELECT id, full_url, oss_url, provider_url, status FROM media WHERE id=$1`, [MEDIA_ID])).rows[0];
    const after = (await pool.query(`SELECT count(*)::int n FROM media WHERE provider_url LIKE 'data:%'`)).rows[0].n;

    const json = JSON.stringify(row);
    const hasDataUri = /data:image\/[^"]*;base64,/.test(json) || /base64,/.test(json);
    const managedOk = (row.oss_url || '').startsWith('/local-media/');
    const readback = managedOk
      ? (await store.get({ objectKey: require('../server/oss.cjs').decodeUrlKey(row.oss_url) })).equals(PAYLOAD)
      : false;

    console.log('=== P0 Base64 Kill 真库证据 ===');
    console.log(`finalize.status          = ${res.status}`);
    console.log(`media.oss_url            = ${(row.oss_url || '').slice(0, 70)}`);
    console.log(`media.provider_url       = ${(row.provider_url || '').slice(0, 70)}`);
    console.log(`media.full_url           = ${(row.full_url || '').slice(0, 70)}`);
    console.log(`media.status             = ${row.status}`);
    console.log(`data URI 落库            = ${hasDataUri ? '✗ 是（违规）' : '✓ 否'}`);
    console.log(`managed local URL        = ${managedOk ? '✓ 是' : '✗ 否'}`);
    console.log(`readback 字节一致        = ${readback ? '✓ 是' : '✗ 否'}`);
    console.log(`provider_url data: 行数   before=${before} after=${after}（历史行不迁移，新增应=0）`);
    const delta = after - before;
    console.log(`新增 data URI 行          = ${delta}（应为 0）`);

    // 清理证据行
    await pool.query(`DELETE FROM media WHERE id=$1`, [MEDIA_ID]);

    const pass = res.status === 'success' && !hasDataUri && managedOk && readback && delta === 0;
    console.log(`\n结论: ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
    process.exit(pass ? 0 : 1);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
