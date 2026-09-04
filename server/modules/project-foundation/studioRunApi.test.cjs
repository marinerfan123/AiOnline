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

test('G21: huge Last-Event-ID (beyond 2^53-1) degrades to full replay, never overflows BIGINT into a 500', async () => {
  const m = createPgMock();
  seedRun(m);
  m.insertEvent('run-1', 1, 'run.started', {});
  m.insertEvent('run-1', 2, 'run.node.started', { nodeId: 'n1' });
  const res = makeRes();
  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({
    req: makeReq({ 'last-event-id': '999999999999999999999999999999' }),
    res, runId: 'run-1', user: USERS.editor,
  });
  assert.equal(ctrl.status, 200, 'must not 500 on an over-BIGINT resume cursor');
  assert.deepEqual(dataEvents(res).map((e) => e.seq), [1, 2]);
  assert.deepEqual(ctrl.afterSeq(), 2);
  res.emit('close');
  await ctrl.done;
});

test('G21: backpressure — write()→false pauses the replay until drain, then every event still lands', async () => {
  const m = createPgMock();
  seedRun(m);
  for (let seq = 1; seq <= 5; seq += 1) m.insertEvent('run-1', seq, `run.tick.${seq}`, { seq });

  const res = makeRes();
  let backpressured = false;
  res.write = (chunk) => {
    // Data is buffered even when the transport is full — only the return value
    // signals "pause"; nothing is dropped.
    res.chunks.push(String(chunk));
    if (!backpressured) {
      backpressured = true;
      setImmediate(() => res.emit('drain')); // drain shortly after the pause
      return false;
    }
    return true;
  };

  const sse = createRunEventsSse({ pg: m.pg });
  const ctrl = await sse.streamRunEvents({ req: makeReq(), res, runId: 'run-1', user: USERS.editor });

  // The drain-aware write paused on backpressure, resumed on drain, and never
  // lost an event (pre-fix the replay ignored write()'s false and kept
  // buffering unboundedly without awaiting drain).
  assert.deepEqual(dataEvents(res).map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(backpressured, true, 'the transport must actually have signalled backpressure');
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

// ═════════════════════════════════════════════════════════════════════════════
// V2.0 must#2 — run create 预算护栏 + GET /runs/estimate（单写者 studioRunApi）
// ═════════════════════════════════════════════════════════════════════════════
// 策略（与 studioRunApi.cjs 头注一致）：
//  - 价格真源 models.credit_cost = 每逻辑模型「每任务价」（与 server.js L5
//    billingCount 语义对齐：video 固定 1 任务、image 按件，画布节点无 count → 1）。
//  - 无 project_budgets 行 → 放行（NO_BUDGET 策略）。
//  - 单位换算：1 credit = 10000 units（budgetEstimate，N(14,4)）。

function genPromptRow(id) {
  return {
    node_id: id, node_type: 'prompt', node_schema_version: 1,
    data_json: { nodeKind: 'prompt', schemaVersion: 1, status: 'READY', parameters: { prompt: 'p' }, prompt: 'p' },
  };
}
function genImageRow(id, model) {
  return {
    node_id: id, node_type: 'image-generation', node_schema_version: 1,
    data_json: { nodeKind: 'image-generation', schemaVersion: 1, status: 'READY', parameters: { logicalModelId: model, aspectRatio: '1:1', resolution: '1024x1024' } },
  };
}
function genVideoRow(id, model, duration = 5) {
  return {
    node_id: id, node_type: 'text-to-video', node_schema_version: 1,
    data_json: { nodeKind: 'text-to-video', schemaVersion: 1, status: 'READY', parameters: { logicalModelId: model, duration, aspectRatio: '16:9', resolution: '1280x720' } },
  };
}
function genEdge(id, from, to) {
  return { edge_id: id, source_node_id: from, source_handle: 'text', target_node_id: to, target_handle: 'text', edge_type: 'smoothstep' };
}

/**
 * 专用 mock pg（预算门 / 估算端点的 SQL 面）：projects / members / canvases /
 * canvas nodes+edges / project_budgets / models / studio_runs(canvas+key)。
 * connect() 返回与池同路由的 client（handleCreate 的事务面是 no-op 直连）。
 */
function createBudgetPgMock() {
  const state = {
    projects: new Map(),   // projectId -> { id, workspace_id }
    members: new Set(),    // 'workspaceId|userId'（成员默认 owner）
    canvases: new Map(),   // projectId -> { id, project_id, revision, schema_version }
    nodes: new Map(),      // canvasId -> rows[]
    edges: new Map(),      // canvasId -> rows[]
    budgets: new Map(),    // projectId -> { budget, spent }
    modelPrices: new Map(), // model_id -> credit_cost
    runsByKey: new Map(),  // 'canvasId|key' -> runId
  };
  const calls = [];
  const countBy = (re) => calls.filter((c) => re.test(c.sql)).length;

  async function query(sql, params = []) {
    calls.push({ sql: String(sql).trim(), params });
    const text = String(sql);

    if (text.includes('FROM studio_canvas_nodes')) {
      const rows = state.nodes.get(params[0]) || [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM studio_canvas_edges')) {
      const rows = state.edges.get(params[0]) || [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM studio_canvases')) {
      const canvas = state.canvases.get(params[0]);
      return { rows: canvas ? [canvas] : [], rowCount: canvas ? 1 : 0 };
    }
    if (text.includes('FROM project_budgets')) {
      const b = state.budgets.get(params[0]);
      if (!b) return { rows: [], rowCount: 0 };
      return { rows: [{ project_id: params[0], workspace_id: (state.projects.get(params[0]) || {}).workspace_id, budget: b.budget, spent: b.spent, warning_threshold: 0.8, approval_threshold: 1 }], rowCount: 1 };
    }
    if (text.includes('FROM models')) {
      const ids = new Set(params[0] || []);
      const rows = [...state.modelPrices.entries()].filter(([mid]) => ids.has(mid)).map(([model_id, credit_cost]) => ({ model_id, credit_cost }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM studio_runs WHERE canvas_id')) {
      const id = state.runsByKey.get(`${params[0]}|${params[1]}`);
      return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 };
    }
    if (text.includes('FROM projects p JOIN workspaces w')) {
      const p = state.projects.get(params[0]);
      if (!p) return { rows: [], rowCount: 0 };
      return { rows: [{ ...p, workspace_owner_id: 'owner-u', status: 'active', project_type: 'studio' }], rowCount: 1 };
    }
    if (text.includes('FROM workspace_members')) {
      const ok = state.members.has(`${params[0]}|${params[1]}`);
      return { rows: ok ? [{ workspace_id: params[0], user_id: params[1], role: 'owner' }] : [], rowCount: ok ? 1 : 0 };
    }
    throw new Error(`budget mock pg: unhandled SQL: ${text}`);
  }

  return {
    pg: { query, connect: async () => ({ query, release: async () => {} }) },
    calls,
    countBy,
    addProject(projectId, workspaceId) { state.projects.set(projectId, { id: projectId, workspace_id: workspaceId }); },
    addMember(workspaceId, userId) { state.members.add(`${workspaceId}|${userId}`); },
    addCanvas(projectId, canvasId, revision) {
      state.canvases.set(projectId, { id: canvasId, project_id: projectId, revision, schema_version: 1, is_primary: true, archived_at: null });
    },
    setNodes(canvasId, rows) { state.nodes.set(canvasId, rows); },
    setEdges(canvasId, rows) { state.edges.set(canvasId, rows); },
    setBudget(projectId, budget, spent) { state.budgets.set(projectId, { budget, spent }); },
    setModelPrice(modelId, creditCost) { state.modelPrices.set(modelId, creditCost); },
    addRun(canvasId, idempotencyKey, runId) { state.runsByKey.set(`${canvasId}|${idempotencyKey}`, runId); },
  };
}

function makeBudgetHarness({ pgMock, sessionUser, parseBodyFn, engineOverrides = {} } = {}) {
  const engineCalls = { create: 0, snapshot: 0 };
  const responses = [];
  const engine = {
    createRunFromCanvas: async (p) => { engineCalls.create += 1; return { ok: true, runId: 'run-created', status: 'QUEUED', idempotent: false, canvasRevision: p.requestedCanvasRevision }; },
    getRunSnapshot: async () => { engineCalls.snapshot += 1; return null; },
    ...engineOverrides,
  };
  const api = createStudioRunApi({
    pg: pgMock.pg,
    engine,
    sessionUser: sessionUser || (() => ({ id: 'u-1', role: 'editor' })),
    sendJSON: (res, code, body) => {
      responses.push({ code, body });
      if (res && !res.headersSent && typeof res.writeHead === 'function') {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      } else if (res) res.statusCode = code;
      if (res && typeof res.end === 'function') res.end(JSON.stringify(body));
    },
    parseBody: parseBodyFn || (async (req) => req._body || {}),
  });
  return { api, responses, engineCalls };
}

// 默认种子：p-1/w-1/u-1（owner），cv-1 rev2，prompt→image(model m-img cc=1)
function seedImageProject(m, { budget, spent, cc = 1 } = {}) {
  m.addProject('p-1', 'w-1');
  m.addMember('w-1', 'u-1');
  m.addCanvas('p-1', 'cv-1', 2);
  m.setNodes('cv-1', [genPromptRow('pa'), genImageRow('ga', 'm-img')]);
  m.setEdges('cv-1', [genEdge('e1', 'pa', 'ga')]);
  m.setModelPrice('m-img', cc);
  if (budget != null) m.setBudget('p-1', budget, spent || 0);
}

function createReq(body, query = {}) {
  const req = makeReq();
  req._body = body;
  req.query = query;
  return req;
}

test('V2.0: 有预算且估算超剩余 → POST create 409 BUDGET_INSUFFICIENT（不建 run，引擎不被调）', async () => {
  const m = createBudgetPgMock();
  seedImageProject(m, { budget: 10, spent: 9.5 }); // remaining 0.5 credit = 5000 units
  const { api, responses, engineCalls } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  const req = createReq({ runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'ik-over' });
  await api.handle(req, res, '/api/v2/projects/p-1/studio/runs', 'POST');
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(body.ok, false);
  assert.equal(body.error, 'BUDGET_INSUFFICIENT');
  assert.equal(body.estimateUnits, 10000); // m-img 1 credit = 1 任务
  assert.equal(body.remainingUnits, 5000);
  assert.equal(engineCalls.create, 0, 'run must NOT be created when the budget gate blocks');
});

test('V2.0: 有预算且余量足 → POST create 202（引擎创建成功）', async () => {
  const m = createBudgetPgMock();
  seedImageProject(m, { budget: 10, spent: 0 }); // remaining 10 credit = 100000 units ≥ 10000
  const { api, responses, engineCalls } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  const req = createReq({ runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'ik-ok' });
  await api.handle(req, res, '/api/v2/projects/p-1/studio/runs', 'POST');
  assert.equal(res.statusCode, 202, JSON.stringify(res.chunks.join('')));
  assert.equal(JSON.parse(res.chunks.join('')).ok, true);
  assert.equal(engineCalls.create, 1);
  assert.equal(responses[0].body.budgetGate, undefined, '成功响应不新增预算字段（保持原形状）');
});

test('V2.0: 无预算行 → 放行（NO_BUDGET 策略），引擎被调用 → 202', async () => {
  const m = createBudgetPgMock();
  seedImageProject(m); // 无 project_budgets 行
  const { api, engineCalls } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  const req = createReq({ runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'ik-nobudget' });
  await api.handle(req, res, '/api/v2/projects/p-1/studio/runs', 'POST');
  assert.equal(res.statusCode, 202, JSON.stringify(res.chunks.join('')));
  assert.equal(engineCalls.create, 1);
  // 门确实走过了预算读（策略行在 → 无行 → 放行），证明不是绕过了门
  assert.ok(m.countBy(/FROM project_budgets/) >= 1, 'budget gate must consult project_budgets');
});

test('V2.0: 幂等重放（同 canvas+key 已有 run）→ 预算不足也不拦，引擎回放 → 202', async () => {
  const m = createBudgetPgMock();
  seedImageProject(m, { budget: 10, spent: 9.9 }); // remaining 0.1 credit = 1000 units < 估算 10000
  m.addRun('cv-1', 'ik-replay', 'run-existing');
  const { api, engineCalls } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  const req = createReq({ runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'ik-replay' });
  await api.handle(req, res, '/api/v2/projects/p-1/studio/runs', 'POST');
  assert.equal(res.statusCode, 202, 'replay of an existing run is not a new spend — must not 409');
  assert.equal(engineCalls.create, 1);
});

test('V2.0: GET /runs/estimate 200 形状 — video+image 闭包、有预算、精确 units', async () => {
  const m = createBudgetPgMock();
  m.addProject('p-1', 'w-1');
  m.addMember('w-1', 'u-1');
  m.addCanvas('p-1', 'cv-1', 2);
  m.setNodes('cv-1', [genPromptRow('pb'), genVideoRow('gb', 'm-vid', 5), genPromptRow('pc'), genImageRow('gc', 'm-img')]);
  m.setEdges('cv-1', [genEdge('e2', 'pb', 'gb'), genEdge('e3', 'pc', 'gc')]);
  m.setModelPrice('m-vid', 2);  // video 每任务 2 credit → 20000 units
  m.setModelPrice('m-img', 1);  // image 每任务 1 credit → 10000 units
  m.setBudget('p-1', 100, 0);   // 100 credit = 1000000 units
  const { api } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  const req = createReq({ runMode: 'ALL' }); // canvasRevision 缺省 → 当前 revision
  await api.handle(req, res, '/api/v2/projects/p-1/studio/runs/estimate', 'GET');
  assert.equal(res.statusCode, 200, JSON.stringify(res.chunks.join('')));
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(body.ok, true);
  assert.equal(body.canvas.revision, 2);
  assert.equal(body.run.runMode, 'ALL');
  assert.equal(body.run.nodeCount, 4); // 2 prompt + video + image（可执行闭包）
  assert.equal(body.run.generationNodeCount, 2);
  assert.equal(body.estimate.shotCount, 2);
  assert.equal(body.estimate.totalUnits, 30000); // 20000 video + 10000 image
  assert.deepEqual(body.estimate.perKind, { video: 20000, image: 10000 });
  assert.equal(body.estimate.hasUnpriced, false);
  assert.equal(body.estimate.breakdown.length, 2);
  assert.equal(body.estimate.breakdown[0].shotId, 'gb');
  assert.equal(body.estimate.breakdown[0].kind, 'video');
  assert.equal(body.estimate.breakdown[0].model, 'm-vid');
  assert.equal(body.estimate.breakdown[0].seconds, 5);
  assert.equal(body.estimate.breakdown[0].units, 20000);
  assert.equal(body.estimate.breakdown[1].kind, 'image');
  assert.equal(body.estimate.breakdown[1].count, 1);
  assert.equal(body.estimate.breakdown[1].units, 10000);
  assert.equal(body.budget.exists, true);
  assert.equal(body.budget.policy, 'BUDGETED');
  assert.equal(body.budget.budgetUnits, 1000000);
  assert.equal(body.budget.spentUnits, 0);
  assert.equal(body.budget.remainingUnits, 1000000);
  assert.equal(body.budget.blocked, false);
});

test('V2.0: GET /runs/estimate — 缺价模型标 unpriced（按 L5 兜底 0），预算不足以拦截 → blocked=true', async () => {
  const m = createBudgetPgMock();
  m.addProject('p-1', 'w-1');
  m.addMember('w-1', 'u-1');
  m.addCanvas('p-1', 'cv-1', 2);
  m.setNodes('cv-1', [genPromptRow('pa'), genImageRow('ga', 'm-img'), genPromptRow('pd'), genImageRow('gd', 'm-ghost')]);
  m.setEdges('cv-1', [genEdge('e1', 'pa', 'ga'), genEdge('e4', 'pd', 'gd')]);
  m.setModelPrice('m-img', 1); // m-ghost 无 models 行 → unpriced → 0
  m.setBudget('p-1', 0.5, 0.2); // remaining 0.3 credit = 3000 units < 10000
  const { api } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  const req = createReq({ runMode: 'ALL', canvasRevision: 2 });
  await api.handle(req, res, '/api/v2/projects/p-1/studio/runs/estimate', 'GET');
  assert.equal(res.statusCode, 200, JSON.stringify(res.chunks.join('')));
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(body.estimate.totalUnits, 10000); // 只计有价项（ghost → 0）
  assert.equal(body.estimate.hasUnpriced, true);
  assert.deepEqual(body.estimate.unpricedModelIds, ['m-ghost']);
  assert.equal(body.estimate.breakdown[1].unpriced, true);
  assert.equal(body.estimate.breakdown[1].units, null);
  assert.equal(body.budget.exists, true);
  assert.equal(body.budget.remainingUnits, 3000);
  assert.equal(body.budget.blocked, true); // 10000 > 3000（与 create 门同判据）
});

test('V2.0: GET /runs/estimate — 无预算项目 → 200 budget.exists=false policy=NO_BUDGET', async () => {
  const m = createBudgetPgMock();
  seedImageProject(m); // 无预算行
  const { api } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  const req = createReq({ runMode: 'ALL', canvasRevision: 2 });
  await api.handle(req, res, '/api/v2/projects/p-1/studio/runs/estimate', 'GET');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(body.ok, true);
  assert.equal(body.budget.exists, false);
  assert.equal(body.budget.policy, 'NO_BUDGET');
  assert.equal(body.estimate.totalUnits, 10000);
  assert.equal(body.budget.blocked, undefined);
});

test('V2.0: GET /runs/estimate — stale revision → 409 CANVAS_REVISION_STALE（与 create 同判据）', async () => {
  const m = createBudgetPgMock();
  seedImageProject(m, { budget: 100 });
  const { api } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  const req = createReq({ runMode: 'ALL', canvasRevision: 1 }); // 当前是 2
  await api.handle(req, res, '/api/v2/projects/p-1/studio/runs/estimate', 'GET');
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(body.ok, false);
  assert.equal(body.error, 'CANVAS_REVISION_STALE');
  assert.equal(body.serverRevision, 2);
  assert.equal(body.requestedRevision, 1);
});

test('V2.0: GET /runs/estimate — 非法 runMode → 400 INVALID_RUN_MODE；缺鉴权 → 401', async () => {
  const m = createBudgetPgMock();
  seedImageProject(m, { budget: 100 });
  const { api } = makeBudgetHarness({ pgMock: m });
  const res = makeRes();
  await api.handle(createReq({ runMode: 'BOGUS' }), res, '/api/v2/projects/p-1/studio/runs/estimate', 'GET');
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.chunks.join('')).error, 'INVALID_RUN_MODE');

  const m2 = createBudgetPgMock();
  seedImageProject(m2, { budget: 100 });
  const { api: api2 } = makeBudgetHarness({ pgMock: m2, sessionUser: () => null });
  const res2 = makeRes();
  await api2.handle(createReq({ runMode: 'ALL' }), res2, '/api/v2/projects/p-1/studio/runs/estimate', 'GET');
  assert.equal(res2.statusCode, 401);
});
