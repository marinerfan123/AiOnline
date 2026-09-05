'use strict';
/**
 * finance.reconcile 漏 refund kind 的修复测试（审计 C HIGH）。
 *
 * 修复语义（finance.cjs reconcile）：
 *   - refund 行按 amount 加回 sim（与 release 同规），不采信 balance_after ——
 *     因为 billing.refundUserCharge 写 balance_after 时取的是 INSERT 前的余额快照
 *     （balance_after 落在 +charge UPDATE 之前），退款后快照不对称、非权威。
 *   - 防双算：(ref, kind) 唯一约束 uq_credit_transactions_ref_kind（0004）+ billing
 *     ON CONFLICT (ref, kind) DO NOTHING 保证同 kind+ref 只落一行；reconcile 逐行扫描，
 *     幂等行不会重复出现，故无需额外去重。
 *
 * Coverage（全绿目标）：
 *   T1 含 refund（200→194 commit + 退款 10）  → reconcile 0 告警、sim 正确；重复退款幂等不双算
 *   T2 无 refund（reserve/release/commit/grant/adjust 全量）→ reconcile 0 告警（行为不变）
 *   T3 纯 refund（仅退款行、无权威快照）        → 不误报 mismatch；按文档回 no_snapshot
 *
 * 真库实测：TEST_PG_PORT=5433（或 54329）throwaway 库，跑完即 drop。
 */
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const crypto = require('crypto');

const billing = require('./billing.cjs');
const { createFinance } = require('./finance.cjs');
const { migrate } = require('./db/migrate.cjs');

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || '127.0.0.1';
const pgPort = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5433');
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';

const adminPool = new Pool({ connectionString: `postgresql://${pgUser}:${pgPass}@${pgHost}:${pgPort}/postgres`, max: 1 });

let dbName;
let pg;
let reconcile;

function randomSuffix() { return crypto.randomBytes(4).toString('hex'); }

async function insertUser(id, rechargeCredits, rewardCredits = 0) {
  await pg.query(
    `INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits)
     VALUES ($1, $2, $3, '$2b$10$fakehash', $4, $5)`,
    [id, `${id}@test.local`, id, rewardCredits, rechargeCredits],
  );
}

async function creditsOf(id) {
  const r = await pg.query('SELECT credits FROM users WHERE id=$1', [id]);
  return Number(r.rows[0].credits);
}

// 与 payments/webhook.cjs（grant）一致：先 UPDATE 加余额，再以更新后的 credits 记 balance_after（权威快照）。
async function grantCredits(id, amount, ref) {
  const r = await pg.query(
    `UPDATE users SET recharge_credits = recharge_credits + $1 WHERE id=$2 RETURNING credits`,
    [amount, id],
  );
  const newCredits = Number(r.rows[0].credits);
  await pg.query(
    `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
     VALUES ($1,'grant',$2,$3,'recharge',$4)`,
    [id, amount, ref, newCredits],
  );
}

// 与 admin.cjs recharge（adjust）一致：先 UPDATE 调整余额，再以更新后的 credits 记 balance_after（权威快照）。
async function adjustCredits(id, amount, ref) {
  const r = await pg.query(
    `UPDATE users SET recharge_credits = recharge_credits + $1 WHERE id=$2 RETURNING credits`,
    [amount, id],
  );
  const newCredits = Number(r.rows[0].credits);
  await pg.query(
    `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
     VALUES ($1,'adjust',$2,$3,'recharge',$4)`,
    [id, amount, ref, newCredits],
  );
}

before(async () => {
  dbName = `moling_finrec_${randomSuffix()}`;
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  pg = new Pool({ host: pgHost, port: pgPort, user: pgUser, password: pgPass, database: dbName, max: 8 });
  await migrate(pg);
  reconcile = createFinance({ getPg: () => pg }).reconcile;
});

after(async () => {
  if (pg) { await pg.end().catch(() => {}); }
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch (_) {}
  await adminPool.end();
});

// ─── T1: 含 refund（200→194 commit + 退款 10）→ 0 告警，sim 正确；重复退款不双算 ───
test('T1: reconcile counts refund by amount (200→194 commit + refund 10), duplicate refund not double-counted', async () => {
  const uid = 'u-refund';
  await insertUser(uid, 200, 0);
  assert.equal(await creditsOf(uid), 200, 'sanity: starts at 200');

  await billing.reserveCreditsV2(pg, { userId: uid, estimated: 6, ref: 'r1-res', pool: 'recharge' });
  await billing.commitCreditsV2(pg, { userId: uid, actual: 6, userCharge: 6, estimated: 6, ref: 'r1-com', pool: 'recharge' });
  assert.equal(await creditsOf(uid), 194, '6 committed → 194');

  const r1 = await billing.refundUserCharge(pg, { userId: uid, userCharge: 10, actual: 10, ref: 'r1-refund', pool: 'recharge' });
  assert.equal(r1.idempotent, false);
  assert.equal(await creditsOf(uid), 204, 'refund 10 → 204');

  // 关键：refund 行 balance_after 是 INSERT 前的快照（194），非权威——若 reconcile 采信它会 mismatch。
  const refRow = await pg.query(`SELECT amount, balance_after FROM credit_transactions WHERE ref=$1 AND kind='refund'`, ['r1-refund']);
  assert.equal(Number(refRow.rows[0].amount), 10, 'refund amount recorded');
  assert.equal(Number(refRow.rows[0].balance_after), 194, 'refund balance_after is stale pre-refund snapshot (non-authoritative)');

  // 重复退款（同 ref+kind）→ 幂等，不落第二行、不双加余额。
  const r2 = await billing.refundUserCharge(pg, { userId: uid, userCharge: 10, actual: 10, ref: 'r1-refund', pool: 'recharge' });
  assert.equal(r2.idempotent, true, 'duplicate refund is idempotent');
  assert.equal(await creditsOf(uid), 204, 'balance not double-refunded');
  const cnt = await pg.query(`SELECT COUNT(*) AS c FROM credit_transactions WHERE ref=$1 AND kind='refund'`, ['r1-refund']);
  assert.equal(Number(cnt.rows[0].c), 1, 'exactly one refund row (row-level dedup via (ref,kind) unique)');

  // reconcile：sim = commit balance_after(194) + refund amount(10) = 204 == real → 0 告警。
  const result = await reconcile();
  assert.equal(result.alerts.filter(a => a.userId === uid).length, 0, 'reconcile reports no alert for refund account (sim correct)');
});

// ─── T2: 无 refund（reserve/release/commit/grant/adjust 全量）→ 行为不变，0 告警 ───
test('T2: no-refund ledger (reserve/release/commit/grant/adjust) still reconciles to 0 alerts', async () => {
  const uid = 'u-norefund';
  await insertUser(uid, 1000, 0);

  await billing.reserveCreditsV2(pg, { userId: uid, estimated: 100, ref: 'nr-res', pool: 'recharge' });   // 1000→900
  await billing.releaseCredits(pg, uid, 100, 'nr-rel', 'recharge');                                        // 900→1000
  await billing.reserveCreditsV2(pg, { userId: uid, estimated: 50, ref: 'nr-res2', pool: 'recharge' });    // 1000→950
  await billing.commitCreditsV2(pg, { userId: uid, actual: 40, userCharge: 40, estimated: 50, ref: 'nr-com', pool: 'recharge' }); // 950→960（退多扣 10）
  await grantCredits(uid, 30, 'nr-grant');   // 960→990（grant 权威快照 990）
  await adjustCredits(uid, -5, 'nr-adjust'); // 990→985（adjust 权威快照 985）

  assert.equal(await creditsOf(uid), 985, 'final balance 985');

  const result = await reconcile();
  assert.equal(result.alerts.filter(a => a.userId === uid).length, 0, 'no-refund ledger reconciles to 0 alerts (behavior unchanged)');
});

// ─── T3: 纯 refund（仅退款行、无权威快照）→ 不误报 mismatch，按文档回 no_snapshot ───
test('T3: pure-refund account (no snapshot) yields no_snapshot, never a false mismatch', async () => {
  const uid = 'u-purerefund';
  await insertUser(uid, 50, 0); // 注册默认 50
  await billing.refundUserCharge(pg, { userId: uid, userCharge: 10, actual: 10, ref: 'p1-refund', pool: 'recharge' });
  assert.equal(await creditsOf(uid), 60, 'refund 10 → 60');

  // 纯 refund 无 commit/grant/adjust 权威快照 → sim 无法重建绝对值（预修复即如此，本次仅补白名单不改该语义）。
  const result = await reconcile();
  const alerts = result.alerts.filter(a => a.userId === uid);
  assert.equal(alerts.filter(a => a.status === 'mismatch').length, 0, 'refund whitelisted: no false mismatch');
  assert.equal(alerts.length, 1, 'exactly one alert (documented no_snapshot)');
  assert.equal(alerts[0].status, 'no_snapshot', 'pure refund without snapshot → no_snapshot (documented limitation)');
  assert.equal(alerts[0].real, 60, 'no_snapshot carries real balance 60');
});
