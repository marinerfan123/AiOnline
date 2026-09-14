'use strict';
/**
 * G21 — runEventStore.cjs unit tests (mock pg routed by SQL shape).
 *
 * The mock implements real PK semantics for run_events (run_id, seq): a second
 * INSERT for an existing key is a no-op returning rowCount 0, exactly like
 * Postgres `ON CONFLICT (run_id, seq) DO NOTHING`. jsonb columns are stored
 * serialized and parsed back on SELECT, mirroring node-pg behaviour.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRunEventStore } = require('./runEventStore.cjs');

function createMockPg() {
  // rowsByRun: runId -> Map<seq, {seq, type, payloadJson}>
  const rowsByRun = new Map();
  const calls = [];
  let createTableCalls = 0;

  function getRun(runId) {
    if (!rowsByRun.has(runId)) rowsByRun.set(runId, new Map());
    return rowsByRun.get(runId);
  }

  async function query(text, params = []) {
    calls.push({ text, params });
    const sql = String(text).trim();

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS run_events')) {
      createTableCalls += 1;
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS run_event_counters')) {
      return { rows: [], rowCount: 0 };
    }
    // Atomic auto-seq allocate (appendNextRunEvent): MAX+1 computed and
    // inserted in one synchronous step — mirrors the advisory-locked
    // INSERT…SELECT…RETURNING against real Postgres (no interleaving possible
    // because the whole branch runs without awaiting).
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
    get createTableCalls() { return createTableCalls; },
    stored: (runId) => {
      const run = rowsByRun.get(runId);
      return run ? [...run.values()].map((r) => ({ ...r, payloadJson: JSON.parse(r.payloadJson) })) : [];
    },
  };
}

test('appendRunEvent inserts row; CREATE TABLE issued lazily once per store', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  const r1 = await store.appendRunEvent({ runId: 'run-1', type: 'run.started', payload: { status: 'RUNNING' }, seq: 1 });
  assert.deepEqual(r1, { ok: true, idempotent: false, seq: 1 });
  assert.equal(m.createTableCalls, 1);
  // CREATE only precedes the first write — never re-issued.
  await store.appendRunEvent({ runId: 'run-1', type: 'run.node.started', payload: { nodeId: 'n1' }, seq: 2 });
  assert.equal(m.createTableCalls, 1);
  assert.equal(m.stored('run-1').length, 2);
  const insert = m.calls.find((c) => c.text.includes('INSERT INTO run_events'));
  assert.match(insert.text, /ON CONFLICT \(run_id, seq\) DO NOTHING/);
  assert.deepEqual(insert.params.slice(0, 4), ['run-1', 1, 'run.started', JSON.stringify({ status: 'RUNNING' })]);
});

test('appendRunEvent is idempotent on duplicate (run_id, seq) — no double write', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  const first = await store.appendRunEvent({ runId: 'run-1', type: 'run.started', payload: { a: 1 }, seq: 1 });
  const second = await store.appendRunEvent({ runId: 'run-1', type: 'run.started', payload: { a: 1 }, seq: 1 });
  assert.equal(first.idempotent, false);
  assert.deepEqual(second, { ok: true, idempotent: true, seq: 1 });
  assert.equal(m.insertCount(), 2); // INSERT attempted twice…
  assert.equal(m.stored('run-1').length, 1); // …but PK semantics kept a single row
  // Fresh store instance over the SAME pg: same idempotent contract.
  const store2 = createRunEventStore({ pg: m.pg });
  const retry = await store2.appendRunEvent({ runId: 'run-1', type: 'run.started', payload: { a: 1 }, seq: 1 });
  assert.deepEqual(retry, { ok: true, idempotent: true, seq: 1 });
  assert.equal(m.stored('run-1').length, 1);
});

test('appendRunEvent rejects non-positive / non-integer seq and bad inputs', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  for (const bad of [0, -1, 1.5, '1', NaN, null, undefined]) {
    const r = await store.appendRunEvent({ runId: 'run-1', type: 'run.started', payload: {}, seq: bad });
    assert.equal(r.ok, false, `seq=${String(bad)} must be rejected`);
    assert.equal(r.error.code, 'INVALID_SEQ');
  }
  assert.equal(m.stored('run-1').length, 0);
  assert.equal((await store.appendRunEvent({ runId: '', type: 'x', payload: {}, seq: 1 })).error.code, 'INVALID_RUN_ID');
  assert.equal((await store.appendRunEvent({ runId: 'run-1', type: '', payload: {}, seq: 1 })).error.code, 'INVALID_TYPE');
  assert.equal((await store.appendRunEvent({ runId: 'run-1', type: 'x', payload: 'not-object', seq: 1 })).error.code, 'INVALID_PAYLOAD');
  assert.equal(m.insertCount(), 0);
});

test('listRunEvents returns seq-ordered events after afterSeq (exclusive), run-scoped', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  const events = [
    { runId: 'run-1', type: 'run.started', payload: { status: 'RUNNING' }, seq: 1 },
    { runId: 'run-1', type: 'run.node.started', payload: { nodeId: 'n1' }, seq: 2 },
    { runId: 'run-1', type: 'run.node.completed', payload: { nodeId: 'n1' }, seq: 3 },
    { runId: 'run-2', type: 'run.started', payload: {}, seq: 1 }, // other run must not leak
  ];
  for (const e of events) {
    const r = await store.appendRunEvent(e);
    assert.equal(r.ok, true);
  }
  const all = await store.listRunEvents({ runId: 'run-1' });
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(all.events[0], { runId: 'run-1', seq: 1, type: 'run.started', payload: { status: 'RUNNING' } });
  const resumed = await store.listRunEvents({ runId: 'run-1', afterSeq: 1 });
  assert.deepEqual(resumed.events.map((e) => e.seq), [2, 3]);
  // replay slice carries the resume point through the WHERE seq > $2 param
  const listCall = m.calls.find((c) => c.text.includes('ORDER BY seq') && c.params[1] === 1);
  assert.deepEqual(listCall.params, ['run-1', 1, 500]);
});

test('listRunEvents truncates at limit (default 500, clamp) and keeps ascending order', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  for (let seq = 1; seq <= 12; seq += 1) {
    const r = await store.appendRunEvent({ runId: 'run-1', type: 'run.tick', payload: { seq }, seq });
    assert.equal(r.ok, true);
  }
  const two = await store.listRunEvents({ runId: 'run-1', afterSeq: 0, limit: 2 });
  assert.deepEqual(two.events.map((e) => e.seq), [1, 2]);
  const tail = await store.listRunEvents({ runId: 'run-1', afterSeq: 10, limit: 5 });
  assert.deepEqual(tail.events.map((e) => e.seq), [11, 12]);
  // invalid limit falls back to 500; page of 12 fits whole
  const whole = await store.listRunEvents({ runId: 'run-1', limit: 0 });
  assert.deepEqual(whole.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const capped = await store.listRunEvents({ runId: 'run-1', limit: 99999 });
  assert.deepEqual(capped.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // clamped to 1000
});

test('listRunEvents payload round-trips through jsonb parse', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  const payload = { status: 'RUNNING', progress: { nodeId: 'n1', pct: 0.5 }, tags: ['a', 'b'] };
  await store.appendRunEvent({ runId: 'run-1', type: 'run.started', payload, seq: 1 });
  const { events } = await store.listRunEvents({ runId: 'run-1', afterSeq: 0 });
  assert.deepEqual(events[0].payload, payload);
});

test('lastSequence returns max seq, 0 when run has no events', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  assert.deepEqual(await store.lastSequence({ runId: 'run-empty' }), { seq: 0 });
  for (let seq = 1; seq <= 3; seq += 1) {
    await store.appendRunEvent({ runId: 'run-1', type: 'run.tick', payload: {}, seq });
  }
  assert.deepEqual(await store.lastSequence({ runId: 'run-1' }), { seq: 3 });
  assert.equal(await store.lastSequence({ runId: 'run-2' }).then((r) => r.seq), 0);
  assert.equal((await store.lastSequence({ runId: '' })).error.code, 'INVALID_RUN_ID');
});

test('reads never issue CREATE TABLE; only append owns schema ensure', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  await store.listRunEvents({ runId: 'run-1' });
  await store.lastSequence({ runId: 'run-1' });
  assert.equal(m.createTableCalls, 0);
  await store.appendRunEvent({ runId: 'run-1', type: 'run.started', payload: {}, seq: 1 });
  assert.equal(m.createTableCalls, 1);
  // different store instance over same pg re-creates lazily (IF NOT EXISTS is safe)
  const store2 = createRunEventStore({ pg: m.pg });
  await store2.appendRunEvent({ runId: 'run-1', type: 'run.tick', payload: {}, seq: 2 });
  assert.equal(m.createTableCalls, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// appendNextRunEvent — atomic advisory-locked seq allocation
// ─────────────────────────────────────────────────────────────────────────────
test('appendNextRunEvent allocates contiguous per-run seq atomically (no caller seq)', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });

  const r1 = await store.appendNextRunEvent({ runId: 'run-1', type: 'run.started', payload: { status: 'RUNNING' } });
  assert.deepEqual(r1, { ok: true, idempotent: false, seq: 1 });
  const r2 = await store.appendNextRunEvent({ runId: 'run-1', type: 'run.node.started', payload: { nodeId: 'n1' } });
  assert.deepEqual(r2, { ok: true, idempotent: false, seq: 2 });
  // per-run scope: a second run starts at 1
  const rOther = await store.appendNextRunEvent({ runId: 'run-2', type: 'run.started', payload: {} });
  assert.deepEqual(rOther, { ok: true, idempotent: false, seq: 1 });

  // single-statement SQL shape (atomic counter + RETURNING) is what makes it atomic
  const appends = m.calls.filter((c) => c.text.includes('INSERT INTO run_events') && c.text.includes('RETURNING seq'));
  assert.equal(appends.length, 3);
  assert.match(appends[0].text, /run_event_counters/);
  assert.match(appends[0].text, /ON CONFLICT \(run_id\) DO UPDATE SET seq = run_event_counters\.seq \+ 1/);
  assert.match(appends[0].text, /RETURNING seq/);
  assert.deepEqual(appends[0].params, ['run-1', 'run.started', JSON.stringify({ status: 'RUNNING' })]);
});

test('appendNextRunEvent: N-way concurrent appends never collide — 10 distinct events land on 1..10', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      store.appendNextRunEvent({ runId: 'run-1', type: `run.tick.${i}`, payload: { i } }))
  );

  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'no dropped event, contiguous seqs');
  assert.ok(results.every((r) => r.ok === true && r.idempotent === false));
  assert.equal(m.stored('run-1').length, 10);
});

test('appendNextRunEvent validates inputs like appendRunEvent (no SQL on rejection)', async () => {
  const m = createMockPg();
  const store = createRunEventStore({ pg: m.pg });
  assert.equal((await store.appendNextRunEvent({ type: 'x', payload: {} })).error.code, 'INVALID_RUN_ID');
  assert.equal((await store.appendNextRunEvent({ runId: 'r', type: '' })).error.code, 'INVALID_TYPE');
  assert.equal((await store.appendNextRunEvent({ runId: 'r', type: 'x', payload: 'nope' })).error.code, 'INVALID_PAYLOAD');
  assert.equal(m.calls.length, 0);
});
