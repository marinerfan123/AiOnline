'use strict';
/**
 * 0065 generation_output_manifests 迁移测试（L27）。
 *
 * 覆盖（真实 PG，与 phase-monotonic.test.cjs / migration.test.cjs 同套环境变量）：
 *   1. discoverMigrations 正确发现 0065 output_manifest，且 classifyMigration 判为 additive/data（非 destructive，
 *      不会被非破坏默认值拦截）。
 *   2. 0065 SQL 在真实 PG 上可直接执行（CREATE TABLE + 索引 + COMMENT 全部合法）。
 *   3. generation_output_manifests 含全部规范列：job_id(PK)/attempt_id/provider_manifest(JSONB)/
 *      artifacts(JSONB)/media_ids(TEXT[])/finalized_at/retry_count。
 *   4. provider_manifest JSONB 原样往返（零改写）；artifacts 归一列表往返；media_ids TEXT[] 含 NULL 下标对齐往返。
 *   5. retry_count CHECK >= 0 拒绝负值；ON CONFLICT (job_id) upsert 幂等（同 job 重复写不产生新行）。
 *
 * 说明：本测试只直执行 0065 自身的 SQL（不跑全量 migrate 链），因为同目录下并行批次已落
 *   0063/0064/0066/0067/0071 等文件（0063 的 Rollback 注释里出现「DROP TABLE」字样，被
 *   classifyMigration 的保守正则误判为 destructive，非破坏默认值会拦截全链）。本叶只验证
 *   0065 自洽：SQL 合法 + 表结构正确 + 语义正确，不依赖其它批次文件是否可全链应用。
 *
 * 运行：TEST_PG_HOST=… TEST_PG_PORT=… node --test server/db/output-manifest.test.cjs
 * （默认 localhost:5432 postgres / 0.0.1abcd，与 migration.test.cjs 同套环境变量。）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { discoverMigrations, classifyMigration } = require('./migrate.cjs');

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';

const adminPool = new Pool({ host: pgHost, port: pgPort, user: pgUser, password: pgPass, database: 'postgres', max: 1 });

function randomSuffix() { return crypto.randomBytes(4).toString('hex'); }

async function createTestDb(suffix) {
  const dbName = `moling_output_manifest_test_${suffix}`;
  await adminPool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  return dbName;
}

async function dropTestDb(dbName) {
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch (_) { /* best-effort teardown */ }
}

let dbName;
let pg;

test.before(async () => {
  dbName = await createTestDb(randomSuffix());
  pg = new Pool({ host: pgHost, port: pgPort, user: pgUser, password: pgPass, database: dbName, max: 1 });
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '0065_output_manifest.sql'), 'utf8');
  await pg.query(sql); // 直执行 0065（CREATE TABLE IF NOT EXISTS 幂等可重放）
});

test.after(async () => {
  if (pg) { await pg.end().catch(() => {}); }
  if (dbName) { await dropTestDb(dbName); }
});

test('0065: discoverMigrations 发现 0065 output_manifest，且分类非 destructive', () => {
  const all = discoverMigrations();
  const m = all.find((x) => x.version === '0065');
  assert.ok(m, 'discoverMigrations 应发现 0065');
  assert.equal(m.name, 'output_manifest');

  const sql = fs.readFileSync(m.filePath, 'utf8');
  const cls = classifyMigration(sql);
  assert.notEqual(cls.kind, 'destructive', `0065 不应被判为 destructive（实际 ${cls.kind}）`);

  // 排序：0065 紧随 0064 之后、0066 之前
  const versions = all.map((x) => x.version);
  const i65 = versions.indexOf('0065');
  assert.ok(i65 > 0, '0065 应在迁移链中');
  if (versions.includes('0064')) assert.equal(versions[i65 - 1], '0064', '0065 应紧随 0064');
});

test('0065: generation_output_manifests 表存在且含全部规范列 + PK=job_id', async () => {
  const r = await pg.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'generation_output_manifests'
    ORDER BY ordinal_position
  `);
  const cols = new Map(r.rows.map((c) => [c.column_name, c]));

  for (const name of ['job_id', 'attempt_id', 'provider_manifest', 'artifacts', 'media_ids', 'finalized_at', 'retry_count', 'created_at', 'updated_at']) {
    assert.ok(cols.has(name), `generation_output_manifests 应有 ${name} 列`);
  }
  assert.equal(cols.get('job_id').data_type, 'text');
  assert.equal(cols.get('provider_manifest').data_type, 'jsonb');
  assert.equal(cols.get('artifacts').data_type, 'jsonb');
  assert.equal(cols.get('media_ids').data_type, 'ARRAY');
  assert.equal(cols.get('retry_count').data_type, 'integer');
  assert.equal(cols.get('finalized_at').is_nullable, 'YES');

  const pk = await pg.query(`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'generation_output_manifests'::regclass AND i.indisprimary
  `);
  assert.deepStrictEqual(pk.rows.map((r) => r.attname), ['job_id'], 'PK 应为 job_id');
});

test('0065: provider_manifest JSONB 原样往返 + artifacts 归一往返 + media_ids TEXT[] NULL 对齐', async () => {
  const manifest = {
    artifacts: [
      { role: 'primary_video', media_type: 'video/mp4', source: 'https://cdn.example.com/v.mp4' },
      { role: 'thumbnail', media_type: 'image/jpeg', source: 'https://cdn.example.com/t.jpg' },
    ],
    provider_metadata: { provider: 'kling', task_id: 'kling-xyz' },
  };
  const artifacts = [
    { url: 'https://cdn.example.com/v.mp4', kind: 'primary_video', mimeType: 'video/mp4', sizeBytes: 1234, checksum: 'sha256:abc' },
    { url: 'https://cdn.example.com/t.jpg', kind: 'thumbnail', mimeType: 'image/jpeg', sizeBytes: null },
  ];
  await pg.query(
    `INSERT INTO generation_output_manifests (job_id, attempt_id, provider_manifest, artifacts, media_ids)
     VALUES ($1,$2,$3,$4,$5)`,
    ['job-r-1', 'attempt-r-1', JSON.stringify(manifest), JSON.stringify(artifacts), ['m-1', null]],
  );
  const r = await pg.query(
    `SELECT provider_manifest, artifacts, media_ids FROM generation_output_manifests WHERE job_id = 'job-r-1'`
  );
  assert.deepStrictEqual(r.rows[0].provider_manifest, manifest, 'provider_manifest 必须原样往返（JSONB 零改写）');
  assert.deepStrictEqual(r.rows[0].artifacts, artifacts, 'artifacts 归一列表必须原样往返');
  assert.deepStrictEqual(r.rows[0].media_ids, ['m-1', null], 'media_ids TEXT[] 应保留 NULL 下标对齐');
});

test('0065: retry_count CHECK >= 0 拒绝负值', async () => {
  await assert.rejects(
    pg.query(
      `INSERT INTO generation_output_manifests (job_id, attempt_id, retry_count)
       VALUES ('job-neg', 'a-1', -1)`
    ),
    /retry_count/,
    '负 retry_count 应被 CHECK 拒绝',
  );
});

test('0065: job_id 幂等锚点（同 job upsert 不产生新行）', async () => {
  await pg.query(
    `INSERT INTO generation_output_manifests (job_id, attempt_id, provider_manifest, retry_count)
     VALUES ('job-u-1', 'a-1', '{}'::jsonb, 0)`
  );
  await pg.query(
    `INSERT INTO generation_output_manifests (job_id, attempt_id, provider_manifest, retry_count)
     VALUES ('job-u-1', 'a-1', '{"x":1}'::jsonb, 1)
     ON CONFLICT (job_id) DO UPDATE SET retry_count = EXCLUDED.retry_count, provider_manifest = EXCLUDED.provider_manifest`
  );
  const r = await pg.query(`SELECT retry_count, provider_manifest FROM generation_output_manifests WHERE job_id = 'job-u-1'`);
  assert.equal(r.rows.length, 1, '同 job_id upsert 后应仅一行');
  assert.equal(r.rows[0].retry_count, 1);
  assert.deepStrictEqual(r.rows[0].provider_manifest, { x: 1 });
});
