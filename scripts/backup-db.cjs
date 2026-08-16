#!/usr/bin/env node
// scripts/backup-db.cjs — 逻辑备份（版本无关，不依赖 pg_dump / COPY / 事件流）
// 对每个 public 表用服务端游标 (DECLARE CURSOR + FETCH 分批) 流式导出为 ndjson。
// 恢复见 scripts/restore-db.cjs。
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'huabu',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  max: 1,
});

const FETCH = 1000;
function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

(async () => {
  const backupDir = path.resolve(__dirname, '..', 'backups', 'db', ts());
  fs.mkdirSync(backupDir, { recursive: true });
  const client = await pool.connect();
  console.log('[backup] connected to', pool.options.database, '@', pool.options.host);
  try {
    const { rows: tblRows } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    const tables = tblRows.map((r) => r.tablename);
    console.log('[backup] found', tables.length, 'public tables');
    const manifest = {
      database: pool.options.database,
      host: pool.options.host,
      createdAt: new Date().toISOString(),
      format: 'ndjson',
      tables: {},
    };
    let totalRows = 0;
    for (const t of tables) {
      const jsonlPath = path.join(backupDir, `${t}.ndjson`);
      const ws = fs.createWriteStream(jsonlPath);
      await client.query('BEGIN');
      await client.query(`DECLARE cur CURSOR FOR SELECT * FROM "${t}"`);
      let count = 0;
      for (;;) {
        const fr = await client.query('FETCH ' + FETCH + ' FROM cur');
        if (!fr.rows.length) break;
        for (const row of fr.rows) {
          ws.write(JSON.stringify(row));
          ws.write('\n');
          count++;
        }
      }
      await client.query('CLOSE cur');
      await client.query('COMMIT');
      await new Promise((r) => ws.end(r));
      const sz = fs.statSync(jsonlPath).size;
      manifest.tables[t] = { rows: count, file: `${t}.ndjson`, bytes: sz };
      totalRows += count;
      console.log(`[backup] ${t.padEnd(30)} rows=${String(count).padStart(9)}  ${(sz / 1024).toFixed(1)}KB`);
    }
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('[backup] manifest written; total rows =', totalRows);
    console.log('BACKUP_DIR=' + backupDir);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('[backup] FAILED:', e.message);
  process.exit(1);
});
