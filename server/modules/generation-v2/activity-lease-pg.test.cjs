'use strict';
/**
 * L10 activity lease 真库回归测试（generation_activity_runs / 0060）。
 *
 * 覆盖（均走真 PostgreSQL，非假 pg）：
 *   1. completeActivity 写 'succeeded'（0060 CHECK 词表），不再撞 status 约束（回归 23514）。
 *   2. failActivity 'waiting_retry' / 'failed' 落库合法。
 *   3. 并发 claimActivity：两个 worker 同刻 claim，行锁（FOR UPDATE SKIP LOCKED）保证互斥，无双 claim。
 *   4. 并发 adoptActivity：两个 worker 同刻接管同一过期行，行锁保证互斥，无双接管。
 *   5. claim vs adopt 并发（pending + lease 过期双匹配）：仍只有单一 worker 接管。
 *   6. fencing：旧 owner 的 complete 在他 worker 接管后被拒（返回 null，状态不越权推进）。
 *
 * 运行：TEST_PG_PORT=5433 TEST_PG_DATABASE=moling_test node --test server/modules/generation-v2/activity-lease-pg.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createTestPool, initTestSchema, closeTestPool, assertSafeTestDatabase,
} = require('../../tests/helpers/test-db.cjs');
const {
  claimActivity, adoptActivity, renewActivityLease, completeActivity, failActivity,
} = require('./lease.cjs');

const MIGRATION_0060 = path.join(__dirname, '../../db/migrations/0060_generation_activity_runs.sql');

let pg;
test.before(async () => {
  assertSafeTestDatabase(process.env.TEST_PG_DATABASE || 'moling_test');
  pg = createTestPool();
  await initTestSchema(pg);
  await pg.query(fs.readFileSync(MIGRATION_0060, 'utf8'));
});
test.after(async () => closeTestPool(pg));
test.beforeEach(async () => {
  await pg.query('TRUNCATE generation_activity_runs RESTART IDENTITY CASCADE');
});

async function seed(id, status, opts = {}) {
  const owner = opts.owner === undefined ? null : opts.owner;
  const expiry = opts.expiry === undefined ? 'NULL' : opts.expiry;
  const nextRetry = opts.nextRetry === undefined ? "NOW() - INTERVAL '1 minute'" : opts.nextRetry;
  await pg.query(
    `INSERT INTO generation_activity_runs
       (id, job_id, attempt_id, activity_type, status, attempt_count, next_retry_at, lease_owner, lease_expires_at)
     VALUES ($1, $4, 1, 'PREPARE_ASSETS', $2, 0, ${nextRetry}, $3, ${expiry})`,
    [id, status, owner, `job-${id}`],
  );
}

test('completeActivity 写 succeeded：0060 CHECK 词表，不再撞 23514', async () => {
  await seed(1, 'running', { owner: 'w1', expiry: "NOW() + INTERVAL '1 hour'" });
  const row = await completeActivity(pg, { id: 1, workerId: 'w1' });
  assert.ok(row, 'complete 应命中并返回行');
  assert.equal(row.status, 'succeeded');
  const st = await pg.query(`SELECT status, lease_owner, lease_expires_at, completed_at FROM generation_activity_runs WHERE id=1`);
  assert.equal(st.rows[0].status, 'succeeded');
  assert.equal(st.rows[0].lease_owner, null);
  assert.equal(st.rows[0].lease_expires_at, null);
  assert.ok(st.rows[0].completed_at, '应写 completed_at');
});

test('failActivity：waiting_retry 与 failed 均落库合法', async () => {
  await seed(2, 'running', { owner: 'w1', expiry: "NOW() + INTERVAL '1 hour'" });
  const r1 = await failActivity(pg, { id: 2, workerId: 'w1', status: 'waiting_retry', errorCode: 'RATE_LIMIT' });
  assert.equal(r1.status, 'waiting_retry');
  await seed(3, 'running', { owner: 'w1', expiry: "NOW() + INTERVAL '1 hour'" });
  const r2 = await failActivity(pg, { id: 3, workerId: 'w1', status: 'failed', errorCode: 'EXHAUSTED' });
  assert.equal(r2.status, 'failed');
});

test('并发 claimActivity：行锁互斥，N 行恰好 N 个唯一 claim，无双 claim', async () => {
  for (let i = 100; i < 200; i++) await seed(i, 'pending');
  const [a, b] = await Promise.all([
    claimActivity(pg, { workerId: 'w1', limit: 100, leaseSeconds: 120 }),
    claimActivity(pg, { workerId: 'w2', limit: 100, leaseSeconds: 120 }),
  ]);
  const idsA = new Set(a.map(r => Number(r.id)));
  const idsB = new Set(b.map(r => Number(r.id)));
  const overlap = [...idsA].filter(x => idsB.has(x));
  assert.equal(overlap.length, 0, `双 claim 交集应为空，实际: ${overlap.join(',')}`);
  assert.equal(idsA.size + idsB.size, 100, `合计应恰好 100 行被 claim，实际 ${idsA.size + idsB.size}`);
});

test('并发 adoptActivity：同一过期行双接管被行锁互斥', async () => {
  for (let i = 200; i < 300; i++) await seed(i, 'running', { owner: 'dead', expiry: "NOW() - INTERVAL '1 second'" });
  const [a, b] = await Promise.all([
    adoptActivity(pg, { workerId: 'w1', limit: 100, leaseSeconds: 120 }),
    adoptActivity(pg, { workerId: 'w2', limit: 100, leaseSeconds: 120 }),
  ]);
  const idsA = new Set(a.map(r => Number(r.id)));
  const idsB = new Set(b.map(r => Number(r.id)));
  const overlap = [...idsA].filter(x => idsB.has(x));
  assert.equal(overlap.length, 0, `双接管交集应为空，实际: ${overlap.join(',')}`);
  assert.equal(idsA.size + idsB.size, 100);
});

test('claim vs adopt 并发（pending+过期双匹配）：仍只有单一 worker 接管', async () => {
  // pending 且 lease 已过期：同时满足 claim（IS NULL OR < NOW）与 adopt（< NOW）过滤。
  await seed(300, 'pending', { owner: 'dead', expiry: "NOW() - INTERVAL '1 second'" });
  const [claim, adopt] = await Promise.all([
    claimActivity(pg, { workerId: 'w1', limit: 10, leaseSeconds: 120 }),
    adoptActivity(pg, { workerId: 'w2', limit: 10, leaseSeconds: 120 }),
  ]);
  const total = claim.length + adopt.length;
  assert.equal(total, 1, `双匹配下应恰好一个 worker 接管，实际 claim=${claim.length} adopt=${adopt.length}`);
  const row = await pg.query(`SELECT lease_owner, attempt_count FROM generation_activity_runs WHERE id=300`);
  assert.equal(Number(row.rows[0].attempt_count), 1, '接管后 attempt_count 只 +1');
});

test('fencing：旧 owner 的 complete 在他 worker 接管后被拒（null）', async () => {
  await seed(400, 'running', { owner: 'w1', expiry: "NOW() - INTERVAL '1 second'" });
  await adoptActivity(pg, { workerId: 'w2', limit: 10, leaseSeconds: 120 });
  const late = await completeActivity(pg, { id: 400, workerId: 'w1' });
  assert.equal(late, null, '旧 owner complete 应被 fencing 拒');
  const row = await pg.query(`SELECT lease_owner, status FROM generation_activity_runs WHERE id=400`);
  assert.equal(row.rows[0].lease_owner, 'w2', '行仍由接管者持有');
  assert.equal(row.rows[0].status, 'running');
});

test('renewActivityLease：本人未过期续租成功；过期或被接管返回 null', async () => {
  await seed(500, 'running', { owner: 'w1', expiry: "NOW() + INTERVAL '1 hour'" });
  const ok = await renewActivityLease(pg, { id: 500, workerId: 'w1', leaseSeconds: 90 });
  assert.ok(ok, '本人续租应成功');
  const expired = await pg.query(`UPDATE generation_activity_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id=500`);
  assert.equal(expired.rowCount, 1);
  const none = await renewActivityLease(pg, { id: 500, workerId: 'w1', leaseSeconds: 90 });
  assert.equal(none, null, '过期后应返回 null（fencing）');
});
