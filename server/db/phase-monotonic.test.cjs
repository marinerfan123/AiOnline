'use strict';
/**
 * 0061 phase+reason 单调性测试（L12）。
 *
 * 覆盖：
 *   1. generation_tasks / generation_items_v2 均有 phase + reason 列，且均 NULL 容忍。
 *   2. phase CHECK 约束接受全部 §46 词表（12 值），拒绝词表外值。
 *   3. 单调触发器拒绝反向 phase（§62）；放行前进 / 同 phase / NULL↔值 转换。
 *   4. reason 开放词表（§47），任意文本 + NULL 均可。
 *
 * 运行：TEST_PG_HOST=… TEST_PG_PORT=… node --test server/db/phase-monotonic.test.cjs
 * （默认 localhost:5432 postgres，与 migration.test.cjs 同套环境变量。）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');

const { migrate } = require('./migrate.cjs');

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';

const adminPool = new Pool({
  host: pgHost, port: pgPort, user: pgUser, password: pgPass,
  database: 'postgres', max: 1,
});

// §46 phase 词表（权威顺序）——单调序即此数组下标序。
const PHASE_ORDER = [
  'VALIDATING', 'RESERVING', 'WAITING_CAPACITY', 'PREPARING_ASSETS',
  'SUBMITTING', 'PROVIDER_QUEUE', 'PROVIDER_RUNNING', 'FETCHING_OUTPUT',
  'FINALIZING', 'SETTLING', 'RECONCILING', 'CANCELING',
];

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

async function createTestDb(suffix) {
  const dbName = `moling_phase_mono_test_${suffix}`;
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
  pg = new Pool({
    host: pgHost, port: pgPort, user: pgUser, password: pgPass,
    database: dbName, max: 1,
  });
  const result = await migrate(pg);
  assert.ok(result.applied > 0, 'migration chain should apply (incl. 0061)');
});

test.after(async () => {
  if (pg) { await pg.end().catch(() => {}); }
  if (dbName) { await dropTestDb(dbName); }
  await adminPool.end().catch(() => {});
});

test('0061: generation_tasks + generation_items_v2 均含 NULL 容忍的 phase/reason 列', async () => {
  for (const table of ['generation_tasks', 'generation_items_v2']) {
    const r = await pg.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = $1 AND column_name IN ('phase', 'reason')
      ORDER BY column_name`, [table]);
    const cols = r.rows.map(x => `${x.column_name}:${x.is_nullable}`);
    assert.deepEqual(cols, ['phase:YES', 'reason:YES'],
      `${table} 应有可空 phase/reason 列，实际 ${cols.join(', ')}`);
  }
});

test('0061: phase CHECK 接受全部 §46 词表值（两表）', async () => {
  // generation_tasks：一条记录顺序推进 12 态，验证每态均落库。
  await pg.query(`INSERT INTO generation_tasks (task_id) VALUES ('t-vocab')`);
  for (const p of PHASE_ORDER) {
    await pg.query(`UPDATE generation_tasks SET phase = $1 WHERE task_id = 't-vocab'`, [p]);
    const r = await pg.query(`SELECT phase FROM generation_tasks WHERE task_id = 't-vocab'`);
    assert.equal(r.rows[0].phase, p, `generation_tasks 应接受 phase=${p}`);
  }

  // generation_items_v2：12 条 item 各置一 phase（需先建 batch）。
  await pg.query(`INSERT INTO generation_batches_v2 (batch_id, user_id, model_id)
                  VALUES ('b-vocab', 'u-vocab', 'm-vocab')`);
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    await pg.query(`INSERT INTO generation_items_v2 (item_id, batch_id, item_index, phase)
                    VALUES ($1, 'b-vocab', $2, $3)`,
      [`i-vocab-${i}`, i, PHASE_ORDER[i]]);
  }
  const r = await pg.query(
    `SELECT count(*)::int AS n FROM generation_items_v2
     WHERE batch_id = 'b-vocab' AND phase IS NOT NULL`);
  assert.equal(r.rows[0].n, PHASE_ORDER.length, 'generation_items_v2 应接受全部 12 个 phase');
});

test('0061: phase CHECK 拒绝词表外值（两表）', async () => {
  await pg.query(`INSERT INTO generation_tasks (task_id) VALUES ('t-bogus')`);
  await assert.rejects(
    pg.query(`UPDATE generation_tasks SET phase = 'BOGUS' WHERE task_id = 't-bogus'`),
    /phase|check_violation/i,
    'generation_tasks 应拒绝非法 phase');
  await assert.rejects(
    pg.query(`INSERT INTO generation_items_v2 (item_id, batch_id, item_index, phase)
              VALUES ('i-bogus', 'b-vocab', 999, 'NOT_A_PHASE')`),
    /phase|check_violation/i,
    'generation_items_v2 应拒绝非法 phase');
});

test('0061: 反向 phase 更新被拒（generation_tasks, §62）', async () => {
  await pg.query(`INSERT INTO generation_tasks (task_id, phase) VALUES ('t-rev', 'PROVIDER_RUNNING')`);
  await assert.rejects(
    pg.query(`UPDATE generation_tasks SET phase = 'SUBMITTING' WHERE task_id = 't-rev'`),
    /monotonic violation/i,
    'PROVIDER_RUNNING -> SUBMITTING 反向应被拒');
  const r = await pg.query(`SELECT phase FROM generation_tasks WHERE task_id = 't-rev'`);
  assert.equal(r.rows[0].phase, 'PROVIDER_RUNNING', '被拒后 phase 应保持不变');
});

test('0061: 反向 phase 更新被拒（generation_items_v2, §62）', async () => {
  await pg.query(`INSERT INTO generation_items_v2 (item_id, batch_id, item_index, phase)
                  VALUES ('i-rev', 'b-vocab', 1000, 'FINALIZING')`);
  await assert.rejects(
    pg.query(`UPDATE generation_items_v2 SET phase = 'SUBMITTING' WHERE item_id = 'i-rev'`),
    /monotonic violation/i,
    'FINALIZING -> SUBMITTING 反向应被拒');
  const r = await pg.query(`SELECT phase FROM generation_items_v2 WHERE item_id = 'i-rev'`);
  assert.equal(r.rows[0].phase, 'FINALIZING', '被拒后 phase 应保持不变');
});

test('0061: 前进 / 同 phase 更新放行（两表）', async () => {
  // 前进：SUBMITTING -> PROVIDER_QUEUE -> PROVIDER_RUNNING
  await pg.query(`INSERT INTO generation_tasks (task_id, phase) VALUES ('t-fwd', 'SUBMITTING')`);
  await pg.query(`UPDATE generation_tasks SET phase = 'PROVIDER_QUEUE' WHERE task_id = 't-fwd'`);
  await pg.query(`UPDATE generation_tasks SET phase = 'PROVIDER_RUNNING' WHERE task_id = 't-fwd'`);
  const t = await pg.query(`SELECT phase FROM generation_tasks WHERE task_id = 't-fwd'`);
  assert.equal(t.rows[0].phase, 'PROVIDER_RUNNING', '前进推进应放行');

  // 同 phase（心跳/改 reason 场景）：PROVIDER_RUNNING -> PROVIDER_RUNNING
  await pg.query(
    `UPDATE generation_tasks SET phase = 'PROVIDER_RUNNING', reason = 'PROVIDER_THROTTLED'
     WHERE task_id = 't-fwd'`);
  const t2 = await pg.query(`SELECT phase, reason FROM generation_tasks WHERE task_id = 't-fwd'`);
  assert.equal(t2.rows[0].phase, 'PROVIDER_RUNNING', '同 phase 应放行');
  assert.equal(t2.rows[0].reason, 'PROVIDER_THROTTLED', '同 phase 更新可写 reason');

  // items 侧前进
  await pg.query(`INSERT INTO generation_items_v2 (item_id, batch_id, item_index, phase)
                  VALUES ('i-fwd', 'b-vocab', 1001, 'SUBMITTING')`);
  await pg.query(`UPDATE generation_items_v2 SET phase = 'PROVIDER_RUNNING' WHERE item_id = 'i-fwd'`);
  const i = await pg.query(`SELECT phase FROM generation_items_v2 WHERE item_id = 'i-fwd'`);
  assert.equal(i.rows[0].phase, 'PROVIDER_RUNNING', 'items 前进推进应放行');
});

test('0061: NULL↔phase 双向放行（列 NULL 容忍语义）', async () => {
  // NULL -> phase
  await pg.query(`INSERT INTO generation_tasks (task_id) VALUES ('t-null')`);
  await pg.query(`UPDATE generation_tasks SET phase = 'VALIDATING' WHERE task_id = 't-null'`);
  let r = await pg.query(`SELECT phase FROM generation_tasks WHERE task_id = 't-null'`);
  assert.equal(r.rows[0].phase, 'VALIDATING', 'NULL -> phase 应放行');

  // phase -> NULL（清空内部标记，非阶梯回退）
  await pg.query(`UPDATE generation_tasks SET phase = NULL WHERE task_id = 't-null'`);
  r = await pg.query(`SELECT phase FROM generation_tasks WHERE task_id = 't-null'`);
  assert.equal(r.rows[0].phase, null, 'phase -> NULL 应放行');

  // 默认新行 phase 为 NULL（无 DEFAULT）
  const d = await pg.query(
    `SELECT phase, reason FROM generation_tasks WHERE task_id = 't-null'`);
  assert.equal(d.rows[0].phase, null, '新行 phase 默认 NULL');
  assert.equal(d.rows[0].reason, null, '新行 reason 默认 NULL');
});

test('0061: reason 开放词表（§47）——任意文本 + NULL 均可', async () => {
  await pg.query(`INSERT INTO generation_tasks (task_id) VALUES ('t-reason')`);
  for (const r of ['PROVIDER_THROTTLED', 'RATE_LIMIT', 'WAITING_RETRY',
                   'ASSET_DOWNLOAD_RETRY', 'SUBMIT_UNKNOWN', 'CUSTOM_FUTURE_REASON']) {
    await pg.query(`UPDATE generation_tasks SET reason = $1 WHERE task_id = 't-reason'`, [r]);
    const got = await pg.query(`SELECT reason FROM generation_tasks WHERE task_id = 't-reason'`);
    assert.equal(got.rows[0].reason, r, `reason 应接受开放词表值 ${r}`);
  }
  await pg.query(`UPDATE generation_tasks SET reason = NULL WHERE task_id = 't-reason'`);
  const got = await pg.query(`SELECT reason FROM generation_tasks WHERE task_id = 't-reason'`);
  assert.equal(got.rows[0].reason, null, 'reason 应可置 NULL');
});
