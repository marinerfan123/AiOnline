'use strict';
/**
 * G21 — studioRunApi run-events SSE read side tests.
 *
 * Harness style follows the house modules (runEventStore.test.cjs /
 * continuityApi.test.cjs): node:test + node:assert/strict over an in-memory
 * mock pg that implements run_events PK semantics, guard tables
 * (studio_runs/projects/workspaces/workspace_members) and fake req/res SSE
 * transports.
 *
 * Coverage:
 *   - initial full replay, seq-ordered, one SSE message per run event
 *   - Last-Event-ID → afterSeq resume (only later events are replayed)
 *   - incremental 2s-poll delta while the stream is open
 *   - client disconnect tears down the poll timer (no further DB reads/writes)
 *   - 60s window cap closes the stream with HTTP 200 (client re-subscribes)
 *   - run missing → 404, run outside user's workspace → 403 (guards run INSIDE
 *     the SSE handler — SSE has no dispatcher role gate)
 *   - admin/system role bypasses the workspace membership check
 *   - dispatcher route GET /runs/:runId/events streams via handleRunEventsSse
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStudioRunApi, createRunEventsSse } = require('./studioRunApi.cjs');

const BASE_TS = Date.parse('2026-09-04T00:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// mock pg: run_events rows + guard tables, routed by SQL shape (house style)
// ─────────────────────────────────────────────────────────────────────────────
function createPgMock() {
  const state = {
    events: new Map(),   // runId -> Map<seq, {seq,type,payloadJson,createdAt}>
    runs: new Map(),     // runId -> { id, project_id }
    projects: new Map(), // projectId -> { id, workspace_id }
    members: new Set(),  // 'workspaceId|userId'
  };
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql: String(sql).trim(), params });
    const text = String(sql);

    if (text.includes('CREATE TABLE IF NOT EXISTS run_events')) return { rows: [], rowCount: 0 };

    if (text.includes('INSERT INTO run_events')) {
      const [runId, seq, type, payloadJson] = params;
      if (!state.events.has(runId)) state.events.set(runId, new Map());
      const run = state.events.get(runId);
      if (run.has(seq)) return { rows: [], rowCount: 0 }; // PK conflict → DO NOTHING
      run.set(seq, {
        seq,
        type,
        payloadJson,
        createdAt: new Date(BASE_TS + seq * 1000).toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    // SSE reader replay (selects created_at → ts). Store's listRunEvents never
    // selects created_at, so this branch is unambiguous for the SSE module.
    if (text.includes('FROM run_events') && text.includes('ORDER BY seq') && text.includes('created_at')) {
      const [runId, afterSeq, limit] = params;
      const run = state.events.get(runId);
      const all = run ? [...run.values()] : [];
      const rows = all
        .filter((r) => r.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((r) => ({
          seq: r.seq,
          type: r.type,
          payload_json: JSON.parse(r.payloadJson),
          created_at: r.createdAt,
        }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes('COALESCE')) {
      const [runId] = params;
      const run = state.events.get(runId);
      const seq = run && run.size ? Math.max(...run.keys()) : 0;
      return { rows: [{ seq }], rowCount: 1 };
    }

    if (text.includes('FROM studio_runs r')) {
      const [runId] = params;
      const run = state.runs.get(runId);
      if (!run) return { rows: [], rowCount: 0 };
      const project = state.projects.get(run.project_id);
      return {
        rows: [{
          run_id: run.id,
          project_id: run.project_id,
          workspace_id: project ? project.workspace_id : null,
          workspace_owner_id: 'owner-1',
        }],
        rowCount: 1,
      };
    }

    if (text.includes('FROM workspace_members')) {
      const [workspaceId, userId] = params;
      const ok = state.members.has(`${workspaceId}|${userId}`);
      return { rows: ok ? [{ workspace_id: workspaceId, user_id: userId, role: 'editor' }] : [], rowCount: ok ? 1 : 0 };
    }

    throw new Error(`mock pg: unhandled SQL: ${text}`);
  }

  return {
    pg: { query },
    calls,
    countQueries: () => calls.length,
    countBy: (re) => calls.filter((c) => re.test(c.sql)).length,
    addRun(runId, projectId, workspaceId) {
      state.runs.set(runId, { id: runId, project_id: projectId });
      state.projects.set(projectId, { id: projectId, workspace_id: workspaceId });
    },
    addMember(workspaceId, userId) { state.members.add(`${workspaceId}|${userId}`); },
    insertEvent(runId, seq, type, payload) {
      if (!state.events.has(runId)) state.events.set(runId, new Map());
      const run = state.events.get(runId);
      run.set(seq, {
        seq,
        type,
        payloadJson: JSON.stringify(payload === undefined ? {} : payload),
        createdAt: new Date(BASE_TS + seq * 1000).toISOString(),
      });
    },
    appendEvent(runId, type, payload) {
      const run = state.events.get(runId) || new Map();
      const seq = run.size ? Math.max(...run.keys()) + 1 : 1;
      state.events.set(runId, run);
      this.insertEvent(runId, seq, type, payload);
      return seq;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fake SSE transport
// ─────────────────────────────────────────────────────────────────────────────
function makeReq(headers = {}) {
  const req = new EventEmitter();
  req.headers = { ...headers };
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.statusCode = 200;
  res.headers = null;
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.flushHeaders = () => {};
  res.write = (chunk) => {
    if (res.writableEnded) return false;
    res.chunks.push(String(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.chunks.push(String(chunk));
    res.writableEnded = true;
    res.headersSent = true;
  };
  return res;
}

function dataEvents(res) {
  const out = [];
  for (const chunk of res.chunks) {
    const m = String(chunk).match(/^data: (.+)$/m);
    if (m) { try { out.push(JSON.parse(m[1])); } catch (_) { /* not an event payload */ } }
  }
  return out;
}

function idsIn(res) {
  const out = [];
  for (const chunk of res.chunks) {
    const m = String(chunk).match(/^id: (\d+)$/m);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USERS = {
  editor: { id: 'u-1', role: 'editor' },
  outsider: { id: 'u-9', role: 'editor' },
  admin: { id: 'u-admin', role: 'admin' },
};

// seed: run-1 lives in project p-1 / workspace w-1 (editor u-1 member by default)
function seedRun(m, { runId = 'run-1', workspaceId = 'w-1', member = true } = {}) {
  const projectId = workspaceId === 'w-1' ? 'p-1' : 'p-2';
  m.addRun(runId, projectId, workspaceId);
  if (member) m.addMember(workspaceId, 'u-1');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. factory validation
// ─────────────────────────────────────────────────────────────────────────────
test('G21: createRunEventsSse requires a query-capable pg; exports streamRunEvents', () => {
  assert.throws(() => createRunEventsSse({}), /pg/);
  assert.throws(() => createRunEventsSse({ pg: {} }), /pg/);
  const m = createPgMock();
  const sse = createRunEventsSse({ pg: m.pg });
  assert.equal(typeof sse.streamRunEvents, 'function');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. guards (inside the SSE handler — no dispatcher role gate upstream)
// ─────────────────────────────────────────────────────────────────────────────
test('G21: run does not exist → 404 JSON before any SSE byte', async () => {
  const m = createPgMock();
  const res = makeRes();
  const req = makeReq();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req, res, runId: 'ghost-run', user: USERS.editor });
  assert.equal(ctrl.status, 404);
  assert.equal(res.statusCode, 404);
  assert.notEqual(res.headers && res.headers['Content-Type'], undefined);
  assert.match(res.headers['Content-Type'], /application\/json/);
  assert.equal(res.headersSent, true);
  const body = res.chunks.join('');
  assert.deepEqual(JSON.parse(body), { ok: false, error: 'RUN_NOT_FOUND' });
  assert.equal((await ctrl.done).reason, 'guard');
  // no SSE replay query was even attempted
  assert.equal(m.countBy(/FROM run_events/), 0);
});

test('G21: run in another workspace (no membership) → 403', async () => {
  const m = createPgMock();
  seedRun(m, { runId: 'run-2', workspaceId: 'w-2', member: false }); // u-1 is NOT a w-2 member
  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req: makeReq(), res, runId: 'run-2', user: USERS.editor });
  assert.equal(ctrl.status, 403);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.chunks.join('')), { ok: false, error: '无项目权限' });
});

test('G21: admin/system bypasses workspace membership (guard mirrors run GET)', async () => {
  const m = createPgMock();
  seedRun(m, { runId: 'run-2', workspaceId: 'w-2', member: false }); // admin is not a member — bypass proves the role path
  m.insertEvent('run-2', 1, 'run.started', { status: 'RUNNING' });
  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req: makeReq(), res, runId: 'run-2', user: USERS.admin });
  assert.equal(ctrl.status, 200);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.equal(dataEvents(res).length, 1);
  res.emit('close');
  assert.equal((await ctrl.done).reason, 'client-closed');
});

test('G21: unauthenticated (no user) → 401 JSON', async () => {
  const m = createPgMock();
  seedRun(m);
  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req: makeReq(), res, runId: 'run-1', user: null });
  assert.equal(ctrl.status, 401);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.chunks.join('')), { ok: false, error: '未登录' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. initial full replay + ordering
// ─────────────────────────────────────────────────────────────────────────────
test('G21: initial open replays ALL run events, seq-ordered, one SSE message each', async () => {
  const m = createPgMock();
  seedRun(m);
  m.insertEvent('run-1', 1, 'run.started', { status: 'RUNNING' });
  m.insertEvent('run-1', 2, 'run.node.started', { nodeId: 'n1' });
  m.insertEvent('run-1', 3, 'run.node.completed', { nodeId: 'n1', ok: true });

  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req: makeReq(), res, runId: 'run-1', user: USERS.editor });

  assert.equal(ctrl.status, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.headers['Cache-Control'], /no-cache/);

  const evs = dataEvents(res);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(idsIn(res), [1, 2, 3]); // id: lines drive the client's Last-Event-ID
  for (const e of evs) {
    assert.equal(typeof e.type, 'string');
    assert.equal(typeof e.payload, 'object');
    assert.equal(typeof e.ts, 'string');
    assert.ok(!Number.isNaN(Date.parse(e.ts)), 'ts must be an ISO instant');
  }
  assert.deepEqual(evs[0], { seq: 1, type: 'run.started', payload: { status: 'RUNNING' }, ts: new Date(BASE_TS + 1000).toISOString() });

  // tear down
  res.emit('close');
  assert.equal((await ctrl.done).reason, 'client-closed');
});

test('G21: empty log opens the stream with headers and zero data lines', async () => {
  const m = createPgMock();
  seedRun(m);
  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req: makeReq(), res, runId: 'run-1', user: USERS.editor });
  assert.equal(res.statusCode, 200);
  assert.equal(dataEvents(res).length, 0);
  res.emit('close');
  await ctrl.done;
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Last-Event-ID resume
// ─────────────────────────────────────────────────────────────────────────────
test('G21: Last-Event-ID header resumes at afterSeq (only newer events sent)', async () => {
  const m = createPgMock();
  seedRun(m);
  for (let seq = 1; seq <= 8; seq += 1) m.insertEvent('run-1', seq, `run.tick.${seq}`, { seq });

  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const req = makeReq({ 'last-event-id': '5' });
  const ctrl = await sse.streamRunEvents({ req, res, runId: 'run-1', user: USERS.editor });

  const evs = dataEvents(res);
  assert.deepEqual(evs.map((e) => e.seq), [6, 7, 8]);
  assert.deepEqual(idsIn(res), [6, 7, 8]);
  assert.equal(ctrl.afterSeq(), 8);
  res.emit('close');
  await ctrl.done;
});

test('G21: bogus Last-Event-ID (non-integer) falls back to a full replay', async () => {
  const m = createPgMock();
  seedRun(m);
  m.insertEvent('run-1', 1, 'run.started', {});
  m.insertEvent('run-1', 2, 'run.node.started', { nodeId: 'n1' });
  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req: makeReq({ 'last-event-id': 'not-a-seq' }), res, runId: 'run-1', user: USERS.editor });
  assert.deepEqual(dataEvents(res).map((e) => e.seq), [1, 2]);
  res.emit('close');
  await ctrl.done;
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. incremental poll deltas
// ─────────────────────────────────────────────────────────────────────────────
test('G21: while open, 2s-style polling streams events appended after the initial replay', async () => {
  const m = createPgMock();
  seedRun(m);
  m.insertEvent('run-1', 1, 'run.started', { status: 'RUNNING' });
  m.insertEvent('run-1', 2, 'run.node.started', { nodeId: 'n1' });

  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({
    req: makeReq(), res, runId: 'run-1', user: USERS.editor,
    opts: { pollMs: 20, maxWindowMs: 500 },
  });

  assert.deepEqual(dataEvents(res).map((e) => e.seq), [1, 2]);
  const before = m.countBy(/COALESCE/);
  await sleep(45); // a couple of poll cycles with nothing new → lastSequence reads only
  assert.ok(m.countBy(/COALESCE/) >= before + 1, 'poll loop must consult lastSequence');
  assert.deepEqual(dataEvents(res).map((e) => e.seq), [1, 2], 'no new data without new events');

  // event lands mid-stream → next poll picks it up
  m.appendEvent('run-1', 'run.node.completed', { nodeId: 'n1' });
  await sleep(60);
  assert.deepEqual(dataEvents(res).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(ctrl.afterSeq(), 3);

  const writesAtStop = res.chunks.length;
  const queriesAtStop = m.countQueries();
  ctrl.stop('test-done');
  const outcome = await ctrl.done;
  assert.equal(outcome.reason, 'test-done');
  assert.equal(ctrl.closed(), true);
  await sleep(60); // a stale timer would poll/write again…
  assert.equal(m.countQueries(), queriesAtStop, 'no DB reads after stop');
  assert.equal(res.chunks.length, writesAtStop, 'no writes after stop');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. disconnect cleanup / window cap
// ─────────────────────────────────────────────────────────────────────────────
test('G21: client disconnect cleans up the poll timer (done resolves, no further activity)', async () => {
  const m = createPgMock();
  seedRun(m);
  m.insertEvent('run-1', 1, 'run.started', { status: 'RUNNING' });

  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req: makeReq(), res, runId: 'run-1', user: USERS.editor, opts: { pollMs: 15 } });
  assert.equal(dataEvents(res).length, 1);

  const queriesAtClose = m.countQueries();
  const writesAtClose = res.chunks.length;
  res.emit('close'); // client dropped the connection
  const outcome = await ctrl.done;
  assert.equal(outcome.reason, 'client-closed');
  assert.equal(outcome.status, 200);
  assert.equal(ctrl.closed(), true);
  assert.equal(res.writableEnded, true);

  await sleep(80); // pollMs=15 → a leaked timer would have fired ~5 times
  assert.equal(m.countQueries(), queriesAtClose, 'poll timer must be cleared on disconnect');
  assert.equal(res.chunks.length, writesAtClose, 'no writes after disconnect');
});

test('G21: 60s-style window cap closes the stream with HTTP 200 (client resubscribes)', async () => {
  const m = createPgMock();
  seedRun(m);
  m.insertEvent('run-1', 1, 'run.started', { status: 'RUNNING' });

  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({
    req: makeReq(), res, runId: 'run-1', user: USERS.editor,
    opts: { pollMs: 15, maxWindowMs: 40 },
  });
  assert.equal(dataEvents(res).length, 1);

  const outcome = await ctrl.done; // resolves once maxWindowMs elapses
  assert.equal(outcome.reason, 'max-window');
  assert.equal(outcome.status, 200);
  assert.equal(res.writableEnded, true, 'server closes cleanly so EventSource reconnects');
  assert.equal(res.statusCode, 200);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. dispatcher route + handleRunEventsSse export on the API instance
// ─────────────────────────────────────────────────────────────────────────────
function makeApiHarness({ pgMock, sessionUser } = {}) {
  const responses = [];
  const api = createStudioRunApi({
    pg: pgMock ? pgMock.pg : createPgMock().pg,
    engine: { getRunSnapshot: async () => null },
    sessionUser: sessionUser || (() => USERS.editor),
    sendJSON: (res, code, body) => {
      responses.push({ code, body });
      if (res && !res.headersSent && typeof res.writeHead === 'function') {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      } else if (res) {
        res.statusCode = code;
      }
      if (res && typeof res.end === 'function') res.end(JSON.stringify(body));
    },
    parseBody: async () => ({}),
  });
  return { api, responses };
}

test('G21: GET /runs/:runId/events dispatches to the SSE handler (headers + replay)', async () => {
  const m = createPgMock();
  seedRun(m);
  m.insertEvent('run-1', 1, 'run.started', { status: 'RUNNING' });
  m.insertEvent('run-1', 2, 'run.node.started', { nodeId: 'n1' });
  const { api } = makeApiHarness({ pgMock: m });

  const req = makeReq();
  const res = makeRes();
  const handled = await api.handle(req, res, '/api/v2/projects/p-1/studio/runs/run-1/events', 'GET');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.deepEqual(dataEvents(res).map((e) => e.seq), [1, 2]);

  // handleRunEventsSse is exposed on the instance for direct mounting
  assert.equal(typeof api.handleRunEventsSse, 'function');

  res.emit('close'); // leave no timer behind
  await sleep(30);
});

test('G21: events route without a session → 401 (auth identical to run GET)', async () => {
  const m = createPgMock();
  seedRun(m);
  const { api, responses } = makeApiHarness({ pgMock: m, sessionUser: () => null });
  const res = makeRes();
  const handled = await api.handle(makeReq(), res, '/api/v2/projects/p-1/studio/runs/run-1/events', 'GET');
  assert.equal(handled, true);
  assert.equal(responses[0].code, 401);
  assert.equal(responses[0].body.error, '未登录');
});

test('G21: 404 run / unknown route behaviour stays intact next to the events route', async () => {
  const m = createPgMock();
  const { api } = makeApiHarness({ pgMock: m });
  // run detail GET for a run in the project but with no events-table access still 404s via engine snapshot
  const res = makeRes();
  const handled = await api.handle(makeReq(), res, '/api/v2/projects/p-1/studio/runs/run-1/events', 'GET');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404); // ghost run → guard 404
  assert.deepEqual(JSON.parse(res.chunks.join('')), { ok: false, error: 'RUN_NOT_FOUND' });
});
