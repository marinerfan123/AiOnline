'use strict';
/**
 * V2.0 must#2 — studioRunEngine post-completion budget-spend wiring (NO real DB).
 *
 * The engine is driven through its real completeRunNode path over a purpose-built
 * mock pg that emulates exactly the SQL shapes that path issues (BEGIN / the
 * node SELECT join / SUCCEEDED UPDATE / fan-out / studio_run_events INSERT /
 * aggregateRun / COMMIT), while the budgetSpentStore under test is a FAKE store
 * that only records calls — so we assert the engine's contract (when it records,
 * with which key/amount, and that a store failure can never disturb the run)
 * without a database.
 *
 * Covered:
 *   - store injected + priced result → recordSpend called exactly once with
 *     idempotencyKey = the node's own PK (run_node_id), projectId from the run,
 *     amount = the priced credits on the result;
 *   - unpriced result (no cost) → zero recordSpend calls;
 *   - node already terminal (idempotent replay) → zero recordSpend calls;
 *   - no budgetSpentStore injected → zero spend activity (no project_budget SQL);
 *   - recordSpend throws → completeRunNode still succeeds (run never disturbed);
 *   - recordSpend returns {ok:false} → run still succeeds, warn logged;
 *   - recordSpend rejected/throwing with a relay injected → a durable
 *     studio.run_node.spend_rejected / spend_failed event is relayed with
 *     runId + run_node_id (budget-defence failure is never silent).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStudioRunEngine } = require('./studioRunEngine.cjs');

/** Mock pg emulating the exact SQL surface of the completeRunNode success path. */
function makeMockPg(opts = {}) {
  const node = opts.node || {
    id: 'srn-1', run_id: 'run-1', studio_node_id: 'A', node_type: 'prompt',
    execution_kind: 'SOURCE', status: 'RUNNING', lease_owner: 'w-A', lease_token: 'tok',
    lease_expires_at: new Date(Date.now() + 60_000), attempt: 1, max_attempts: 3, result_json: null,
  };
  const run = opts.run || {
    id: 'run-1', project_id: 'proj-1', status: 'RUNNING', cancel_requested_at: null,
    failure_code: null, executor_unavailable: false,
  };
  const events = [];
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      const s = String(sql).trim();
      if (s === 'BEGIN') return { rows: [], rowCount: 0 };
      if (s === 'COMMIT') return { rows: [], rowCount: 0 };
      if (s === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (/FROM studio_run_nodes n\s+JOIN studio_runs/.test(s)) {
        return { rows: [{ ...node, run_project_id: run.project_id }] };
      }
      if (/SET status = 'SUCCEEDED'/.test(s)) {
        node.status = 'SUCCEEDED';
        return { rows: [], rowCount: 1 };
      }
      if (/remaining_dependency_count = n\.remaining_dependency_count - 1/.test(s)) {
        return { rows: [] }; // no dependents → nothing unlocked
      }
      if (/INSERT INTO studio_run_events/.test(s)) {
        events.push({ runId: params[0], runNodeId: params[1], eventType: params[2], payload: JSON.parse(params[3]) });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT id FROM studio_runs WHERE id=\$1 FOR UPDATE/.test(s)) {
        return { rows: [{ id: run.id }] };
      }
      if (/SELECT status, COUNT\(\*\)::int AS c FROM studio_run_nodes/.test(s)) {
        return { rows: [{ status: node.status, c: 1 }] };
      }
      if (/SELECT status, cancel_requested_at, failure_code, executor_unavailable FROM studio_runs/.test(s)) {
        return { rows: [{ ...run }] };
      }
      if (/UPDATE studio_runs\s+SET status =/.test(s)) {
        run.status = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE studio_runs SET node_status_counts/.test(s)) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error('mock pg: unhandled SQL: ' + s);
    },
    release() {},
  };
  return {
    pg: { connect: async () => client, query: async () => { throw new Error('mock pg: no pool-level query expected'); } },
    node, run, events, calls,
  };
}

/** Fake budgetSpentStore: records recordSpend calls, configurable behaviour. */
function makeFakeStore(opts = {}) {
  const calls = [];
  return {
    calls,
    async recordSpend(pg, payload) {
      calls.push(payload);
      if (opts.throwError) throw new Error(opts.throwError);
      if (opts.result) return opts.result;
      return { ok: true, recorded: true, spent: payload.amount, remaining: 0 };
    },
  };
}

/** Fake relay: records relayRunEvent calls (no DB). */
function makeFakeRelay() {
  const events = [];
  return {
    events,
    async relayRunEvent(evt) {
      events.push(evt);
      return { ok: true, seq: events.length };
    },
  };
}

function makeEngine(pg, { budgetSpentStore, relay } = {}) {
  const logs = [];
  const engine = createStudioRunEngine({
    pg,
    workerId: 'w-spend-unit',
    budgetSpentStore,
    relay,
    onLog: (tag, payload) => logs.push({ tag, payload }),
  });
  return { engine, logs };
}

test('store injected + priced result → recordSpend once, idempotencyKey = run_node_id, amount = priced credits', async () => {
  const m = makeMockPg();
  const store = makeFakeStore();
  const { engine } = makeEngine(m.pg, { budgetSpentStore: store });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi', cost: 2.5 } });

  assert.equal(r.ok, true);
  assert.equal(r.runId, 'run-1');
  assert.equal(store.calls.length, 1);
  assert.deepEqual(store.calls[0], {
    projectId: 'proj-1',
    amount: 2.5,
    idempotencyKey: 'srn-1',
  }, 'projectId from run row, amount = priced credits, key = node PK (run_node_id)');
});

test('unpriced result (no cost) → zero recordSpend calls', async () => {
  const m = makeMockPg();
  const store = makeFakeStore();
  const { engine } = makeEngine(m.pg, { budgetSpentStore: store });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi' } });

  assert.equal(r.ok, true);
  assert.equal(store.calls.length, 0);
});

test('node already terminal (idempotent replay) → zero recordSpend calls', async () => {
  const m = makeMockPg({ node: {
    id: 'srn-1', run_id: 'run-1', studio_node_id: 'A', node_type: 'prompt',
    execution_kind: 'SOURCE', status: 'SUCCEEDED', lease_owner: null, lease_token: null,
    lease_expires_at: null, attempt: 1, max_attempts: 3, result_json: { text: 'hi' },
  } });
  const store = makeFakeStore();
  const { engine } = makeEngine(m.pg, { budgetSpentStore: store });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi', cost: 5 } });

  assert.equal(r.ok, true);
  assert.equal(r.idempotent, true);
  assert.equal(store.calls.length, 0);
});

test('no budgetSpentStore injected → zero spend activity (run completes, no project_budget SQL)', async () => {
  const m = makeMockPg();
  const { engine } = makeEngine(m.pg, { budgetSpentStore: undefined });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi', cost: 9 } });

  assert.equal(r.ok, true);
  assert.equal(r.runId, 'run-1');
  const budgetSql = m.calls.filter((c) => /project_budget/.test(c.sql));
  assert.equal(budgetSql.length, 0, 'no project_budget_spends/project_budgets SQL when store absent');
});

test('recordSpend throws → completeRunNode still succeeds (run never disturbed)', async () => {
  const m = makeMockPg();
  const store = makeFakeStore({ throwError: 'store down' });
  const { engine, logs } = makeEngine(m.pg, { budgetSpentStore: store });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi', cost: 4 } });

  assert.equal(r.ok, true, 'spend failure must not fail the run');
  assert.equal(r.runId, 'run-1');
  assert.equal(store.calls.length, 1);
  assert.ok(logs.some((l) => l.tag === 'run.node.spend_failed'), 'spend failure is logged, not thrown');
});

test('recordSpend returns {ok:false} (over remaining / no budget) → run still succeeds, warn logged', async () => {
  const m = makeMockPg();
  const store = makeFakeStore({ result: { ok: false, error: { code: 'SPEND_OVER_REMAINING' } } });
  const { engine, logs } = makeEngine(m.pg, { budgetSpentStore: store });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi', cost: 7 } });

  assert.equal(r.ok, true);
  assert.equal(store.calls.length, 1);
  assert.ok(logs.some((l) => l.tag === 'run.node.spend_not_recorded' && l.payload.code === 'SPEND_OVER_REMAINING'),
    'rejected spend is logged, run unaffected');
});

test('recordSpend rejected (over remaining) + relay → durable spend_rejected event with runId + run_node_id', async () => {
  const m = makeMockPg();
  const store = makeFakeStore({ result: { ok: false, error: { code: 'SPEND_OVER_REMAINING' } } });
  const relay = makeFakeRelay();
  const { engine } = makeEngine(m.pg, { budgetSpentStore: store, relay });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi', cost: 7 } });

  assert.equal(r.ok, true);
  const warns = relay.events.filter((e) => e.type === 'studio.run_node.spend_rejected');
  assert.equal(warns.length, 1, 'one durable spend_rejected warning relayed (normal engine events are also relayed)');
  assert.deepEqual(warns[0], {
    runId: 'run-1',
    type: 'studio.run_node.spend_rejected',
    payload: { run_node_id: 'srn-1', projectId: 'proj-1', code: 'SPEND_OVER_REMAINING' },
  });
});

test('recordSpend throws + relay → durable spend_failed event, run unaffected', async () => {
  const m = makeMockPg();
  const store = makeFakeStore({ throwError: 'store down' });
  const relay = makeFakeRelay();
  const { engine } = makeEngine(m.pg, { budgetSpentStore: store, relay });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi', cost: 4 } });

  assert.equal(r.ok, true, 'spend failure must not fail the run');
  const warns = relay.events.filter((e) => e.type === 'studio.run_node.spend_failed');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].runId, 'run-1');
  assert.equal(warns[0].payload.run_node_id, 'srn-1');
  assert.equal(warns[0].payload.projectId, 'proj-1');
  assert.equal(warns[0].payload.error, 'store down');
});

test('recordSpend succeeded + relay → no spend warning event (only failure/rejection are warned)', async () => {
  const m = makeMockPg();
  const store = makeFakeStore(); // returns { ok: true, recorded: true }
  const relay = makeFakeRelay();
  const { engine } = makeEngine(m.pg, { budgetSpentStore: store, relay });

  const r = await engine.completeRunNode('srn-1', { owner: 'w-A', token: 'tok', result: { text: 'hi', cost: 3 } });

  assert.equal(r.ok, true);
  const warns = relay.events.filter((e) => typeof e.type === 'string' && e.type.startsWith('studio.run_node.spend_'));
  assert.equal(warns.length, 0, 'successful spend emits no warning event');
});
