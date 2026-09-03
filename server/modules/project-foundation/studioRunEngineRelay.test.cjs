'use strict';
/**
 * G21 — studioRunEngine → runEventRelay bridge unit tests (NO real DB).
 *
 * The engine is driven through its real public API (leaseReadyNodes) over a
 * purpose-built mock pg that emulates exactly the SQL shapes that path issues
 * (BEGIN / lease CTE / run flip / studio_run_events INSERT / COMMIT), while the
 * relay under test is the REAL createRunEventRelay + runEventStore running
 * against a second, in-memory mock pg with genuine (run_id, seq) PK semantics
 * (duplicate INSERT → rowCount 0, MAX(seq) computed at query time).
 *
 * Covered:
 *   - relay wired → relayRunEvent is called once per engine-emitted event,
 *     seq allocated by the relay (1,2,3… per run), runNodeId folded into
 *     payload as run_node_id;
 *   - seq counters are per-run and continue across separate engine ticks;
 *   - engine WITHOUT relay behaves identically (no relay calls, same events);
 *   - a non-callable relay dep is ignored like "no relay";
 *   - relay failure (throw or {ok:false}) only logs 'event.relay_failed' and
 *     never disturbs execution or the emitted studio_run_events.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStudioRunEngine } = require('./studioRunEngine.cjs');
const { createRunEventRelay } = require('./runEventRelay.cjs');

/**
 * In-memory run_events pg for the REAL relay+store: PK semantics = a repeated
 * INSERT at an existing (run_id, seq) returns rowCount 0 (ON CONFLICT DO
 * NOTHING); COALESCE MAX(seq) read at query time (so races are visible).
 */
function createRunEventsMockPg() {
  const rowsByRun = new Map(); // runId -> Map<seq, {seq, type, payloadJson}>
  const calls = [];
  function getRun(runId) {
    if (!rowsByRun.has(runId)) rowsByRun.set(runId, new Map());
    return rowsByRun.get(runId);
  }
  async function query(text, params = []) {
    calls.push({ text, params });
    const sql = String(text).trim();
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS run_events')) return { rows: [], rowCount: 0 };
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
    throw new Error(`run_events mock: unhandled SQL: ${sql}`);
  }
  return {
    pg: { query },
    calls,
    stored: (runId) => {
      const run = rowsByRun.get(runId);
      return run ? [...run.values()].map((r) => ({ ...r, payload_json: JSON.parse(r.payloadJson) })) : [];
    },
  };
}

/**
 * Engine-side pg mock supporting exactly the SQL shapes leaseReadyNodes
 * issues (tx lifecycle, the lease CTE, the QUEUED→RUNNING flip and the
 * studio_run_events INSERT). leaseBatches is consumed one array-of-node-rows
 * per leaseReadyNodes call — like real READY rows RETURNING n.*.
 */
function createEngineMockPg(leaseBatches) {
  const studioEvents = []; // {runId, runNodeId, eventType, payload} (durable INSERTs)
  const issued = []; // every SQL issued on the tx client (assertion aid)
  let batchIndex = 0;
  const nextBatch = () => (batchIndex < leaseBatches.length ? leaseBatches[batchIndex] : []);
  const client = {
    async query(text, params = []) {
      const sql = String(text).trim();
      issued.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.startsWith('WITH picked AS')) {
        const rows = nextBatch();
        batchIndex += 1;
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('UPDATE studio_runs SET status')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO studio_run_events')) {
        const [runId, runNodeId, eventType, payloadJson] = params;
        studioEvents.push({ runId, runNodeId, eventType, payload: JSON.parse(payloadJson) });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`engine mock: unhandled SQL: ${sql}`);
    },
    release() {},
  };
  const pg = {
    connect: async () => client,
    query: async () => { throw new Error('engine mock: no pool-level query expected on the lease path'); },
  };
  return { pg, studioEvents, issued };
}

/** lease path shape of a leased studio_run_nodes row (fields the engine reads). */
function leasedNode({ id, runId, studioNodeId, attempt = 1 }) {
  return { id, run_id: runId, studio_node_id: studioNodeId, attempt, status: 'RUNNING' };
}

function makeEngine(pg, { relay, onLog } = {}) {
  const logs = [];
  return {
    engine: createStudioRunEngine({
      pg,
      workerId: 'w-relay-unit',
      relay,
      onLog: onLog || ((tag, payload) => logs.push({ tag, payload })),
    }),
    logs,
  };
}

test('relay wired: relayRunEvent called per emitted event, seq allocated by relay (lastSequence+1), runNodeId folded in', async () => {
  const runEventsMock = createRunEventsMockPg();
  const relay = createRunEventRelay({ pg: runEventsMock.pg });
  const engineMock = createEngineMockPg([
    [leasedNode({ id: 'rn-a', runId: 'run-1', studioNodeId: 'A' }), leasedNode({ id: 'rn-b', runId: 'run-1', studioNodeId: 'B' })],
    [leasedNode({ id: 'rn-c', runId: 'run-2', studioNodeId: 'C' })],
    [leasedNode({ id: 'rn-d', runId: 'run-1', studioNodeId: 'D' })],
  ]);
  const { engine } = makeEngine(engineMock.pg, { relay });

  // Tick 1: two nodes of run-1 → engine emits 2 events, relay seq 1 and 2.
  const leased = await engine.leaseReadyNodes({ limit: 2 });
  assert.deepEqual(leased.map((n) => n.id), ['rn-a', 'rn-b']);

  assert.equal(engineMock.studioEvents.length, 2);
  assert.ok(engineMock.studioEvents.every((e) => e.eventType === 'studio.run_node.started' && e.runId === 'run-1'));

  let stored = runEventsMock.stored('run-1');
  assert.deepEqual(stored.map((r) => r.seq), [1, 2], 'relay must allocate lastSequence+1 → 1,2 in emission order');
  assert.deepEqual(stored.map((r) => r.type), ['studio.run_node.started', 'studio.run_node.started']);
  // Engine-side type verbatim + runNodeId folded into payload as run_node_id.
  assert.deepEqual(stored[0].payload_json, { run_node_id: 'rn-a', studio_node_id: 'A', attempt: 1 });
  assert.deepEqual(stored[1].payload_json, { run_node_id: 'rn-b', studio_node_id: 'B', attempt: 1 });

  // Tick 2: a fresh run starts its own seq at 1 (counters are per-run).
  await engine.leaseReadyNodes({ limit: 1 });
  stored = runEventsMock.stored('run-2');
  assert.deepEqual(stored.map((r) => r.seq), [1]);
  assert.equal(stored[0].payload_json.run_node_id, 'rn-c');

  // Tick 3: run-1 continues at seq 3 across separate engine ticks.
  await engine.leaseReadyNodes({ limit: 1 });
  stored = runEventsMock.stored('run-1');
  assert.deepEqual(stored.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(stored[2].payload_json, { run_node_id: 'rn-d', studio_node_id: 'D', attempt: 1 });

  // The engine never picked a seq: no sql went to the run_events pg from the engine side.
  assert.deepEqual(engineMock.studioEvents.map((e) => e.runId), ['run-1', 'run-1', 'run-2', 'run-1']);
});

test('engine without relay: behaviour identical (same leased rows, same studio_run_events, zero relay calls)', async () => {
  const batches = [
    [leasedNode({ id: 'rn-a', runId: 'run-1', studioNodeId: 'A' }), leasedNode({ id: 'rn-b', runId: 'run-1', studioNodeId: 'B' })],
  ];

  // Engine WITH relay (control).
  const relayedEngineMock = createEngineMockPg(batches.map((b) => [...b]));
  const relay = createRunEventRelay({ pg: createRunEventsMockPg().pg });
  const { engine: withRelay } = makeEngine(relayedEngineMock.pg, { relay });

  // Engine WITHOUT relay (subject).
  const plainEngineMock = createEngineMockPg(batches.map((b) => [...b]));
  const plainLogs = [];
  const { engine: withoutRelay } = makeEngine(plainEngineMock.pg, {
    onLog: (tag, payload) => plainLogs.push({ tag, payload }),
  });

  const leasedRelay = await withRelay.leaseReadyNodes({ limit: 2 });
  const leasedPlain = await withoutRelay.leaseReadyNodes({ limit: 2 });

  assert.deepEqual(leasedPlain, leasedRelay, 'leased rows identical with/without relay');
  assert.deepEqual(plainEngineMock.studioEvents, relayedEngineMock.studioEvents,
    'studio_run_events identical — relay adds no engine-side side effects');
  assert.ok(plainLogs.every((l) => l.tag !== 'event.relay_failed'), 'no relay failure logs without a relay');
  // Same SQL surface on the engine tx client (relay talks to its own pg only).
  assert.deepEqual(plainEngineMock.issued, relayedEngineMock.issued);
});

test('relay dep without a callable relayRunEvent is ignored (treated as no relay)', async () => {
  const batches = [[leasedNode({ id: 'rn-a', runId: 'run-1', studioNodeId: 'A' })]];
  const engineMock = createEngineMockPg(batches.map((b) => [...b]));
  const logs = [];
  const engine = createStudioRunEngine({
    pg: engineMock.pg,
    workerId: 'w-relay-unit',
    relay: { relayRunEvent: 'not-a-function' }, // malformed relay dep
    onLog: (tag, payload) => logs.push({ tag, payload }),
  });
  const leased = await engine.leaseReadyNodes({ limit: 1 });
  assert.equal(leased.length, 1);
  assert.equal(engineMock.studioEvents.length, 1);
  assert.ok(logs.every((l) => l.tag !== 'event.relay_failed'));
});

test('relay failure (throw or {ok:false}) only logs event.relay_failed — execution and events unaffected', async () => {
  // Case 1: relayRunEvent throws (e.g. pool down).
  const engineMock1 = createEngineMockPg([
    [leasedNode({ id: 'rn-a', runId: 'run-1', studioNodeId: 'A' }), leasedNode({ id: 'rn-b', runId: 'run-1', studioNodeId: 'B' })],
  ]);
  const logs1 = [];
  const engine1 = createStudioRunEngine({
    pg: engineMock1.pg,
    workerId: 'w-relay-unit',
    relay: { relayRunEvent: async () => { throw new Error('relay pool down'); } },
    onLog: (tag, payload) => logs1.push({ tag, payload }),
  });
  const leased1 = await engine1.leaseReadyNodes({ limit: 2 }); // must NOT throw
  assert.deepEqual(leased1.map((n) => n.id), ['rn-a', 'rn-b']);
  assert.equal(engineMock1.studioEvents.length, 2, 'studio_run_events still recorded while relay is down');
  const fails1 = logs1.filter((l) => l.tag === 'event.relay_failed');
  assert.equal(fails1.length, 2, 'one warn per failed relay attempt');
  assert.match(fails1[0].payload.error, /relay pool down/);

  // Case 2: relayRunEvent resolves {ok:false} (validation/seq collision) — same contract.
  const engineMock2 = createEngineMockPg([[leasedNode({ id: 'rn-c', runId: 'run-1', studioNodeId: 'C' })]]);
  const logs2 = [];
  const engine2 = createStudioRunEngine({
    pg: engineMock2.pg,
    workerId: 'w-relay-unit',
    relay: { relayRunEvent: async () => ({ ok: false, errors: [{ code: 'LAST_SEQ_FAILED', message: 'db unreachable' }] }) },
    onLog: (tag, payload) => logs2.push({ tag, payload }),
  });
  const leased2 = await engine2.leaseReadyNodes({ limit: 1 }); // must NOT throw
  assert.equal(leased2.length, 1);
  assert.equal(engineMock2.studioEvents.length, 1);
  const fails2 = logs2.filter((l) => l.tag === 'event.relay_failed');
  assert.equal(fails2.length, 1);
  assert.equal(fails2[0].payload.error[0].code, 'LAST_SEQ_FAILED');
});
