'use strict';
// Standalone real-PostgreSQL verification for G20 budget-spent audit.
// Targets a trust-auth local cluster via AUDIT_PG_* env (default localhost:54329).
// Creates a dedicated throwaway DB, applies 0031+0044, and exercises
// recordSpend/getBudgetSpent against REAL row-lock / unique-index semantics.
// Run: AUDIT_PG_PORT=54329 node this-file.cjs
// If the target PG is unreachable the script prints SKIP and exits 0 (never a
// hard failure) — it is not part of the CI test globs.
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getBudgetSpent, recordSpend } = require('./budgetSpentStore.cjs');

const HOST = process.env.AUDIT_PG_HOST || 'localhost';
const PORT = Number(process.env.AUDIT_PG_PORT || '54329');
const USER = process.env.AUDIT_PG_USER || 'postgres';
const MIG_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');
const M31 = fs.readFileSync(path.join(MIG_DIR, '0031_project_budgets.sql'), 'utf8');
const M44 = fs.readFileSync(path.join(MIG_DIR, '0044_project_budget_spends.sql'), 'utf8');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  const admin = new Pool({ host: HOST, port: PORT, user: USER, database: 'postgres', max: 1 });
  let db;
  try {
    const ping = await admin.query('SELECT 1');
    if (!ping) throw new Error('no response');
  } catch (e) {
    console.log(`SKIP  no reachable PostgreSQL at ${HOST}:${PORT} (${e.message})`);
    await admin.end().catch(() => {});
    process.exit(0);
  }
  db = `g20_budget_audit_${crypto.randomBytes(4).toString('hex')}`;
  await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();

  const pg = new Pool({ host: HOST, port: PORT, user: USER, database: db, max: 8 });
  await pg.query(M31);
  await pg.query(M44);

  async function resetBudget(pid, budget, spent = 0) {
    await pg.query(`DELETE FROM project_budget_spends WHERE project_id=$1`, [pid]);
    await pg.query(
      `INSERT INTO project_budgets (project_id, workspace_id, budget, spent)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id) DO UPDATE SET budget=EXCLUDED.budget, spent=EXCLUDED.spent`,
      [pid, 'w1', budget, spent],
    );
  }

  // ── A. Oversell under concurrency: budget=100, two 60-spends (distinct keys). ──
  await resetBudget('p1', 100);
  const [a1, a2] = await Promise.all([
    recordSpend(pg, { projectId: 'p1', amount: 60, idempotencyKey: 'c1' }),
    recordSpend(pg, { projectId: 'p1', amount: 60, idempotencyKey: 'c2' }),
  ]);
  const okCount = [a1, a2].filter((r) => r.ok).length;
  const p1 = await getBudgetSpent(pg, 'p1');
  check('A1 no-oversell: exactly one of two concurrent 60-spends succeeds', okCount === 1,
    `ok=${okCount}, results=${JSON.stringify([a1.ok, a2.ok])}`);
  check('A2 no-oversell: spent capped at 60 (never 120)', p1.spent === 60, `spent=${p1.spent}`);

  // ── B. Cross-budget same key (global UNIQUE idempotency_key). ──
  await resetBudget('p2a', 100);
  await resetBudget('p2b', 100);
  const b1 = await recordSpend(pg, { projectId: 'p2a', amount: 10, idempotencyKey: 'shared-key' });
  const b2 = await recordSpend(pg, { projectId: 'p2b', amount: 10, idempotencyKey: 'shared-key' });
  const p2b = await getBudgetSpent(pg, 'p2b');
  check('B1 cross-budget same key: second project NOT silently replaying first', b2.ok === false && b2.error,
    `b2=${JSON.stringify({ ok: b2.ok, code: b2.error && b2.error.code, alreadyRecorded: b2.alreadyRecorded })}`);
  check('B2 cross-budget same key: p2b spent not falsely 0-deducted nor double', p2b.spent === 0,
    `p2b.spent=${p2b.spent} (b1.ok=${b1.ok})`);

  // ── C. Same key, different amount (amount mismatch). ──
  await resetBudget('p3', 100);
  const c1 = await recordSpend(pg, { projectId: 'p3', amount: 5, idempotencyKey: 'amt-key' });
  const c2 = await recordSpend(pg, { projectId: 'p3', amount: 99, idempotencyKey: 'amt-key' });
  check('C1 same key different amount: rejected as conflict, not silent replay', c2.ok === false && c2.error,
    `c2=${JSON.stringify({ ok: c2.ok, code: c2.error && c2.error.code, alreadyRecorded: c2.alreadyRecorded })}`);

  // ── D. Ledger/column consistency after mixed success+reject. ──
  await resetBudget('p4', 100);
  await recordSpend(pg, { projectId: 'p4', amount: 30, idempotencyKey: 'd1' });
  await recordSpend(pg, { projectId: 'p4', amount: 200, idempotencyKey: 'd2' }); // rejected
  await recordSpend(pg, { projectId: 'p4', amount: 20, idempotencyKey: 'd3' });
  const col = await getBudgetSpent(pg, 'p4');
  const sum = await pg.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS s FROM project_budget_spends WHERE project_id='p4' AND status='recorded'`,
  );
  check('D1 spent column == SUM(recorded ledger rows)', Number(col.spent) === Number(sum.rows[0].s),
    `column=${col.spent}, ledger_sum=${sum.rows[0].s}`);
  check('D2 rejected spend leaves no recorded ledger row for that key', Number(sum.rows[0].s) === 50,
    `ledger_sum=${sum.rows[0].s}`);

  // ── E. Rejected-then-retry same key replays rejection, no counter change. ──
  await resetBudget('p5', 100);
  await recordSpend(pg, { projectId: 'p5', amount: 150, idempotencyKey: 'rej' });
  const e2 = await recordSpend(pg, { projectId: 'p5', amount: 150, idempotencyKey: 'rej' });
  const p5 = await getBudgetSpent(pg, 'p5');
  check('E1 rejected key replays rejection with alreadyRejected flag', e2.ok === false && e2.alreadyRejected === true,
    `e2=${JSON.stringify({ ok: e2.ok, code: e2.error && e2.error.code, alreadyRejected: e2.alreadyRejected })}`);
  check('E2 rejected replay never touches counter', p5.spent === 0, `spent=${p5.spent}`);

  // ── F. amount 0 / negative. ──
  const f0 = await recordSpend(pg, { projectId: 'p1', amount: 0, idempotencyKey: 'f0' });
  const f1 = await recordSpend(pg, { projectId: 'p1', amount: -5, idempotencyKey: 'f1' });
  check('F1 amount 0 rejected', f0.ok === false && f0.error.code === 'SPEND_INVALID_AMOUNT',
    `f0=${JSON.stringify(f0)}`);
  check('F2 negative amount rejected', f1.ok === false && f1.error.code === 'SPEND_INVALID_AMOUNT',
    `f1=${JSON.stringify(f1)}`);

  // ── G. Atomicity: transient UPDATE failure rolls back idempotency row; retry deducts. ──
  await resetBudget('p6', 100);
  let injected = false;
  const faultyPool = {
    async connect() {
      const client = await pg.connect();
      return {
        query(sql, params) {
          if (!injected && /UPDATE project_budgets/.test(sql)) {
            injected = true;
            return Promise.reject(new Error('injected UPDATE failure'));
          }
          return client.query(sql, params);
        },
        release() { return client.release(); },
      };
    },
  };
  let threw = false;
  try {
    await recordSpend(faultyPool, { projectId: 'p6', amount: 40, idempotencyKey: 'crash-key' });
  } catch (_) { threw = true; }
  const ghostLedger = await pg.query(`SELECT 1 AS x FROM project_budget_spends WHERE idempotency_key='crash-key'`);
  const p6a = await getBudgetSpent(pg, 'p6');
  check('G1 UPDATE failure rolls back idempotency row (no ghost recorded row)', threw && ghostLedger.rows.length === 0,
    `threw=${threw}, ghost_rows=${ghostLedger.rows.length}`);
  check('G2 counter untouched after rollback', p6a.spent === 0, `spent=${p6a.spent}`);
  const gRetry = await recordSpend(pg, { projectId: 'p6', amount: 40, idempotencyKey: 'crash-key' });
  const p6b = await getBudgetSpent(pg, 'p6');
  check('G3 retry after rollback deducts correctly (no lost deduction)', gRetry.recorded === true && p6b.spent === 40,
    `recorded=${gRetry.recorded}, spent=${p6b.spent}`);

  await pg.end();
  const admin2 = new Pool({ host: HOST, port: PORT, user: USER, database: 'postgres', max: 1 });
  await admin2.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [db]);
  await admin2.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin2.end();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
