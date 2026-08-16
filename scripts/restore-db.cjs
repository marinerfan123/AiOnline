#!/usr/bin/env node
// scripts/restore-db.cjs — 从备份目录恢复（版本无关，不依赖 psql / COPY 接口）
// 用法：node scripts/restore-db.cjs [backupDir]
//   不传 backupDir 时，自动选 backups/db/ 下最新一个目录。
// 流程：TRUNCATE 全部表（RESTART IDENTITY CASCADE）→ 跳过 FK 检查 → 批量 INSERT ndjson → 重置序列。
// 注意：会清空当前所有 public 表数据，请确认目标正确！
const fs = require('fs');
const path = require('path');
const readline = require('readline');
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

const BATCH = 500;

function resolveDir(arg) {
  if (arg) return path.resolve(arg);
  const base = path.resolve(__dirname, '..', 'backups', 'db');
  if (!fs.existsSync(base)) throw new Error('no backups dir: ' + base);
  const dirs = fs
    .readdirSync(base)
    .filter((d) => fs.statSync(path.join(base, d)).isDirectory())
    .sort();
  if (!dirs.length) throw new Error('no backups found under ' + base);
  return path.join(base, dirs[dirs.length - 1]);
}

(async () => {
  const dir = resolveDir(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tables = Object.keys(manifest.tables);
  console.log('[restore] from', dir);
  console.log('[restore] will TRUNCATE + reload', tables.length, 'tables');
  const client = await pool.connect();
  try {
    await client.query(`SET session_replication_role = 'replica'`);
    for (const t of tables) {
      await client.query(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`);
    }
    for (const t of tables) {
      const ndjsonPath = path.join(dir, `${t}.ndjson`);
      if (!fs.existsSync(ndjsonPath)) {
        console.warn('[restore] skip (missing ndjson):', t);
        continue;
      }
      const colsRes = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        [t]
      );
      const cols = colsRes.rows.map((r) => r.column_name);
      const colCount = cols.length;
      const insertBase = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES `;
      const rs = fs.createReadStream(ndjsonPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
      let batch = [];
      let loaded = 0;
      const flush = async () => {
        if (!batch.length) return;
        const params = [];
        const parts = batch.map((_, i) => {
          const base = i * colCount;
          for (const c of cols) {
            const v = batch[i][c];
            params.push(v === undefined ? null : v);
          }
          return `(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`;
        });
        await client.query(insertBase + parts.join(','), params);
        loaded += batch.length;
        batch = [];
      };
      for await (const line of rl) {
        if (!line.trim()) continue;
        batch.push(JSON.parse(line));
        if (batch.length >= BATCH) await flush();
      }
      await flush();
      // 重置自增序列，避免恢复后主键冲突
      try {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1,$2), COALESCE((SELECT max("${cols[0]}") FROM "${t}"), 1))`,
          [t, cols[0]]
        );
      } catch { /* 无序列的列忽略 */ }
      console.log(`[restore] ${t.padEnd(30)} loaded=${loaded}`);
    }
    await client.query(`SET session_replication_role = 'origin'`);
    console.log('[restore] DONE — all tables reloaded from backup');
  } finally {
    await client.query(`SET session_replication_role = 'origin'`).catch(() => {});
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('[restore] FAILED:', e.message);
  process.exit(1);
});
