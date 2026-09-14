'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { getBudgetSpent, recordSpend } = require('./budgetSpentStore.cjs');

/**
 * In-memory fake pg that simulates the project_budgets counter + the
 * project_budget_spends idempotency table, so the store's real logic
 * (dedup / accumulate / over-ceiling guard) is exercised without a live DB.
 * No connect() → the store runs in direct (non-transactional) mode.
 */
function makeFakePg(initialBudgets = {}) {
  const budgets = new Map(); // projectId -> { budget, spent, balance_after }
  const spends = new Map(); // idempotencyKey -> { projectId, amount, status }
  for (const [pid, b] of Object.entries(initialBudgets)) {
    budgets.set(pid, {
      budget: Number(b.budget),
      spent: Number(b.spent || 0),
      balance_after: b.balance_after === undefined ? null : Number(b.balance_after),
    });
  }
  const calls = [];
  return {
    budgets,
    spends,
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO project_budget_spends/.test(sql)) {
        const key = params[1];
        if (spends.has(key)) return { rows: [], rowCount: 0 };
        spends.set(key, { projectId: params[0], amount: Number(params[2]), status: 'recorded' });
        return { rows: [{ idempotency_key: key }], rowCount: 1 };
      }
      if (/SELECT project_id, amount, status FROM project_budget_spends/.test(sql)) {
        const s = spends.get(params[0]);
        return s
          ? { rows: [{ project_id: s.projectId, amount: s.amount, status: s.status }] }
          : { rows: [] };
      }
      if (/UPDATE project_budget_spends SET status/.test(sql)) {
        const s = spends.get(params[0]);
        if (s) s.status = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE project_budgets/.test(sql)) {
        const pid = params[0];
        const amt = Number(params[1]);
        const b = budgets.get(pid);
        if (!b || Number(b.budget) - Number(b.spent) < amt) return { rows: [] };
        b.spent = Number(b.spent) + amt;
        b.balance_after = Number(b.budget) - b.spent; // audit snapshot = new remaining
        return { rows: [{ project_id: pid, budget: b.budget, spent: b.spent, balance_after: b.balance_after }] };
      }
      if (/FROM project_budgets/.test(sql)) {
        const b = budgets.get(params[0]);
        if (!b) return { rows: [] };
        return {
          rows: [{
            project_id: params[0],
            workspace_id: 'w1',
            budget: b.budget,
            spent: b.spent,
            balance_after: b.balance_after,
            warning_threshold: 0.8,
            approval_threshold: 1,
          }],
        };
      }
      throw new Error('unhandled query: ' + sql);
    },
  };
}

/**
 * Transaction-aware fake pg: exposes connect() so the store wraps operations in
 * BEGIN…COMMIT/ROLLBACK. Snapshot/restore on ROLLBACK mimics real atomicity.
 * `injectUpdateFailure` makes the guarded UPDATE throw once, to simulate a
 * transient failure between idempotency-key INSERT and the counter UPDATE.
 */
function makeTxFakePg(initialBudgets = {}) {
  const budgets = new Map(); // projectId -> { budget, spent, balance_after }
  const spends = new Map();
  for (const [pid, b] of Object.entries(initialBudgets)) {
    budgets.set(pid, {
      budget: Number(b.budget),
      spent: Number(b.spent || 0),
      balance_after: b.balance_after === undefined ? null : Number(b.balance_after),
    });
  }
  const state = { budgets, spends };
  const log = []; // global op log (BEGIN/COMMIT/ROLLBACK + statements)
  let injectUpdateFailure = false;

  function snapshot() {
    return {
      budgets: new Map([...budgets].map(([k, v]) => [k, { ...v }])),
      spends: new Map([...spends].map(([k, v]) => [k, { ...v }])),
    };
  }
  function restore(snap) {
    budgets.clear();
    for (const [k, v] of snap.budgets) budgets.set(k, { ...v });
    spends.clear();
    for (const [k, v] of snap.spends) spends.set(k, { ...v });
  }

  async function exec(sql, params = []) {
    log.push(sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK' ? sql : 'stmt');
    if (/INSERT INTO project_budget_spends/.test(sql)) {
      const key = params[1];
      if (spends.has(key)) return { rows: [], rowCount: 0 };
      spends.set(key, { projectId: params[0], amount: Number(params[2]), status: 'recorded' });
      return { rows: [{ idempotency_key: key }], rowCount: 1 };
    }
    if (/SELECT project_id, amount, status FROM project_budget_spends/.test(sql)) {
      const s = spends.get(params[0]);
      return s
        ? { rows: [{ project_id: s.projectId, amount: s.amount, status: s.status }] }
        : { rows: [] };
    }
    if (/UPDATE project_budget_spends SET status/.test(sql)) {
      const s = spends.get(params[0]);
      if (s) s.status = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE project_budgets/.test(sql)) {
      if (injectUpdateFailure) {
        injectUpdateFailure = false;
        throw new Error('injected UPDATE failure');
      }
      const pid = params[0];
      const amt = Number(params[1]);
      const b = budgets.get(pid);
      if (!b || Number(b.budget) - Number(b.spent) < amt) return { rows: [] };
      b.spent = Number(b.spent) + amt;
      b.balance_after = Number(b.budget) - b.spent; // audit snapshot = new remaining
      return { rows: [{ project_id: pid, budget: b.budget, spent: b.spent, balance_after: b.balance_after }] };
    }
    if (/FROM project_budgets/.test(sql)) {
      const b = budgets.get(params[0]);
      if (!b) return { rows: [] };
      return {
        rows: [{
          project_id: params[0],
          workspace_id: 'w1',
          budget: b.budget,
          spent: b.spent,
          balance_after: b.balance_after,
          warning_threshold: 0.8,
          approval_threshold: 1,
        }],
      };
    }
    throw new Error('unhandled query: ' + sql);
  }

  return {
    state,
    log,
    setInjectUpdateFailure(v) { injectUpdateFailure = v; },
    async connect() {
      let snap = null;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') { snap = snapshot(); log.push('BEGIN'); return { rows: [], rowCount: 0 }; }
          if (sql === 'COMMIT') { log.push('COMMIT'); return { rows: [], rowCount: 0 }; }
          if (sql === 'ROLLBACK') { if (snap) restore(snap); log.push('ROLLBACK'); return { rows: [], rowCount: 0 }; }
          return exec(sql, params);
        },
        async release() {},
      };
    },
  };
}

test('recordSpend: 扣减累计 — distinct keys accumulate spent', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 0 } });
  const a = await recordSpend(pg, { projectId: 'p1', amount: 10, idempotencyKey: 'k1' });
  assert.equal(a.ok, true);
  assert.equal(a.recorded, true);
  assert.equal(a.spent, 10);
  assert.equal(a.remaining, 90);
  const b = await recordSpend(pg, { projectId: 'p1', amount: 5, idempotencyKey: 'k2' });
  assert.equal(b.recorded, true);
  assert.equal(b.spent, 15);
  assert.equal(pg.budgets.get('p1').spent, 15);
});

test('recordSpend: 幂等 — same key never double-deducts', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 0 } });
  const a = await recordSpend(pg, { projectId: 'p1', amount: 10, idempotencyKey: 'dup' });
  assert.equal(a.recorded, true);
  const b = await recordSpend(pg, { projectId: 'p1', amount: 10, idempotencyKey: 'dup' });
  assert.equal(b.ok, true);
  assert.equal(b.recorded, false);
  assert.equal(b.alreadyRecorded, true);
  assert.equal(pg.budgets.get('p1').spent, 10, 'spent must not double-count');
});

test('recordSpend: 超限拒 — amount > remaining rejected, counter untouched', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 90 } });
  const r = await recordSpend(pg, { projectId: 'p1', amount: 15, idempotencyKey: 'over' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SPEND_OVER_REMAINING');
  assert.equal(pg.budgets.get('p1').spent, 90, 'counter untouched on rejection');
});

test('recordSpend: 幂等拒绝 — rejected key replays rejection, no double effect', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 90 } });
  const r1 = await recordSpend(pg, { projectId: 'p1', amount: 15, idempotencyKey: 'over' });
  assert.equal(r1.error.code, 'SPEND_OVER_REMAINING');
  const r2 = await recordSpend(pg, { projectId: 'p1', amount: 15, idempotencyKey: 'over' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'SPEND_OVER_REMAINING');
  assert.equal(r2.alreadyRejected, true);
  assert.equal(pg.budgets.get('p1').spent, 90);
});

test('recordSpend: no budget row → SPEND_NO_BUDGET (fail-closed)', async () => {
  const pg = makeFakePg({});
  const r = await recordSpend(pg, { projectId: 'nope', amount: 5, idempotencyKey: 'nb' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SPEND_NO_BUDGET');
});

test('getBudgetSpent: read model returns spent + remaining, null when absent', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 30 } });
  const b = await getBudgetSpent(pg, 'p1');
  assert.equal(b.budget, 100);
  assert.equal(b.spent, 30);
  assert.equal(b.remaining, 70);
  assert.equal(await getBudgetSpent(pg, 'missing'), null);
});

test('recordSpend: input validation', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 0 } });
  assert.equal((await recordSpend(pg, {})).error.code, 'SPEND_MISSING_PROJECT');
  assert.equal((await recordSpend(pg, { projectId: 'p1' })).error.code, 'SPEND_INVALID_AMOUNT');
  assert.equal((await recordSpend(pg, { projectId: 'p1', amount: 0 })).error.code, 'SPEND_INVALID_AMOUNT');
  assert.equal((await recordSpend(pg, { projectId: 'p1', amount: -5 })).error.code, 'SPEND_INVALID_AMOUNT');
  assert.equal((await recordSpend(pg, { projectId: 'p1', amount: 5 })).error.code, 'SPEND_MISSING_IDEMPOTENCY_KEY');
});

test('recordSpend: 跨预算同键 → SPEND_IDEMPOTENCY_KEY_CONFLICT (fail-closed)', async () => {
  const pg = makeFakePg({ pa: { budget: 100, spent: 0 }, pb: { budget: 100, spent: 0 } });
  const a = await recordSpend(pg, { projectId: 'pa', amount: 10, idempotencyKey: 'shared' });
  assert.equal(a.ok, true);
  const b = await recordSpend(pg, { projectId: 'pb', amount: 10, idempotencyKey: 'shared' });
  assert.equal(b.ok, false, 'must not silently replay another budget');
  assert.equal(b.error.code, 'SPEND_IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(pg.budgets.get('pb').spent, 0, 'pb counter untouched');
});

test('recordSpend: 同键不同金额 → SPEND_IDEMPOTENCY_KEY_CONFLICT', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 0 } });
  await recordSpend(pg, { projectId: 'p1', amount: 5, idempotencyKey: 'amt' });
  const r = await recordSpend(pg, { projectId: 'p1', amount: 99, idempotencyKey: 'amt' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SPEND_IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(pg.budgets.get('p1').spent, 5);
});

test('recordSpend: 事务原子性 — UPDATE 瞬时失败回滚占键行，重试可正常扣减', async () => {
  const pg = makeTxFakePg({ p1: { budget: 100, spent: 0 } });
  pg.setInjectUpdateFailure(true);
  await assert.rejects(
    recordSpend(pg, { projectId: 'p1', amount: 40, idempotencyKey: 'crash' }),
    /injected UPDATE failure/,
  );
  // 占键 INSERT 与累计 UPDATE 同事务：失败回滚后不得残留 'recorded' 行或计数器。
  assert.equal(pg.state.spends.has('crash'), false, 'idempotency row must be rolled back');
  assert.equal(pg.state.budgets.get('p1').spent, 0, 'counter must be rolled back');
  // 重试：同键从零开始，正常扣减。
  const retry = await recordSpend(pg, { projectId: 'p1', amount: 40, idempotencyKey: 'crash' });
  assert.equal(retry.ok, true);
  assert.equal(retry.recorded, true);
  assert.equal(pg.state.budgets.get('p1').spent, 40);
});

test('recordSpend: 有 connect() 时走 BEGIN…COMMIT 事务', async () => {
  const pg = makeTxFakePg({ p1: { budget: 100, spent: 0 } });
  const r = await recordSpend(pg, { projectId: 'p1', amount: 10, idempotencyKey: 't1' });
  assert.equal(r.recorded, true);
  assert.equal(pg.log[0], 'BEGIN');
  assert.equal(pg.log[pg.log.length - 1], 'COMMIT');
});

test('recordSpend: 事务内被拒后 COMMIT（rejected 状态落库，计数器不动）', async () => {
  const pg = makeTxFakePg({ p1: { budget: 100, spent: 95 } });
  const r = await recordSpend(pg, { projectId: 'p1', amount: 10, idempotencyKey: 'rej-tx' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SPEND_OVER_REMAINING');
  assert.equal(pg.state.spends.get('rej-tx').status, 'rejected');
  assert.equal(pg.state.budgets.get('p1').spent, 95);
  assert.equal(pg.log[pg.log.length - 1], 'COMMIT');
});

test('recordSpend: 成功路径写 balance_after 审计快照 = 扣减后最新余量', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 0 } });
  const a = await recordSpend(pg, { projectId: 'p1', amount: 10, idempotencyKey: 'ba1' });
  assert.equal(a.ok, true);
  assert.equal(a.spent, 10);
  assert.equal(a.remaining, 90);
  assert.equal(a.balanceAfter, 90, 'returned snapshot = budget - new spent');
  assert.equal(pg.budgets.get('p1').balance_after, 90, 'row snapshot persisted');
  // 后续成功扣减把快照推进到更新后的余量。
  const b = await recordSpend(pg, { projectId: 'p1', amount: 5, idempotencyKey: 'ba2' });
  assert.equal(b.balanceAfter, 85);
  assert.equal(pg.budgets.get('p1').balance_after, 85);
  assert.equal(pg.budgets.get('p1').spent, 15);
  // 快照恒等于 spent 列推进后的 remaining（预算 100 - 已扣 15）。
  assert.equal(pg.budgets.get('p1').balance_after, 100 - 15);
});

test('recordSpend: 拒绝不写 balance_after（快照/未初始 NULL 均保持不变）', async () => {
  // 从未成功过 → NULL 保持 NULL。
  const pg = makeFakePg({ p1: { budget: 100, spent: 90 } });
  const r = await recordSpend(pg, { projectId: 'p1', amount: 15, idempotencyKey: 'ba-rej' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SPEND_OVER_REMAINING');
  assert.equal(pg.budgets.get('p1').balance_after, null, 'NULL stays NULL on rejection');
  assert.equal(pg.budgets.get('p1').spent, 90);
  // 已有历史快照 → 拒绝不得改写。
  const pg2 = makeFakePg({ p1: { budget: 100, spent: 90, balance_after: 10 } });
  const r2 = await recordSpend(pg2, { projectId: 'p1', amount: 15, idempotencyKey: 'ba-rej2' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'SPEND_OVER_REMAINING');
  assert.equal(pg2.budgets.get('p1').balance_after, 10, 'prior snapshot untouched');
});

test('recordSpend: 幂等重放不覆盖 balance_after（recorded 与 rejected 均不改写）', async () => {
  const pg = makeFakePg({ p1: { budget: 100, spent: 0 } });
  await recordSpend(pg, { projectId: 'p1', amount: 10, idempotencyKey: 'dup-ba' });
  assert.equal(pg.budgets.get('p1').balance_after, 90);
  // 另一笔成功扣减推进快照到 85 …
  await recordSpend(pg, { projectId: 'p1', amount: 5, idempotencyKey: 'dup-ba-2' });
  assert.equal(pg.budgets.get('p1').balance_after, 85);
  // … 重放旧键（alreadyRecorded）不得把快照回退/改写，仍为 85。
  const replay = await recordSpend(pg, { projectId: 'p1', amount: 10, idempotencyKey: 'dup-ba' });
  assert.equal(replay.ok, true);
  assert.equal(replay.recorded, false);
  assert.equal(replay.alreadyRecorded, true);
  assert.equal(pg.budgets.get('p1').spent, 15, 'no double deduction');
  assert.equal(pg.budgets.get('p1').balance_after, 85, 'recorded replay leaves snapshot as-is');
  // rejected 键重放：同样不改写快照。
  const pgR = makeFakePg({ p1: { budget: 100, spent: 90, balance_after: 10 } });
  await recordSpend(pgR, { projectId: 'p1', amount: 15, idempotencyKey: 'rej-ba' });
  assert.equal(pgR.budgets.get('p1').balance_after, 10);
  const rReplay = await recordSpend(pgR, { projectId: 'p1', amount: 15, idempotencyKey: 'rej-ba' });
  assert.equal(rReplay.alreadyRejected, true);
  assert.equal(pgR.budgets.get('p1').balance_after, 10, 'rejected replay leaves snapshot as-is');
  assert.equal(pgR.budgets.get('p1').spent, 90);
});

test('migration 0057: additive 幂等 — 仅 ADD COLUMN IF NOT EXISTS + COMMENT，无破坏语句', () => {
  const fs = require('fs');
  const path = require('path');
  const mig = path.join(__dirname, '..', '..', 'db', 'migrations', '0057_budget_spend_balance_after.sql');
  const sql = fs.readFileSync(mig, 'utf8');
  // 幂等核心：列以 IF NOT EXISTS 形式追加；重复应用为 no-op。
  assert.match(sql, /ADD COLUMN IF NOT EXISTS balance_after NUMERIC\s*\(\s*18\s*,\s*4\s*\)/);
  // 无破坏性/数据改动语句 → 分类 additive，可安全重放。
  assert.doesNotMatch(sql, /\bDROP\b/i, 'no DROP anywhere');
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /CREATE TABLE/i);
  // 注释声明该列为审计快照、非真源（budget/spent 仍是权威）。
  assert.match(sql, /AUDIT SNAPSHOT/i);
  assert.match(sql, /NOT source of truth/i);
});

