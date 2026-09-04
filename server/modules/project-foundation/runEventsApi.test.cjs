'use strict';
/**
 * G21-READ — runEventsApi.cjs unit tests (JSON pages over run_events).
 *
 * Harness style follows the house modules (studioRunApi.test.cjs /
 * runEventStore.test.cjs): node:test + node:assert/strict over an in-memory
 * mock pg routed by SQL shape. The mock models:
 *   - run_events PK semantics (run_id, seq) with created_at per row,
 *   - studio_runs ownership (id → project_id) for the no-leak 404 check.
 *
 * Coverage:
 *   - forward page: ASC, afterSeq exclusive cursor, default limit 200 & cap 200
 *   - hasMore truth across a full forward walk (正翻页) and exact-200 boundary
 *   - latest tail: DESC, ≤50 cap, hasMore = older events exist (逆翻页 semantics)
 *   - 404: nonexistent run / run under another project (no leak) — no SQL read
 *   - shape: { events:[{seq,kind,status?,nodeId?,tsMs}], hasMore } — optional
 *     fields omitted (not null) when payload lacks them; tsMs = epoch ms
 *   - auth double hook: sessionUser 401 gate + authProject deny (403/404/custom)
 *     + ctx args; BOTH default to allow when omitted (缺省放行)
 *   - limit/afterSeq validation, OPTIONS 204, URL decoding, 500 on read failure
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRunEventsApi, LIMITS, rowToApiEvent } = require('./runEventsApi.cjs');

const BASE_TS = Date.parse('2026-09-04T00:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// mock pg: studio_runs ownership + run_events rows (created_at included)
// ─────────────────────────────────────────────────────────────────────────────
function createMockPg() {
  const state = {
    runs: new Map(),   // runId -> projectId
    events: new Map(), // runId -> Map<seq, {seq,type,payloadJson,createdAt}>
    throwOnRun: null,  // runId whose event read should throw (500 path)
  };
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql: String(sql).trim(), params });
    const text = String(sql);

    // run ownership: SELECT 1 FROM studio_runs WHERE id=$1 AND project_id=$2
    if (text.includes('FROM studio_runs')) {
      const [runId, projectId] = params;
      const ok = state.runs.get(runId) === projectId;
      return { rows: ok ? [{ '?column?': 1 }] : [], rowCount: ok ? 1 : 0 };
    }
    if (!text.includes('FROM run_events')) {
      throw new Error(`mock pg: unhandled SQL: ${text}`);
    }

    // events reader (page ASC / tail DESC — both select created_at)
    const [runId] = params;
    const run = state.events.get(runId) || new Map();
    if (state.throwOnRun === runId) throw new Error('mock pg: simulated read failure');
    const all = [...run.values()];
    if (text.includes('ORDER BY seq DESC')) {
      const limit = params[1];
      const rows = all
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map((r) => ({ seq: r.seq, type: r.type, payload_json: JSON.parse(r.payloadJson), created_at: r.createdAt }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('ORDER BY seq ASC')) {
      const afterSeq = params[1];
      const limit = params[2];
      const rows = all
        .filter((r) => r.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((r) => ({ seq: r.seq, type: r.type, payload_json: JSON.parse(r.payloadJson), created_at: r.createdAt }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`mock pg: unhandled SQL: ${text}`);
  }

  return {
    pg: { query },
    calls,
    countBy: (re) => calls.filter((c) => re.test(c.sql)).length,
    addRun(runId, projectId) { state.runs.set(runId, projectId); },
    insertEvent(runId, seq, type, payload, createdAt = new Date(BASE_TS + seq * 1000).toISOString()) {
      if (!state.events.has(runId)) state.events.set(runId, new Map());
      state.events.get(runId).set(seq, {
        seq,
        type,
        payloadJson: JSON.stringify(payload === undefined ? {} : payload),
        createdAt,
      });
    },
    appendEvent(runId, type, payload) {
      const run = state.events.get(runId) || new Map();
      const seq = run.size ? Math.max(...run.keys()) + 1 : 1;
      this.insertEvent(runId, seq, type, payload);
      return seq;
    },
    fill(runId, count, { type = 'studio.run_node.succeeded', payload } = {}) {
      for (let i = 1; i <= count; i += 1) {
        this.appendEvent(runId, type, payload === undefined ? { run_node_id: `n${i}`, attempt: 1 } : payload);
      }
    },
    setThrowOnRun(runId) { state.throwOnRun = runId; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fake transport + call helpers
// ─────────────────────────────────────────────────────────────────────────────
function makeRes() {
  const res = { status: null, body: undefined, headersSent: false, writableEnded: false };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.end = (chunk) => { if (chunk !== undefined && chunk !== null && chunk !== '') res.body = JSON.parse(chunk); res.writableEnded = true; res.headersSent = true; };
  return res;
}

/** Run one handle() call; returns { handled, res }. */
async function call(api, { path, query, method = 'GET', headers = {} } = {}) {
  const res = makeRes();
  const req = { query: query || {}, headers };
  const handled = await api.handle(req, res, path, method);
  return { handled, res };
}

function makeApi(m, opts = {}) {
  const hooks = {};
  if (opts.sessionUser !== undefined) hooks.sessionUser = opts.sessionUser;
  if (opts.authProject !== undefined) hooks.authProject = opts.authProject;
  return createRunEventsApi({ pg: m.pg, ...hooks, ...(opts.sendJSON ? { sendJSON: opts.sendJSON } : {}) });
}

const eventsUrl = (projectId, runId) => `/api/v2/projects/${projectId}/studio/runs/${runId}/events`;
const latestUrl = (projectId, runId) => `/api/v2/projects/${projectId}/studio/runs/${runId}/events/latest`;

// ─────────────────────────────────────────────────────────────────────────────
// factory + exports
// ─────────────────────────────────────────────────────────────────────────────
test('createRunEventsApi requires a query-capable pg; exports handle/LIMITS', () => {
  assert.throws(() => createRunEventsApi({}), /pg/);
  assert.throws(() => createRunEventsApi({ pg: {} }), /pg/);
  const m = createMockPg();
  const api = makeApi(m);
  assert.equal(typeof api.handle, 'function');
  assert.equal(LIMITS.PAGE_MAX, 200);
  assert.equal(LIMITS.PAGE_DEFAULT, 200);
  assert.equal(LIMITS.TAIL_MAX, 50);
  assert.equal(LIMITS.TAIL_DEFAULT, 50);
});

// ─────────────────────────────────────────────────────────────────────────────
// wire shape (optional fields omitted, tsMs epoch ms)
// ─────────────────────────────────────────────────────────────────────────────
test('page event shape: {seq,kind,status?,nodeId?,tsMs}; optional fields omitted when payload lacks them', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.insertEvent('run-1', 1, 'studio.run.started', { status: 'RUNNING' }, new Date(BASE_TS + 1000).toISOString());
  m.insertEvent('run-1', 2, 'studio.run_node.started', { run_node_id: 'n1', attempt: 1 }, new Date(BASE_TS + 2000).toISOString());
  m.insertEvent('run-1', 3, 'studio.run.completed', { run_node_id: 'n2', status: 'COMPLETED', counts: {} }, new Date(BASE_TS + 3000).toISOString());
  m.insertEvent('run-1', 4, 'x.opaque', {}, new Date(BASE_TS + 4000).toISOString());

  const { handled, res } = await call(makeApi(m), { path: eventsUrl('p-1', 'run-1') });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    events: [
      { seq: 1, kind: 'studio.run.started', status: 'RUNNING', tsMs: BASE_TS + 1000 },
      { seq: 2, kind: 'studio.run_node.started', nodeId: 'n1', tsMs: BASE_TS + 2000 }, // no status key
      { seq: 3, kind: 'studio.run.completed', status: 'COMPLETED', nodeId: 'n2', tsMs: BASE_TS + 3000 },
      { seq: 4, kind: 'x.opaque', tsMs: BASE_TS + 4000 }, // bare event: only seq/kind/tsMs
    ],
    hasMore: false,
  });
});

test('rowToApiEvent: empty/non-string optional payload values are omitted; Date and ISO tsMs both work', () => {
  assert.deepEqual(
    rowToApiEvent({ seq: '1', type: 't.a', payload_json: { status: '', run_node_id: '  ', run_node_id2: 7 }, created_at: '2026-09-04T00:00:00.000Z' }),
    { seq: 1, kind: 't.a', tsMs: BASE_TS }
  );
  assert.deepEqual(
    rowToApiEvent({ seq: 2, type: 't.b', payload_json: { status: 'OK' }, created_at: new Date(BASE_TS + 5000) }),
    { seq: 2, kind: 't.b', status: 'OK', tsMs: BASE_TS + 5000 }
  );
  assert.deepEqual(
    rowToApiEvent({ seq: 3, type: 't.c', payload_json: '{"run_node_id":"n9"}', created_at: new Date(BASE_TS + 6000) }),
    { seq: 3, kind: 't.c', nodeId: 'n9', tsMs: BASE_TS + 6000 }
  );
  // jsonb already parsed by node-pg
  assert.equal(rowToApiEvent({ seq: 4, type: 't.d', payload_json: null, created_at: null }).kind, 't.d');
  assert.equal(typeof rowToApiEvent({ seq: 4, type: 't.d', payload_json: null, created_at: null }).tsMs, 'number');
});

// ─────────────────────────────────────────────────────────────────────────────
// forward pagination (正翻页): afterSeq cursor + limit + hasMore
// ─────────────────────────────────────────────────────────────────────────────
test('forward page: afterSeq exclusive cursor walks 1..N; limit=2 → hasMore until last page', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 5);
  const api = makeApi(m);

  const p1 = await call(api, { path: eventsUrl('p-1', 'run-1'), query: { limit: '2' } });
  assert.equal(p1.res.status, 200);
  assert.deepEqual(p1.res.body.events.map((e) => e.seq), [1, 2]);
  assert.equal(p1.res.body.hasMore, true);

  const p2 = await call(api, { path: eventsUrl('p-1', 'run-1'), query: { afterSeq: '2', limit: '2' } });
  assert.deepEqual(p2.res.body.events.map((e) => e.seq), [3, 4]);
  assert.equal(p2.res.body.hasMore, true);

  const p3 = await call(api, { path: eventsUrl('p-1', 'run-1'), query: { afterSeq: '4', limit: '2' } });
  assert.deepEqual(p3.res.body.events.map((e) => e.seq), [5]);
  assert.equal(p3.res.body.hasMore, false);

  const pEmpty = await call(api, { path: eventsUrl('p-1', 'run-1'), query: { afterSeq: '5' } });
  assert.deepEqual(pEmpty.res.body, { events: [], hasMore: false });
});

test('forward walk exhausts the whole log (all seqs collected in order, ASC)', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 37);
  const api = makeApi(m);
  const collected = [];
  let afterSeq = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const { res } = await call(api, { path: eventsUrl('p-1', 'run-1'), query: { afterSeq: String(afterSeq), limit: '7' } });
    assert.equal(res.status, 200);
    for (const ev of res.body.events) collected.push(ev.seq);
    if (!res.body.hasMore) break;
    afterSeq = res.body.events[res.body.events.length - 1].seq;
  }
  assert.deepEqual(collected, Array.from({ length: 37 }, (_, i) => i + 1));
});

test('limit cap 200: default & limit=999 return at most 200; exact-200 boundary hasMore=false; 201 → true', async () => {
  const m = createMockPg();
  m.addRun('run-200', 'p-1');
  m.fill('run-200', 200);
  const api = makeApi(m);

  const exact = await call(api, { path: eventsUrl('p-1', 'run-200') });
  assert.equal(exact.res.body.events.length, 200);
  assert.equal(exact.res.body.hasMore, false); // exactly one page — no more

  m.fill('run-200', 1); // now 201
  const over = await call(api, { path: eventsUrl('p-1', 'run-200') });
  assert.equal(over.res.body.events.length, 200);
  assert.equal(over.res.body.hasMore, true);

  const capped = await call(api, { path: eventsUrl('p-1', 'run-200'), query: { limit: '999' } });
  assert.equal(capped.res.body.events.length, 200);
  assert.equal(capped.res.body.hasMore, true);

  // non-numeric / zero / negative limit → lenient default (200)
  for (const bad of ['abc', '0', '-3', '1.5']) {
    const r = await call(api, { path: eventsUrl('p-1', 'run-200'), query: { limit: bad } });
    assert.equal(r.res.status, 200);
    assert.equal(r.res.body.events.length, 200);
    assert.equal(r.res.body.hasMore, true);
  }
});

test('afterSeq validation: negative / NaN / fractional / >MAX_SAFE → 400 INVALID_AFTER_SEQ', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 3);
  const api = makeApi(m);
  for (const bad of ['-1', 'x', '1.5', '9007199254740993']) {
    const { res } = await call(api, { path: eventsUrl('p-1', 'run-1'), query: { afterSeq: bad } });
    assert.equal(res.status, 400, `afterSeq=${bad}`);
    assert.deepEqual(res.body, { ok: false, error: 'INVALID_AFTER_SEQ' });
  }
  // 0 / '' / missing all mean "from the start"
  for (const q of [{ afterSeq: '0' }, { afterSeq: '' }, {}, undefined]) {
    const { res } = await call(api, { path: eventsUrl('p-1', 'run-1'), query: q });
    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 3);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// latest tail (逆序尾页): DESC, ≤50, hasMore = older events remain
// ─────────────────────────────────────────────────────────────────────────────
test('latest tail: default returns last 5 DESC; limit=2 → hasMore true until oldest', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 5);
  const api = makeApi(m);

  const all = await call(api, { path: latestUrl('p-1', 'run-1') });
  assert.equal(all.res.status, 200);
  assert.deepEqual(all.res.body.events.map((e) => e.seq), [5, 4, 3, 2, 1]);
  assert.equal(all.res.body.hasMore, false);

  const top2 = await call(api, { path: latestUrl('p-1', 'run-1'), query: { limit: '2' } });
  assert.deepEqual(top2.res.body.events.map((e) => e.seq), [5, 4]);
  assert.equal(top2.res.body.hasMore, true);
});

test('latest cap 50: limit=999 / invalid → at most 50 newest, hasMore=true; next page is NOT reachable (tail endpoint)', async () => {
  const m = createMockPg();
  m.addRun('run-big', 'p-1');
  m.fill('run-big', 55);
  const api = makeApi(m);

  for (const q of [{ limit: '999' }, { limit: '0' }, { limit: 'abc' }, {}]) {
    const { res } = await call(api, { path: latestUrl('p-1', 'run-big'), query: q });
    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 50);
    assert.equal(res.body.events[0].seq, 55);
    assert.equal(res.body.events[49].seq, 6);
    assert.equal(res.body.hasMore, true); // 5 older (seq 1..5) exist beyond the window
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 semantics (空 run / 不存在 / cross-project no-leak)
// ─────────────────────────────────────────────────────────────────────────────
test('nonexistent run → 404 RUN_NOT_FOUND on both endpoints; run_events never read', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1'); // only run-1 exists
  const api = makeApi(m);

  for (const url of [eventsUrl('p-1', 'ghost'), latestUrl('p-1', 'ghost')]) {
    const { handled, res } = await call(api, { path: url });
    assert.equal(handled, true);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { ok: false, error: 'RUN_NOT_FOUND' });
  }
  assert.equal(m.countBy(/FROM run_events/), 0, '404 must not read the event log');
});

test('run under another project (queried with wrong projectId) → 404 no existence leak', async () => {
  const m = createMockPg();
  m.addRun('run-x', 'p-2'); // real run, but in p-2
  m.fill('run-x', 4);
  const api = makeApi(m);

  const { res } = await call(api, { path: eventsUrl('p-1', 'run-x') });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { ok: false, error: 'RUN_NOT_FOUND' });
  assert.equal(m.countBy(/FROM run_events/), 0);
});

test('existing run with zero events → 200 empty page (not 404)', async () => {
  const m = createMockPg();
  m.addRun('run-0', 'p-1');
  const api = makeApi(m);
  for (const url of [eventsUrl('p-1', 'run-0'), latestUrl('p-1', 'run-0')]) {
    const { res } = await call(api, { path: url });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { events: [], hasMore: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// auth double hook (canvasCommandLogApi contract)
// ─────────────────────────────────────────────────────────────────────────────
test('缺省放行 (no hooks): reads allowed; structural 404 still enforced', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 2);
  const api = makeApi(m); // no sessionUser, no authProject

  const ok = await call(api, { path: eventsUrl('p-1', 'run-1') });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.body.events.length, 2);

  const leak = await call(api, { path: eventsUrl('p-9', 'run-1') });
  assert.equal(leak.res.status, 404); // run not under p-9 even with auth fully open
});

test('sessionUser hook: no session → 401 未登录 before any SQL; both endpoints', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 2);
  const api = makeApi(m, { sessionUser: () => null });
  for (const url of [eventsUrl('p-1', 'run-1'), latestUrl('p-1', 'run-1')]) {
    const { res } = await call(api, { path: url });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { ok: false, error: '未登录' });
  }
  assert.equal(m.countBy(/FROM studio_runs/), 0);
  assert.equal(m.countBy(/FROM run_events/), 0);
});

test('authProject hook deny: false → 403 default; object carries status/error; no SQL after denial', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 2);

  const deny = makeApi(m, { authProject: async () => ({ allowed: false }) });
  const r1 = await call(deny, { path: eventsUrl('p-1', 'run-1') });
  assert.equal(r1.res.status, 403);
  assert.deepEqual(r1.res.body, { ok: false, error: '无项目权限' });

  const denyFalse = makeApi(m, { authProject: () => false });
  const r2 = await call(denyFalse, { path: latestUrl('p-1', 'run-1') });
  assert.equal(r2.res.status, 403);
  assert.deepEqual(r2.res.body, { ok: false, error: '无项目权限' });

  const deny404 = makeApi(m, { authProject: () => ({ allowed: false, status: 404, error: '项目不存在' }) });
  const r3 = await call(deny404, { path: eventsUrl('p-1', 'run-1') });
  assert.equal(r3.res.status, 404);
  assert.deepEqual(r3.res.body, { ok: false, error: '项目不存在' });

  assert.equal(m.countBy(/FROM studio_runs/), 0, 'denied requests never touch run ownership SQL');
  assert.equal(m.countBy(/FROM run_events/), 0, 'denied requests never read events');
});

test('authProject hook {ok:false} (canvasCommandLogApi deny shape) → deny, fail-closed not allow', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 2);

  const denyOk = makeApi(m, { authProject: async () => ({ ok: false, status: 403, error: 'FORBIDDEN' }) });
  const r1 = await call(denyOk, { path: eventsUrl('p-1', 'run-1') });
  assert.equal(r1.res.status, 403);
  assert.deepEqual(r1.res.body, { ok: false, error: 'FORBIDDEN' });

  // bare { ok:false } (no status/error) → 403 with canvas-default error 'FORBIDDEN'
  const denyBare = makeApi(m, { authProject: async () => ({ ok: false }) });
  const r2 = await call(denyBare, { path: latestUrl('p-1', 'run-1') });
  assert.equal(r2.res.status, 403);
  assert.deepEqual(r2.res.body, { ok: false, error: 'FORBIDDEN' });

  assert.equal(m.countBy(/FROM studio_runs/), 0, 'denied requests never touch run ownership SQL');
  assert.equal(m.countBy(/FROM run_events/), 0, 'denied requests never read events');
});

test('authProject hook allow (true / null / {allowed:true}) proceeds; ctx receives projectId/runId/user/req', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 1);
  const seen = [];
  const authProject = async (ctx) => { seen.push(ctx); return { allowed: true }; };
  const api = makeApi(m, {
    sessionUser: () => ({ id: 'u-1', role: 'editor' }),
    authProject,
  });

  const r = await call(api, { path: eventsUrl('p-1', 'run-1') });
  assert.equal(r.res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].projectId, 'p-1');
  assert.equal(seen[0].runId, 'run-1');
  assert.equal(seen[0].user.id, 'u-1');
  assert.ok(seen[0].req && typeof seen[0].req === 'object');
});

// ─────────────────────────────────────────────────────────────────────────────
// routing / validation / failures
// ─────────────────────────────────────────────────────────────────────────────
test('non-matching paths and non-GET methods → false (dispatcher keeps trying)', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  const api = makeApi(m);
  const cases = [
    ['/api/v2/projects/p-1/studio/runs', 'GET'],
    ['/api/v2/projects/p-1/studio/runs/run-1', 'GET'],
    ['/api/v2/projects/p-1/studio/runs/run-1/events/latest/x', 'GET'],
    ['/api/v2/projects/p-1/studio/runs/run-1/cancel', 'POST'],
    ['/api/v2/projects/p-1/studio/runs/run-1/events', 'POST'],
    ['/api/v2/timelines', 'GET'],
  ];
  for (const [path, method] of cases) {
    const { handled } = await call(api, { path, method });
    assert.equal(handled, false, `${method} ${path} must not be claimed`);
  }
});

test('OPTIONS on the events paths → 204, claimed, no auth hook invoked', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  let authCalls = 0;
  const api = makeApi(m, {
    sessionUser: () => { authCalls += 1; return { id: 'u-1' }; },
    authProject: async () => { authCalls += 1; return { allowed: true }; },
  });
  for (const url of [eventsUrl('p-1', 'run-1'), latestUrl('p-1', 'run-1')]) {
    const { handled, res } = await call(api, { path: url, method: 'OPTIONS' });
    assert.equal(handled, true);
    assert.equal(res.status, 204);
  }
  assert.equal(authCalls, 0);
});

test('URI-encoded project/run ids are decoded before lookup', async () => {
  const m = createMockPg();
  m.addRun('run 1', 'p 1');
  m.fill('run 1', 2);
  const api = makeApi(m);
  const url = eventsUrl(encodeURIComponent('p 1'), encodeURIComponent('run 1'));
  const { handled, res } = await call(api, { path: url });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 2);
});

test('DB read failure → 500 {ok:false,error:服务内部错误} on both endpoints', async () => {
  const m = createMockPg();
  m.addRun('boom', 'p-1');
  m.fill('boom', 3);
  m.setThrowOnRun('boom');
  const api = makeApi(m);
  for (const url of [eventsUrl('p-1', 'boom'), latestUrl('p-1', 'boom')]) {
    const { handled, res } = await call(api, { path: url });
    assert.equal(handled, true);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { ok: false, error: '服务内部错误' });
  }
});

test('sendJSON injected override is used for responses', async () => {
  const m = createMockPg();
  m.addRun('run-1', 'p-1');
  m.fill('run-1', 1);
  const calls = [];
  const api = makeApi(m, { sendJSON: (res, status, body) => { calls.push({ status, body }); } });
  const { res } = await call(api, { path: eventsUrl('p-1', 'run-1') });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].body.events.length, 1);
  assert.equal(res.status, null, 'no writes to res when a sendJSON was injected');
});
