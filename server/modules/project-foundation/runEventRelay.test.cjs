'use strict';
/**
 * G21 — runEventRelay.cjs unit tests.
 *
 * The relay is exercised against the REAL runEventStore over a mock pg that
 * routes by SQL shape and implements genuine (run_id, seq) PK semantics
 * (duplicate INSERT → rowCount 0, like `ON CONFLICT DO NOTHING`). Because the
 * mock computes MAX(seq) at query time, two concurrent relayRunEvent calls
 * naturally read the same lastSequence before either INSERT lands — the exact
 * read-then-write race the relay was built to handle, deterministically under
 * the microtask FIFO.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRunEventRelay } = require('./runEventRelay.cjs');

/** Mock pg with in-memory run_events table (see runEventStore.test.cjs). */
function createMockPg() {
  const rowsByRun = new Map(); // runId -> Map<seq, {seq, type, payloadJson}>
  const calls = [];

  function getRun(runId) {
    if (!rowsByRun.has(runId)) rowsByRun.set(runId, new Map());
    return rowsByRun.get(runId);
  }

  async function query(text, params = []) {
    calls.push({ text, params });
    const sql = String(text).trim();

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS run_events')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO run_events')) {
      const [runId, seq, type, payloadJson] = params;
      const run = getRun(runId);
      if (run.has(seq)) return { rows: [], rowCount: 0 }; // PK conflict → DO NOTHING
      run.set(seq, { seq, type, payloadJson });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('ORDER BY seq')) {
      const [runId, afterSeq, limit] = params;
      const run = rowsByRun.get(runId);
      const all = run ? [...run.values()] : [];
      const rows = all
        .filter((r) => r.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((r) => ({ run_id: runId, seq: r.seq, type: r.type, payload_json: JSON.parse(r.payloadJson) }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('COALESCE')) {
      const [runId] = params;
      const run = rowsByRun.get(runId);
      const seq = run && run.size ? Math.max(...run.keys()) : 0;
      return { rows: [{ seq }], rowCount: 1 };
    }
    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }

  return {
    pg: { query },
    calls,
    insertCount: () => calls.filter((c) => c.text.includes('INSERT INTO run_events')).length,
    lastSeqCount: () => calls.filter((c) => c.text.includes('COALESCE')).length,
    listCount: () => calls.filter((c) => c.text.includes('ORDER BY seq')).length,
    stored: (runId) => {
      const run = rowsByRun.get(runId);
      return run ? [...run.values()].map((r) => ({ ...r, payload_json: JSON.parse(r.payloadJson) })) : [];
    },
  };
}

test('relayRunEvent allocates monotonic seq 1,2,3 via lastSequence+1 (fresh run starts at 1)', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });

  const e1 = await relay.relayRunEvent({ runId: 'run-1', type: 'studio.run.started', payload: { status: 'RUNNING' } });
  assert.deepEqual(e1, { ok: true, seq: 1, idempotent: false, retried: false });
  const e2 = await relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.started', payload: { run_node_id: 'n1', attempt: 1 } });
  assert.deepEqual(e2, { ok: true, seq: 2, idempotent: false, retried: false });
  const e3 = await relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.completed', payload: { run_node_id: 'n1', attempt: 1 } });
  assert.deepEqual(e3, { ok: true, seq: 3, idempotent: false, retried: false });

  // Stored rows are contiguous 1..3 with the exact engine-style types/payloads.
  const stored = m.stored('run-1');
  assert.deepEqual(stored.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(stored.map((r) => r.type), ['studio.run.started', 'studio.run_node.started', 'studio.run_node.completed']);
  assert.deepEqual(stored[0].payload_json, { status: 'RUNNING' });
  assert.deepEqual(stored[1].payload_json, { run_node_id: 'n1', attempt: 1 });

  // seq counters are per-run: a second run also starts at 1.
  assert.deepEqual(await relay.relayRunEvent({ runId: 'run-2', type: 'studio.run.started', payload: {} }), { ok: true, seq: 1, idempotent: false, retried: false });
  assert.equal(m.stored('run-1').length, 3);
});

test('relayRunEvent read-before-write: COALESCE lastSequence precedes every INSERT (SQL routing)', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });
  await relay.relayRunEvent({ runId: 'run-1', type: 'run.started', payload: { a: 1 } });

  const lastCalls = m.calls.filter((c) => c.text.includes('COALESCE'));
  const insertCalls = m.calls.filter((c) => c.text.includes('INSERT INTO run_events'));
  assert.equal(lastCalls.length, 1);
  assert.equal(insertCalls.length, 1);
  assert.deepEqual(lastCalls[0].params, ['run-1']); // lastSequence scoped to this run
  assert.ok(m.calls.indexOf(lastCalls[0]) < m.calls.indexOf(insertCalls[0]), 'lastSequence read must precede the INSERT');
  assert.match(insertCalls[0].text, /ON CONFLICT \(run_id, seq\) DO NOTHING/);
  assert.deepEqual(insertCalls[0].params.slice(0, 4), ['run-1', 1, 'run.started', JSON.stringify({ a: 1 })]);
});

test('relayRunEvent rejects missing runId / type / non-object payload before touching pg', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });

  const noRun = await relay.relayRunEvent({ type: 'run.started', payload: {} });
  assert.equal(noRun.ok, false);
  assert.deepEqual(noRun.errors.map((e) => e.code), ['INVALID_RUN_ID']);

  const noType = await relay.relayRunEvent({ runId: 'run-1' });
  assert.equal(noType.ok, false);
  assert.deepEqual(noType.errors.map((e) => e.code), ['INVALID_TYPE']);

  const neither = await relay.relayRunEvent({});
  assert.equal(neither.ok, false);
  assert.deepEqual(neither.errors.map((e) => e.code).sort(), ['INVALID_RUN_ID', 'INVALID_TYPE']);

  const badPayload = await relay.relayRunEvent({ runId: 'run-1', type: 'run.started', payload: 'not-an-object' });
  assert.equal(badPayload.ok, false);
  assert.deepEqual(badPayload.errors.map((e) => e.code), ['INVALID_PAYLOAD']);

  const blankType = await relay.relayRunEvent({ runId: 'run-1', type: '   ' });
  assert.equal(blankType.ok, false);

  // Rejection is pure validation — zero SQL issued, nothing stored.
  assert.equal(m.calls.length, 0);
  assert.equal(m.stored('run-1').length, 0);
});

test('concurrent duplicate delivery of the SAME event → store idempotency absorbs it (returns idempotent, single row)', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });
  const evt = { runId: 'run-1', type: 'studio.run_node.completed', payload: { run_node_id: 'n1', attempt: 1 } };

  const [a, b] = await Promise.all([relay.relayRunEvent(evt), relay.relayRunEvent(evt)]);

  // Both calls read the same lastSequence (0) and raced for seq 1; the PK
  // conflict made the loser an idempotent no-op — NO second row, NO seq 2.
  for (const r of [a, b]) {
    assert.equal(r.ok, true);
    assert.equal(r.seq, 1);
  }
  assert.equal([a, b].filter((r) => r.idempotent === false).length, 1);
  assert.equal([a, b].filter((r) => r.idempotent === true).length, 1);
  assert.equal([a, b].filter((r) => r.retried === false).length, 2);
  assert.equal(m.stored('run-1').length, 1); // duplicate delivery left exactly one row
  assert.equal(m.insertCount(), 2); // both INSERTs attempted…
  assert.equal(m.listCount(), 1); // …and the loser disambiguated via listRunEvents
});

test('concurrent DIFFERENT events racing for the same seq → loser retries once and lands on seq 2 (nothing dropped)', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });

  const [a, b] = await Promise.all([
    relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.started', payload: { run_node_id: 'n1', attempt: 1 } }),
    relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.ready', payload: { run_node_id: 'n2', attempt: 1 } }),
  ]);

  for (const r of [a, b]) assert.equal(r.ok, true);
  // Both events survive: winner at seq 1 (no retry), loser re-allocated to seq 2.
  const seqs = [a, b].map((r) => r.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, [1, 2]);
  const retried = [a, b].find((r) => r.retried === true);
  assert.ok(retried, 'loser must have retried once');
  assert.equal(retried.seq, 2);
  assert.equal(retried.idempotent, false);
  assert.equal([a, b].find((r) => r.retried === false).seq, 1);

  const stored = m.stored('run-1');
  assert.deepEqual(stored.map((r) => r.seq), [1, 2]);
  assert.deepEqual(stored.map((r) => r.type).sort(), ['studio.run_node.ready', 'studio.run_node.started']);
  assert.equal(m.insertCount(), 3); // winner 1 + loser's conflict attempt + loser's retry
});

test('first event on an empty run starts at seq 1 (lastSequence 0 baseline)', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });
  // Store-level baseline check: no rows yet → lastSequence is 0.
  assert.deepEqual(m.stored('run-empty').length, 0);
  const r = await relay.relayRunEvent({ runId: 'run-empty', type: 'studio.run.started', payload: {} });
  assert.deepEqual(r, { ok: true, seq: 1, idempotent: false, retried: false });
  assert.deepEqual(m.stored('run-empty').map((e) => e.seq), [1]);
});
