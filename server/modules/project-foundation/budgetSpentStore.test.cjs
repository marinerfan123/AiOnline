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
  const budgets = new Map(); // projectId -> { budget, spent }
  const spends = new Map(); // idempotencyKey -> { projectId, amount, status }
  for (const [pid, b] of Object.entries(initialBudgets)) {
    budgets.set(pid, { budget: Number(b.budget), spent: Number(b.spent || 0) });
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
        return { rows: [{ project_id: pid, budget: b.budget, spent: b.spent }] };
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
  const budgets = new Map();
  const spends = new Map();
  for (const [pid, b] of Object.entries(initialBudgets)) {
    budgets.set(pid, { budget: Number(b.budget), spent: Number(b.spent || 0) });
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
      return { rows: [{ project_id: pid, budget: b.budget, spent: b.spent }] };
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
