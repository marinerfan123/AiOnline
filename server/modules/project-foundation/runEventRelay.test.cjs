'use strict';
/**
 * G21 — runEventRelay.cjs unit tests.
 *
 * The relay is exercised against the REAL runEventStore over a mock pg that
 * implements the atomic auto-seq allocation (appendNextRunEvent → the mock's
 * synchronous MAX+1 branch mirrors the advisory-locked INSERT…SELECT…
 * RETURNING against real Postgres). The pre-fix relay allocated seq via
 * read-last → write-last+1 with a single retry, which dropped events under a
 * 3+-way race (the loser re-read the same MAX and collided again on its one
 * allowed retry). These tests prove the fixed contract: concurrent emits for
 * the same run never collide and never drop.
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
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS run_event_counters')) {
      return { rows: [], rowCount: 0 };
    }
    // Atomic auto-seq allocate: counter bump + insert in one synchronous step
    // (mirrors the atomic single statement — no interleaving possible).
    if (sql.includes('INSERT INTO run_events') && sql.includes('RETURNING seq')) {
      const [runId, type, payloadJson] = params;
      const run = getRun(runId);
      const seq = run.size ? Math.max(...run.keys()) + 1 : 1;
      run.set(seq, { seq, type, payloadJson });
      return { rows: [{ seq }], rowCount: 1 };
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
    stored: (runId) => {
      const run = rowsByRun.get(runId);
      return run ? [...run.values()].map((r) => ({ ...r, payload_json: JSON.parse(r.payloadJson) })) : [];
    },
  };
}

test('relayRunEvent allocates monotonic seq 1,2,3 (fresh run starts at 1)', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });

  const e1 = await relay.relayRunEvent({ runId: 'run-1', type: 'studio.run.started', payload: { status: 'RUNNING' } });
  assert.deepEqual(e1, { ok: true, seq: 1, idempotent: false, retried: false });
  const e2 = await relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.started', payload: { run_node_id: 'n1', attempt: 1 } });
  assert.deepEqual(e2, { ok: true, seq: 2, idempotent: false, retried: false });
  const e3 = await relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.completed', payload: { run_node_id: 'n1', attempt: 1 } });
  assert.deepEqual(e3, { ok: true, seq: 3, idempotent: false, retried: false });

  const stored = m.stored('run-1');
  assert.deepEqual(stored.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(stored.map((r) => r.type), ['studio.run.started', 'studio.run_node.started', 'studio.run_node.completed']);
  assert.deepEqual(stored[0].payload_json, { status: 'RUNNING' });
  assert.deepEqual(stored[1].payload_json, { run_node_id: 'n1', attempt: 1 });

  // seq counters are per-run: a second run also starts at 1.
  assert.deepEqual(await relay.relayRunEvent({ runId: 'run-2', type: 'studio.run.started', payload: {} }), { ok: true, seq: 1, idempotent: false, retried: false });
  assert.equal(m.stored('run-1').length, 3);
});

test('relayRunEvent uses ONE atomic statement (counter bump + RETURNING seq, params [runId, type, payload])', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });
  await relay.relayRunEvent({ runId: 'run-1', type: 'run.started', payload: { a: 1 } });

  const appends = m.calls.filter((c) => c.text.includes('INSERT INTO run_events') && c.text.includes('RETURNING seq'));
  assert.equal(appends.length, 1);
  assert.match(appends[0].text, /run_event_counters/);
  assert.match(appends[0].text, /ON CONFLICT \(run_id\) DO UPDATE SET seq = run_event_counters\.seq \+ 1/);
  assert.match(appends[0].text, /ON CONFLICT \(run_id, seq\) DO NOTHING/);
  assert.deepEqual(appends[0].params, ['run-1', 'run.started', JSON.stringify({ a: 1 })]);
  // No separate lastSequence read: allocation is inside the single statement.
  assert.equal(m.calls.filter((c) => c.text.includes('INSERT INTO run_events')).length, 1);
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

  assert.equal(m.calls.length, 0);
  assert.equal(m.stored('run-1').length, 0);
});

test('concurrent DIFFERENT events (4-way race) → all land on distinct contiguous seqs, nothing dropped', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });

  const results = await Promise.all([
    relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.started', payload: { run_node_id: 'n1', attempt: 1 } }),
    relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.started', payload: { run_node_id: 'n2', attempt: 1 } }),
    relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.ready', payload: { run_node_id: 'n3' } }),
    relay.relayRunEvent({ runId: 'run-1', type: 'studio.run_node.completed', payload: { run_node_id: 'n4', attempt: 1 } }),
  ]);

  // The pre-fix relay (read-last → write-last+1, one retry) dropped events in a
  // 3+-way race. The fixed relay must persist every event.
  assert.ok(results.every((r) => r.ok === true), 'no SEQ_COLLISION_RETRY_EXHAUSTED / drop');
  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4]);
  assert.ok(results.every((r) => r.idempotent === false && r.retried === false));
  assert.deepEqual(m.stored('run-1').map((r) => r.seq), [1, 2, 3, 4]);
});

test('concurrent duplicate delivery of the SAME event → recorded once per delivery, never silently dropped', async () => {
  const m = createMockPg();
  const relay = createRunEventRelay({ pg: m.pg });
  const evt = { runId: 'run-1', type: 'studio.run_node.completed', payload: { run_node_id: 'n1', attempt: 1 } };

  const [a, b] = await Promise.all([relay.relayRunEvent(evt), relay.relayRunEvent(evt)]);

  // Atomic allocation gives each delivery its own seq (the pre-fix racy design
  // collapsed identical concurrent deliveries onto one seq via a PK collision).
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual([a.seq, b.seq].sort((x, y) => x - y), [1, 2]);
  assert.equal(m.stored('run-1').length, 2);
});
