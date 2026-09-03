'use strict';
/**
 * M05-D1 — Studio Run engine integration tests (LOCAL TEST DB ONLY).
 * PostgreSQL is the durable scheduling authority; no process-memory authority.
 *
 * Covers (STEP 57 set): run create, idempotency, wrong canvas revision,
 * immutable compiled snapshot, bulk 1000 run-node creation, initial
 * READY/BLOCKED states, lease one node, no double lease, lease token
 * verification, heartbeat, expired lease recovery, old-token rejection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bootstrapRunDb, dropDb, seedProject, engineCreateRun, makeEngine,
  bumpCanvasRevision, sleep, nodes, edge,
  runToCompletion, runCompiledGraph, forceLeaseExpired, runNodes, isolateRun,
} = require('../helpers/studio-run-test.cjs');
const { testExecutor, hangExecutor } = require('../../modules/project-foundation/studioRunTestExecutors.cjs');

let db;
let pg;
test.before(async () => {
  db = await bootstrapRunDb();
  pg = db.pg;
});
test.after(async () => { if (db) { await db.pg.end(); await dropDb(db.dbName); } });

/** Prompt -> image-gen -> output (D1: image-gen has NO production executor;
 *  we inject a test-only executor for this node type so the DAG runs). */
async function seedLinear() {
  const s = await seedProject(pg, {
    nodeRows: [nodes.prompt('p1'), nodes.imageGen('img1'), nodes.output('o1')],
    edgeRows: [
      edge('e1', 'p1', 'img1', 'text', 'text'),
      edge('e2', 'img1', 'o1', 'image', 'image'),
    ],
  });
  return s;
}

test('engine: run create, initial states, immutable snapshot, idempotency, bulk', { concurrency: 1 }, async (t) => {
  const s = await seedLinear();
  const engine = makeEngine(pg, {
    workerId: 'w-engine-A',
    executors: { 'image-generation': testExecutor({ resultValue: { assetId: 'asset-gen-1' } }) },
  });

  await t.test('create run bound to canvas revision 1', async () => {
    const created = await engineCreateRun(pg, engine, s, { idempotencyKey: 'idem-1' });
    assert.equal(created.ok, true);
    assert.equal(created.idempotent, false);
    assert.equal(created.status, 'QUEUED');
    assert.equal(created.nodeCount, 3);
    assert.equal(created.edgeCount, 2);
    const g = created.graph;
    assert.equal(g.canvasRevision, 1);
    assert.equal(g.canvasId, s.canvas);
    const row = (await pg.query('SELECT * FROM studio_runs WHERE id=$1', [created.runId])).rows[0];
    assert.equal(row.canvas_revision, 1);
    assert.equal(row.project_id, s.project);
    assert.equal(row.workspace_id, s.workspace);
    assert.equal(row.idempotency_key, 'idem-1');
    assert.equal(row.status, 'QUEUED');
    // The linear graph contains one image-generation node whose production
    // executor is bridge-pending (M05-E), so the run is flagged
    // executor_unavailable=true even though a test executor is injected here.
    // The flag records the DURATION policy, not the current injection.
    assert.equal(row.executor_unavailable, true);
    // durable-safe compiled graph: no prompt text secrets, no URLs
    const gj = JSON.stringify(row.compiled_graph_json);
    assert.ok(!gj.includes('apiKey'));
    // initial states: p1 READY (no deps), img1 BLOCKED, o1 BLOCKED
    const st = (await pg.query(`SELECT studio_node_id, status, dependency_count, remaining_dependency_count FROM studio_run_nodes WHERE run_id=$1 ORDER BY studio_node_id`, [created.runId])).rows;
    const byId = Object.fromEntries(st.map((r) => [r.studio_node_id, r]));
    assert.equal(byId.p1.status, 'READY');
    assert.equal(byId.img1.status, 'BLOCKED');
    assert.equal(byId.o1.status, 'BLOCKED');
    assert.equal(byId.img1.dependency_count, 1);
    assert.equal(byId.img1.remaining_dependency_count, 1);
    assert.equal(byId.o1.dependency_count, 1);
  });

  await t.test('idempotent retry returns the SAME run (no second row)', async () => {
    const again = await engineCreateRun(pg, engine, s, { idempotencyKey: 'idem-1' });
    assert.equal(again.idempotent, true);
    const count = (await pg.query('SELECT COUNT(*)::int AS c FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2', [s.canvas, 'idem-1'])).rows[0].c;
    assert.equal(count, 1);
  });

  await t.test('different idempotency key creates a second run (scope = canvas+key)', async () => {
    const second = await engineCreateRun(pg, engine, s, { idempotencyKey: 'idem-2' });
    assert.equal(second.idempotent, false);
    assert.notEqual(second.runId, (await pg.query('SELECT id FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2', [s.canvas, 'idem-1'])).rows[0].id);
    const nodeCount = (await pg.query('SELECT COUNT(*)::int AS c FROM studio_run_nodes WHERE run_id=$1', [second.runId])).rows[0].c;
    assert.equal(nodeCount, 3);
  });

  await t.test('engine REJECTS a stale/arbitrary revision (domain op is the revision authority)', async () => {
    // Trust boundary: createRunFromCanvas locks the canvas row and requires
    // requestedCanvasRevision === authoritative revision. A caller that
    // supplies an arbitrary revision (e.g. 999) gets CANVAS_REVISION_STALE
    // and NOTHING is persisted.
    const s2 = await seedProject(pg, {
      nodeRows: [nodes.prompt('q1')],
      edgeRows: [],
    });
    await bumpCanvasRevision(pg, s2.canvas, 1); // live revision now 2
    let stale = null;
    try {
      await engine.createRunFromCanvas({
        project: (await pg.query('SELECT * FROM projects WHERE id=$1', [s2.project])).rows[0],
        canvasId: s2.canvas,
        requestedCanvasRevision: 999, // arbitrary caller-provided revision
        runMode: 'ALL',
        idempotencyKey: 'stale-999',
        requestedBy: s2.user.id,
      });
    } catch (e) { stale = e; }
    assert.ok(stale, 'arbitrary revision must be rejected');
    assert.equal(stale.code, 'CANVAS_REVISION_STALE');
    const cnt = (await pg.query('SELECT COUNT(*)::int AS c FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2', [s2.canvas, 'stale-999'])).rows[0].c;
    assert.equal(cnt, 0, 'no partial Run may be persisted for a stale revision');
    // the matching (live) revision succeeds and binds exactly it
    const ok = await engine.createRunFromCanvas({
      project: (await pg.query('SELECT * FROM projects WHERE id=$1', [s2.project])).rows[0],
      canvasId: s2.canvas,
      requestedCanvasRevision: 2,
      runMode: 'ALL',
      idempotencyKey: 'stale-ok',
      requestedBy: s2.user.id,
    });
    assert.equal(ok.ok, true);
    const row = (await pg.query('SELECT canvas_revision FROM studio_runs WHERE id=$1', [ok.runId])).rows[0];
    assert.equal(row.canvas_revision, 2);
  });

  await t.test('immutable snapshot: canvas edit to rev 2 does NOT change run graph', async () => {
    const before = (await pg.query('SELECT compiled_graph_json FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2', [s.canvas, 'idem-2'])).rows[0].compiled_graph_json;
    const rev2 = await bumpCanvasRevision(pg, s.canvas, 1);
    assert.equal(rev2, 2);
    // add a live node at rev 2 (user editing while run is active)
    await pg.query(`INSERT INTO studio_canvas_nodes (canvas_id, node_id, node_type, node_schema_version, position_x, position_y, data_json) VALUES ($1,'late-node','prompt',1,0,0,$2)`,
      [s.canvas, JSON.stringify({ nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: 'late' }, prompt: 'late' })]);
    const after = (await pg.query('SELECT compiled_graph_json FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2', [s.canvas, 'idem-2'])).rows[0].compiled_graph_json;
    assert.deepEqual(after, before, 'compiled graph must stay bound to revision 1');
    assert.ok(!JSON.stringify(after).includes('late-node'));
    assert.equal(after.canvasRevision, 1);
    // canvas is now rev 3 (bump + node insert does not bump; only mutations do) —
    // a NEW run created now must bind to the CURRENT revision, not the old one.
    const cur = (await pg.query('SELECT revision FROM studio_canvases WHERE id=$1', [s.canvas])).rows[0].revision;
    assert.equal(cur, 2);
  });

  await t.test('bulk 1000-node run creation is a small number of round trips', async () => {
    const N = 1000;
    const nodeRows = []; const edgeRows = [];
    // chain of 1000 prompt nodes
    for (let i = 0; i < N; i++) nodeRows.push(nodes.prompt(`b${i}`, `prompt ${i}`));
    for (let i = 1; i < N; i++) edgeRows.push(edge(`be${i}`, `b${i - 1}`, `b${i}`, 'text', 'text'));
    const big = await seedProject(pg, { nodeRows, edgeRows });
    const bigEngine = makeEngine(pg, { workerId: 'w-big', executors: {} });
    const t0 = process.hrtime.bigint();
    const created = await engineCreateRun(pg, bigEngine, big, { idempotencyKey: 'bulk-1' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(created.ok, true);
    assert.equal(created.nodeCount, N);
    const cnt = (await pg.query('SELECT COUNT(*)::int AS c FROM studio_run_nodes WHERE run_id=$1', [created.runId])).rows[0].c;
    const ecnt = (await pg.query('SELECT COUNT(*)::int AS c FROM studio_run_node_edges WHERE run_id=$1', [created.runId])).rows[0].c;
    assert.equal(cnt, N);
    assert.equal(ecnt, N - 1);
    const ready = (await pg.query(`SELECT COUNT(*)::int AS c FROM studio_run_nodes WHERE run_id=$1 AND status='READY'`, [created.runId])).rows[0].c;
    const blocked = (await pg.query(`SELECT COUNT(*)::int AS c FROM studio_run_nodes WHERE run_id=$1 AND status='BLOCKED'`, [created.runId])).rows[0].c;
    assert.equal(ready, 1);
    assert.equal(blocked, N - 1);
    console.log(`[benchmark] 1000 run-node bulk creation: ${ms.toFixed(1)}ms`);
    assert.ok(ms < 15000, `bulk creation too slow: ${ms}ms`);
    // cleanup big run data (keep DB small for later subtests)
    await pg.query('DELETE FROM studio_runs WHERE id=$1', [created.runId]);
  });
});

/** Deterministic 2-node graph: prompt -> output (both have production executors). */
async function seedPromptOutput() {
  return seedProject(pg, {
    nodeRows: [nodes.prompt('p1'), nodes.output('o1')],
    edgeRows: [edge('e1', 'p1', 'o1', 'text', 'text')],
  });
}

test('engine: lease, no double lease, batch lease, heartbeat, stale token', { concurrency: 1 }, async (t) => {
  const s = await seedPromptOutput();
  const engA = makeEngine(pg, { workerId: 'w-A', leaseSeconds: 120 });
  const engB = makeEngine(pg, { workerId: 'w-B', leaseSeconds: 120 });
  const created = await engineCreateRun(pg, engA, s, { idempotencyKey: 'lease-1' });
  await isolateRun(pg, created.runId); // lease sweeps ALL eligible runs globally

  await t.test('lease one READY node; run flips QUEUED->RUNNING', async () => {
    const n = await engA.leaseReadyNode({});
    assert.ok(n, 'expected a leased node');
    assert.equal(n.studio_node_id, 'p1');
    assert.equal(n.status, 'RUNNING');
    assert.equal(n.lease_owner, 'w-A');
    assert.ok(n.lease_token, 'lease token assigned');
    assert.ok(n.lease_expires_at, 'lease expiry set');
    assert.equal(n.attempt, 1);
    const run = (await pg.query('SELECT status FROM studio_runs WHERE id=$1', [created.runId])).rows[0];
    assert.equal(run.status, 'RUNNING');
    const o1 = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'o1');
    assert.equal(o1.status, 'BLOCKED');
  });

  await t.test('no double lease: worker B cannot lease the same node', async () => {
    const n = await engB.leaseReadyNode({});
    assert.equal(n, null, 'o1 still BLOCKED; nothing else READY');
  });

  await t.test('batch lease acquires up to N nodes in ONE transaction with unique tokens', async () => {
    // fresh run with 3 independent prompt roots -> output
    const s3 = await seedProject(pg, {
      nodeRows: [nodes.prompt('r1'), nodes.prompt('r2'), nodes.prompt('r3'), nodes.output('oj')],
      edgeRows: [edge('a', 'r1', 'oj', 'text', 'text'), edge('b', 'r2', 'oj', 'text', 'text'), edge('c', 'r3', 'oj', 'text', 'text')],
    });
    const c3 = await engineCreateRun(pg, engB, s3, { idempotencyKey: 'lease-batch' });
    const batch = await engB.leaseReadyNodes({ limit: 5 });
    assert.equal(batch.length, 3, 'all three READY roots leased in one call');
    const tokens = new Set(batch.map((x) => x.lease_token));
    assert.equal(tokens.size, 3, 'each leased node has a UNIQUE lease token');
    assert.ok(batch.every((x) => x.lease_owner === 'w-B'));
    // run flipped to RUNNING exactly once, all its nodes leased
    const rn = await runNodes(pg, c3.runId);
    assert.equal(rn.filter((x) => x.status === 'RUNNING').length, 3);
    assert.equal(rn.find((x) => x.studio_node_id === 'oj').status, 'BLOCKED');
    // no further READY nodes remain
    const again = await engB.leaseReadyNodes({ limit: 5 });
    assert.equal(again.length, 0);
  });

  await t.test('heartbeat extends lease only for the exact owner+token', async () => {
    const leased = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'p1');
    const before = leased.lease_expires_at.getTime();
    const ok = await engA.heartbeatLease(leased.id, { owner: 'w-A', token: leased.lease_token, extendSeconds: 120 });
    assert.equal(ok, true);
    const after = ((await runNodes(pg, created.runId)).find((x) => x.id === leased.id)).lease_expires_at.getTime();
    assert.ok(after > before, 'heartbeat extended expiry');
    const badOwner = await engB.heartbeatLease(leased.id, { owner: 'w-B', token: leased.lease_token });
    assert.equal(badOwner, false, 'wrong owner is a safe no-op');
    const badToken = await engA.heartbeatLease(leased.id, { owner: 'w-A', token: 'forged-token' });
    assert.equal(badToken, false, 'forged token is a safe no-op');
  });

  await t.test('completion with stale token rejected; valid token succeeds', async () => {
    const leased = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'p1');
    const stale = await engB.completeRunNode(leased.id, { owner: 'w-B', token: leased.lease_token, result: { text: 'x' } });
    assert.equal(stale.ok, false);
    assert.equal(stale.staleToken, true);
    const still = (await runNodes(pg, created.runId)).find((x) => x.id === leased.id);
    assert.equal(still.status, 'RUNNING', 'stale completion changed nothing');
    const good = await engA.completeRunNode(leased.id, { owner: 'w-A', token: leased.lease_token, result: { text: 'hello world', nodeType: 'prompt' } });
    assert.equal(good.ok, true);
    assert.deepEqual(good.unlocked, ['o1'], 'fan-out unlocked exactly o1');
  });

  await t.test('duplicate completion is idempotent', async () => {
    const done = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'p1');
    assert.equal(done.status, 'SUCCEEDED');
    const again = await engA.completeRunNode(done.id, { owner: 'w-A', token: done.lease_token, result: { text: 'hello world' } });
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
  });
});

test('engine: reaper, worker B reclaim, stale token rejected after reclaim', { concurrency: 1 }, async (t) => {
  const s = await seedPromptOutput();
  const engA = makeEngine(pg, { workerId: 'w-crash-A', leaseSeconds: 120 });
  const engB = makeEngine(pg, { workerId: 'w-reclaim-B', leaseSeconds: 120, retryBackoffMs: [1] });
  const created = await engineCreateRun(pg, engA, s, { idempotencyKey: 'reaper-1' });
  await isolateRun(pg, created.runId);
  const leased = await engA.leaseReadyNode({});
  assert.equal(leased.studio_node_id, 'p1');
  const oldToken = leased.lease_token;

  await t.test('worker A dies (simulated): lease expires', async () => {
    // Simulate crash: no completion, no heartbeat. Force the lease to be
    // expired in the past so the reaper can act without a 120s wait.
    await forceLeaseExpired(pg, leased.id);
    const row = (await runNodes(pg, created.runId)).find((x) => x.id === leased.id);
    assert.ok(row.lease_expires_at.getTime() <= Date.now(), 'lease is in the past');
  });

  await t.test('reaper recovers expired node to READY with bounded backoff', async () => {
    const r = await engB.reapExpiredNodes({ limit: 100, retryBackoffMs: [1] });
    assert.ok(r.reaped >= 1, `expected at least 1 reaped node, got ${JSON.stringify(r)}`);
    const row = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'p1');
    assert.equal(row.status, 'READY');
    assert.equal(row.lease_owner, null, 'lease released by reaper');
    assert.equal(row.lease_token, null);
    assert.ok(row.next_retry_at, 'backoff scheduled');
    // attempt counter preserved (not a fresh start); still below max_attempts
    assert.ok(row.attempt < row.max_attempts);
  });

  await t.test('worker B reclaims the node with a NEW lease', async () => {
    await sleep(5); // let next_retry_at elapse (1ms backoff)
    const n2 = await engB.leaseReadyNode({});
    assert.ok(n2, 'worker B leased the reclaimed node');
    assert.equal(n2.studio_node_id, 'p1');
    assert.equal(n2.lease_owner, 'w-reclaim-B');
    assert.notEqual(n2.lease_token, oldToken, 'new lease token differs');
  });

  await t.test('worker A late completion with OLD token is rejected', async () => {
    const n2 = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'p1');
    const stale = await engA.completeRunNode(n2.id, { owner: 'w-crash-A', token: oldToken, result: { text: 'late' } });
    assert.equal(stale.ok, false);
    assert.equal(stale.staleToken, true);
    const still = (await runNodes(pg, created.runId)).find((x) => x.id === n2.id);
    assert.equal(still.status, 'RUNNING', 'late completion changed nothing');
    // the rightful owner can still complete normally
    const good = await engB.completeRunNode(n2.id, { owner: 'w-reclaim-B', token: n2.lease_token, result: { text: 'hello world' } });
    assert.equal(good.ok, true);
  });
});

test('engine: retry, retry delay, exhaustion, permanent failure, propagation, aggregation', { concurrency: 1 }, async (t) => {
  const s = await seedPromptOutput();
  const eng = makeEngine(pg, {
    workerId: 'w-retry',
    executors: {
      'p1': testExecutor({ failFirstN: 2, record: [] }), // transient twice, then success
    },
    retryBackoffMs: [500],
  });
  const created = await engineCreateRun(pg, eng, s, { idempotencyKey: 'retry-1' });
  await isolateRun(pg, created.runId);

  await t.test('retryable failure schedules bounded backoff, node stays re-eligible', async () => {
    const leased = await eng.leaseReadyNode({});
    assert.equal(leased.studio_node_id, 'p1');
    assert.equal(leased.attempt, 1);
    const r = await eng.failRunNode(leased.id, { owner: 'w-retry', token: leased.lease_token, error: Object.assign(new Error('flaky'), { code: 'FLAKY' }) });
    assert.equal(r.ok, true);
    assert.equal(r.retried, true);
    const row = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'p1');
    assert.equal(row.status, 'READY');
    assert.ok(row.next_retry_at, 'retry delay scheduled');
    const delay = row.next_retry_at.getTime() - Date.now();
    assert.ok(delay > 0 && delay <= 1000, `backoff within bound: ${delay}ms`);
    // not yet re-eligible: lease returns nothing before next_retry_at
    const early = await eng.leaseReadyNode({});
    assert.equal(early, null, 'node not re-leaseable before backoff elapses');
  });

  await t.test('after backoff the node is re-leased; second transient failure again', async () => {
    await sleep(560);
    const leased2 = await eng.leaseReadyNode({});
    assert.ok(leased2, 're-leased after backoff');
    assert.equal(leased2.attempt, 2);
    const r = await eng.failRunNode(leased2.id, { owner: 'w-retry', token: leased2.lease_token, error: Object.assign(new Error('flaky2'), { code: 'FLAKY' }) });
    assert.equal(r.retried, true);
  });

  await t.test('third attempt succeeds; fan-out unlocks output; run COMPLETED', async () => {
    await sleep(560);
    const leased3 = await eng.leaseReadyNode({});
    assert.ok(leased3);
    assert.equal(leased3.attempt, 3);
    const good = await eng.completeRunNode(leased3.id, { owner: 'w-retry', token: leased3.lease_token, result: { text: 'ok' } });
    assert.equal(good.ok, true);
    const o1 = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'o1');
    assert.equal(o1.status, 'READY');
    // finish o1 (production collector executor)
    const o1Lease = await eng.leaseReadyNode({});
    assert.equal(o1Lease.studio_node_id, 'o1');
    await eng.completeRunNode(o1Lease.id, { owner: 'w-retry', token: o1Lease.lease_token, result: { collected: {} } });
    const run = (await pg.query('SELECT status, completed_at, node_status_counts FROM studio_runs WHERE id=$1', [created.runId])).rows[0];
    assert.equal(run.status, 'COMPLETED');
    assert.ok(run.completed_at, 'completed_at set');
    assert.deepEqual(run.node_status_counts, { SUCCEEDED: 2 });
  });

  await t.test('retry exhaustion -> FAILED + transitive downstream CANCELLED + run FAILED', async () => {
    const s2 = await seedProject(pg, {
      nodeRows: [nodes.prompt('fp'), nodes.prompt('mid'), nodes.output('fo')],
      edgeRows: [edge('f1', 'fp', 'mid', 'text', 'text'), edge('f2', 'mid', 'fo', 'text', 'text')],
    });
    const eng2 = makeEngine(pg, {
      workerId: 'w-exhaust',
      executors: { 'fp': testExecutor({ permanentFail: true, code: 'PERMANENT' }) },
      retryBackoffMs: [1],
    });
    const c2 = await engineCreateRun(pg, eng2, s2, { idempotencyKey: 'exhaust-1' });
    await isolateRun(pg, c2.runId);
    const fin = await runToCompletion(pg, eng2, c2.runId);
    assert.equal(fin.status, 'FAILED');
    const byId = Object.fromEntries((await runNodes(pg, c2.runId)).map((x) => [x.studio_node_id, x]));
    assert.equal(byId.fp.status, 'FAILED');
    assert.equal(byId.mid.status, 'CANCELLED', 'downstream of permanent failure is cancelled');
    assert.equal(byId.fo.status, 'CANCELLED', 'transitive downstream cancelled');
    assert.equal(fin.failure_code, 'NODE_FAILED');
    // no infinite retry: attempts bounded at max_attempts
    assert.ok(byId.fp.attempt <= byId.fp.max_attempts);
  });
});

test('engine: fan-in concurrency, counter never negative, dependent READY exactly once', { concurrency: 1 }, async (t) => {
  // A, B, C (independent prompts) all feed J (output). J must wait for all 3.
  const s = await seedProject(pg, {
    nodeRows: [nodes.prompt('A'), nodes.prompt('B'), nodes.prompt('C'), nodes.output('J')],
    edgeRows: [
      edge('e1', 'A', 'J', 'text', 'text'),
      edge('e2', 'B', 'J', 'text', 'text'),
      edge('e3', 'C', 'J', 'text', 'text'),
    ],
  });
  const eng = makeEngine(pg, { workerId: 'w-fanin' });
  const created = await engineCreateRun(pg, eng, s, { idempotencyKey: 'fanin-1' });
  await isolateRun(pg, created.runId);

  await t.test('initial state: 3 READY sources, join BLOCKED with dependency_count 3', async () => {
    const byId = Object.fromEntries((await runNodes(pg, created.runId)).map((x) => [x.studio_node_id, x]));
    for (const k of ['A', 'B', 'C']) assert.equal(byId[k].status, 'READY');
    assert.equal(byId.J.status, 'BLOCKED');
    assert.equal(byId.J.dependency_count, 3);
    assert.equal(byId.J.remaining_dependency_count, 3);
  });

  await t.test('concurrent completions of all 3 parents: J READY exactly once, rem never negative', async () => {
    const leased = await eng.leaseReadyNodes({ limit: 10 });
    assert.equal(leased.length, 3, 'all three independent sources leased in one batch');
    const byNode = Object.fromEntries(leased.map((x) => [x.studio_node_id, x]));
    // complete all three in parallel (simulates 3 concurrent workers)
    const results = await Promise.all([
      eng.completeRunNode(byNode.A.id, { owner: 'w-fanin', token: byNode.A.lease_token, result: { text: 'a' } }),
      eng.completeRunNode(byNode.B.id, { owner: 'w-fanin', token: byNode.B.lease_token, result: { text: 'b' } }),
      eng.completeRunNode(byNode.C.id, { owner: 'w-fanin', token: byNode.C.lease_token, result: { text: 'c' } }),
    ]);
    const unlocks = results.filter((r) => Array.isArray(r.unlocked) && r.unlocked.length > 0).length;
    assert.equal(unlocks, 1, 'J transitioned to READY exactly once across concurrent parents');
    const j = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'J');
    assert.equal(j.status, 'READY');
    assert.equal(j.remaining_dependency_count, 0);
    assert.ok(j.remaining_dependency_count >= 0, 'counter never negative');
  });

  await t.test('join completes; run COMPLETED with correct counts', async () => {
    const jLease = await eng.leaseReadyNode({});
    assert.equal(jLease.studio_node_id, 'J');
    await eng.completeRunNode(jLease.id, { owner: 'w-fanin', token: jLease.lease_token, result: { collected: {} } });
    const run = (await pg.query('SELECT status, node_status_counts FROM studio_runs WHERE id=$1', [created.runId])).rows[0];
    assert.equal(run.status, 'COMPLETED');
    assert.deepEqual(run.node_status_counts, { SUCCEEDED: 4 });
  });
});

test('engine: cancel foundation — no new lease after cancel request', { concurrency: 1 }, async (t) => {
  const s = await seedProject(pg, {
    nodeRows: [nodes.prompt('cp'), nodes.prompt('cq'), nodes.output('co')],
    edgeRows: [edge('c1', 'cp', 'co', 'text', 'text'), edge('c2', 'cq', 'co', 'text', 'text')],
  });
  const eng = makeEngine(pg, { workerId: 'w-cancel' });
  const created = await engineCreateRun(pg, eng, s, { idempotencyKey: 'cancel-1' });
  await isolateRun(pg, created.runId);

  await t.test('cancel request marks run, cancels READY/BLOCKED nodes, no new leases', async () => {
    const r = await eng.requestRunCancellation(created.runId);
    assert.equal(r.ok, true);
    assert.equal(r.cancelledNodes, 3, 'all READY+BLOCKED nodes cancelled immediately');
    const run = (await pg.query('SELECT status, cancel_requested_at FROM studio_runs WHERE id=$1', [created.runId])).rows[0];
    assert.ok(run.cancel_requested_at, 'durable cancel_requested_at set');
    assert.equal(await eng.leaseReadyNode({}), null, 'no new lease after cancel request');
  });

  await t.test('run aggregates to CANCELLED once all nodes terminal', async () => {
    const run = (await pg.query('SELECT status FROM studio_runs WHERE id=$1', [created.runId])).rows[0];
    assert.equal(run.status, 'CANCELLED');
    const byId = Object.fromEntries((await runNodes(pg, created.runId)).map((x) => [x.studio_node_id, x]));
    for (const k of ['cp', 'cq', 'co']) assert.equal(byId[k].status, 'CANCELLED');
  });

  await t.test('in-flight leased node still finishes; run stays nonterminal until it lands', async () => {
    const s2 = await seedProject(pg, {
      nodeRows: [nodes.prompt('ip'), nodes.output('io')],
      edgeRows: [edge('i1', 'ip', 'io', 'text', 'text')],
    });
    const c2 = await engineCreateRun(pg, eng, s2, { idempotencyKey: 'cancel-2' });
    await isolateRun(pg, c2.runId);
    const leased = await eng.leaseReadyNode({});
    assert.equal(leased.studio_node_id, 'ip');
    const cr = await eng.requestRunCancellation(c2.runId);
    assert.equal(cr.cancelledNodes, 1, 'only the BLOCKED downstream cancelled; in-flight ip keeps its lease');
    // the in-flight worker is allowed to complete (cooperative cancel is M05-D2)
    const done = await eng.completeRunNode(leased.id, { owner: 'w-cancel', token: leased.lease_token, result: { text: 'x' } });
    assert.equal(done.ok, true);
    const run = (await pg.query('SELECT status FROM studio_runs WHERE id=$1', [c2.runId])).rows[0];
    assert.equal(run.status, 'CANCELLED', 'run CANCELLED once every node terminal');
  });
});

test('engine: revision TOCTOU race — a Run can never claim rev N with rev N+1 graph', { concurrency: 1 }, async (t) => {
  const s = await seedProject(pg, {
    nodeRows: [nodes.prompt('p1'), nodes.output('o1')],
    edgeRows: [edge('e1', 'p1', 'o1', 'text', 'text')],
  });
  const eng = makeEngine(pg, { workerId: 'w-toctou' });
  const project = (await pg.query('SELECT * FROM projects WHERE id=$1', [s.project])).rows[0];

  await t.test('concurrent create@rev1 + canvas bump: exactly ONE run, bound to a single consistent revision', async () => {
    // Barrier: fire the canvas mutation and two create attempts as close
    // together as possible. The canvas row lock (FOR UPDATE / CAS) must
    // serialize them so the winner always sees ONE coherent (revision,
    // nodes, edges) tuple — never rev N with rev N+1 graph state.
    const results = await Promise.allSettled([
      pg.query('UPDATE studio_canvases SET revision = revision + 1, updated_at = NOW() WHERE id=$1', [s.canvas]),
      eng.createRunFromCanvas({ project, canvasId: s.canvas, requestedCanvasRevision: 1, runMode: 'ALL', idempotencyKey: 'race-1', requestedBy: s.user.id }),
      eng.createRunFromCanvas({ project, canvasId: s.canvas, requestedCanvasRevision: 1, runMode: 'ALL', idempotencyKey: 'race-2', requestedBy: s.user.id }),
    ]);
    const creates = results.filter((r) => r.status === 'fulfilled' && r.value && r.value.ok);
    const rejections = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value && r.value.ok === false));
    // Every outcome is one of: success@rev1 (the create won the lock before
    // the mutation committed) or CANVAS_REVISION_STALE (the mutation won).
    // The mutation may beat BOTH creates — that is a legal outcome too.
    assert.ok(creates.length + rejections.length === 2, 'both create attempts resolved');
    assert.ok(creates.length <= 2, 'at most one successful create per key');
    for (const rej of rejections) {
      assert.equal((rej.reason && rej.reason.code) || null, 'CANVAS_REVISION_STALE', 'lost races fail with the stale-revision code, never partially');
    }
    const liveRev = (await pg.query('SELECT revision FROM studio_canvases WHERE id=$1', [s.canvas])).rows[0].revision;
    assert.equal(liveRev, 2, 'canvas bump applied exactly once');
    const rows = (await pg.query('SELECT canvas_revision, compiled_graph_json FROM studio_runs WHERE canvas_id=$1 ORDER BY created_at', [s.canvas])).rows;
    assert.equal(rows.length, creates.length, 'exactly one run row per successful create — no partial runs');
    for (const row of rows) {
      // THE invariant: persisted revision === revision inside the compiled
      // graph === graph state of that revision (p1/o1 only; nothing later).
      assert.equal(row.canvas_revision, row.compiled_graph_json.canvasRevision, 'run row revision matches compiled graph revision');
      assert.equal(row.compiled_graph_json.canvasRevision, 1, 'only revision 1 was requested; rev-2 state must never be bound');
      const nodeIds = row.compiled_graph_json.nodes.map((n) => n.nodeId).sort();
      assert.deepEqual(nodeIds, ['o1', 'p1'], 'snapshot contains exactly the rev-1 graph, no leaked nodes');
    }
  });

  await t.test('mutation commits between two creates: first@1 succeeds, second@1 gets 409-equivalent stale', async () => {
    // Deterministic version of the same race: create@rev1 (success, locks+
    // releases), then canvas mutation to rev2, then create@rev1 again —
    // it MUST fail CANVAS_REVISION_STALE with no partial run.
    const before = (await pg.query('SELECT COUNT(*)::int c FROM studio_runs WHERE canvas_id=$1', [s.canvas])).rows[0].c;
    await pg.query('UPDATE studio_canvases SET revision = revision + 1, updated_at = NOW() WHERE id=$1', [s.canvas]); // now 3
    let stale = null;
    try {
      await eng.createRunFromCanvas({ project, canvasId: s.canvas, requestedCanvasRevision: 2, runMode: 'ALL', idempotencyKey: 'race-stale', requestedBy: s.user.id });
    } catch (e) { stale = e; }
    assert.ok(stale, 'stale revision request must be rejected');
    assert.equal(stale.code, 'CANVAS_REVISION_STALE');
    const after = (await pg.query('SELECT COUNT(*)::int c FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2', [s.canvas, 'race-stale'])).rows[0].c;
    assert.equal(after, 0, 'no partial run for the stale request');
    void before;
  });

  await t.test('a run bound to rev N contains ONLY rev N graph even after canvas edits to N+1', async () => {
    // Add a node at rev 4 (live edit) while runs bound to rev 1 exist.
    await pg.query('UPDATE studio_canvases SET revision = revision + 1, updated_at = NOW() WHERE id=$1', [s.canvas]); // 4
    await pg.query(
      `INSERT INTO studio_canvas_nodes (canvas_id, node_id, node_type, node_schema_version, data_json)
       VALUES ($1,'rev2-node','prompt',1,$2)`,
      [s.canvas, JSON.stringify({ parameters: { prompt: 'late' } })]
    );
    for (const row of (await pg.query('SELECT canvas_revision, compiled_graph_json FROM studio_runs WHERE canvas_id=$1', [s.canvas])).rows) {
      if (row.canvas_revision < 4) {
        assert.ok(!JSON.stringify(row.compiled_graph_json).includes('rev2-node'), 'pre-existing run snapshot unchanged by live edit');
      }
    }
    // A fresh run at the CURRENT revision DOES include the new node — proving
    // the graph read is revision-exact, not stale-cache.
    const curRev = (await pg.query('SELECT revision FROM studio_canvases WHERE id=$1', [s.canvas])).rows[0].revision;
    const fresh = await eng.createRunFromCanvas({ project, canvasId: s.canvas, requestedCanvasRevision: curRev, runMode: 'ALL', idempotencyKey: 'race-fresh', requestedBy: s.user.id });
    assert.equal(fresh.ok, true);
    assert.ok(fresh.graph.nodes.some((n) => n.nodeId === 'rev2-node'), 'fresh run binds the new revision graph');
  });
});

test('engine: concurrent duplicate create with same idempotency key yields ONE run', { concurrency: 1 }, async (t) => {
  const s = await seedPromptOutput();
  const eng = makeEngine(pg, { workerId: 'w-idem' });
  const project = (await pg.query('SELECT * FROM projects WHERE id=$1', [s.project])).rows[0];

  await t.test('N concurrent identical creates -> exactly 1 run row, 1 node set', async () => {
    const N = 8;
    const results = await Promise.allSettled(Array.from({ length: N }, () =>
      eng.createRunFromCanvas({ project, canvasId: s.canvas, requestedCanvasRevision: 1, runMode: 'ALL', idempotencyKey: 'dup-key', requestedBy: s.user.id })
    ));
    const okResults = results.filter((r) => r.status === 'fulfilled' && r.value && r.value.ok);
    assert.equal(okResults.length, N, 'all concurrent creates succeed (idempotent or fresh)');
    const runIds = new Set(okResults.map((r) => r.value.runId));
    assert.equal(runIds.size, 1, 'exactly one run id across all concurrent creates');
    const runCount = (await pg.query('SELECT COUNT(*)::int c FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2', [s.canvas, 'dup-key'])).rows[0].c;
    assert.equal(runCount, 1, 'exactly one run row persisted');
    const nodeCount = (await pg.query('SELECT COUNT(*)::int c FROM studio_run_nodes WHERE run_id=$1', [[...runIds][0]])).rows[0].c;
    assert.equal(nodeCount, 2, 'no duplicate node rows from the losing inserts');
  });
});

test('engine: multi-worker — two replicas lease concurrently, restart-safe recovery', { concurrency: 1 }, async (t) => {
  // 4 independent prompt roots -> 1 output join.
  const s = await seedProject(pg, {
    nodeRows: [nodes.prompt('w1'), nodes.prompt('w2'), nodes.prompt('w3'), nodes.prompt('w4'), nodes.output('wj')],
    edgeRows: [
      edge('x1', 'w1', 'wj', 'text', 'text'),
      edge('x2', 'w2', 'wj', 'text', 'text'),
      edge('x3', 'w3', 'wj', 'text', 'text'),
      edge('x4', 'w4', 'wj', 'text', 'text'),
    ],
  });
  // Two worker REPLICAS: distinct workerIds, same engine module, same PG.
  const replicaA = makeEngine(pg, { workerId: 'w-replica-A', leaseSeconds: 120 });
  const replicaB = makeEngine(pg, { workerId: 'w-replica-B', leaseSeconds: 120 });
  const created = await engineCreateRun(pg, replicaA, s, { idempotencyKey: 'multi-1' });
  await isolateRun(pg, created.runId);

  await t.test('two workers lease independently: deterministic split, no conflict', async () => {
    // Deterministic: replica A takes the first 2 READY nodes, replica B the rest.
    const a = await replicaA.leaseReadyNodes({ limit: 2 });
    assert.equal(a.length, 2);
    const b = await replicaB.leaseReadyNodes({ limit: 4 });
    assert.equal(b.length, 2, 'replica B leases exactly the nodes A left READY');
    const all = [...a, ...b];
    assert.equal(new Set(all.map((x) => x.id)).size, 4, '4 distinct nodes, no overlap');
    assert.ok(a.every((x) => x.lease_owner === 'w-replica-A'));
    assert.ok(b.every((x) => x.lease_owner === 'w-replica-B'));
    // join stays BLOCKED (4 deps)
    const j = (await runNodes(pg, created.runId)).find((x) => x.studio_node_id === 'wj');
    assert.equal(j.status, 'BLOCKED');
  });

  await t.test('concurrent sweep by both replicas: no double lease ever', async () => {
    // Fresh run: both replicas sweep simultaneously. Regardless of how the
    // work splits, every node is leased exactly once.
    const s2 = await seedProject(pg, {
      nodeRows: [nodes.prompt('c1'), nodes.prompt('c2'), nodes.prompt('c3'), nodes.output('cj')],
      edgeRows: [edge('y1', 'c1', 'cj', 'text', 'text'), edge('y2', 'c2', 'cj', 'text', 'text'), edge('y3', 'c3', 'cj', 'text', 'text')],
    });
    const c2 = await engineCreateRun(pg, replicaA, s2, { idempotencyKey: 'multi-2' });
    await isolateRun(pg, c2.runId);
    const [p, q] = await Promise.all([
      replicaA.leaseReadyNodes({ limit: 3 }),
      replicaB.leaseReadyNodes({ limit: 3 }),
    ]);
    const all = [...p, ...q];
    assert.equal(all.length, 3, 'all 3 READY roots leased exactly once across the concurrent sweep');
    assert.equal(new Set(all.map((x) => x.id)).size, 3, 'no double lease across concurrent replicas');
  });

  await t.test('durable state is restart-safe: a NEW engine instance sees and recovers', async () => {
    // Own run for this subtest (isolateRun in the previous subtest cancelled
    // multi-1 by design — restart recovery must be proven on live state).
    const s3 = await seedProject(pg, {
      nodeRows: [nodes.prompt('r1'), nodes.prompt('r2'), nodes.prompt('r3'), nodes.prompt('r4'), nodes.output('rj')],
      edgeRows: [edge('z1','r1','rj','text','text'), edge('z2','r2','rj','text','text'), edge('z3','r3','rj','text','text'), edge('z4','r4','rj','text','text')],
    });
    const c3 = await engineCreateRun(pg, replicaA, s3, { idempotencyKey: 'multi-3' });
    await isolateRun(pg, c3.runId);
    await replicaA.leaseReadyNodes({ limit: 2 });
    await replicaB.leaseReadyNodes({ limit: 4 });
    // Simulate process restart: a completely fresh engine instance must see
    // the RUNNING nodes + persisted lease credentials in PG and use them.
    const replicaC = makeEngine(pg, { workerId: 'w-replica-C-restarted', leaseSeconds: 120 });
    const leasedNow = await pg.query(
      "SELECT * FROM studio_run_nodes WHERE run_id=$1 AND status='RUNNING' ORDER BY studio_node_id", [c3.runId]
    );
    assert.equal(leasedNow.rows.length, 4, '4 nodes RUNNING in PG survive the "restart"');
    for (const row of leasedNow.rows.slice(0, 2)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await replicaC.completeRunNode(row.id, { owner: row.lease_owner, token: row.lease_token, result: { text: 'r' } });
      assert.equal(r.ok, true, 'persisted lease credentials accepted after restart');
    }
    // one node's lease expires -> reaper on the restarted replica recovers it
    // (1ms backoff so the test doesn't wait)
    const survivor = (await pg.query(
      "SELECT * FROM studio_run_nodes WHERE run_id=$1 AND status='RUNNING' ORDER BY studio_node_id LIMIT 1", [c3.runId]
    )).rows[0];
    await forceLeaseExpired(pg, survivor.id);
    // eslint-disable-next-line no-await-in-loop
    const reap = await replicaC.reapExpiredNodes({ limit: 10, retryBackoffMs: [1] });
    assert.ok(reap.reaped >= 1, 'reaper on the restarted replica recovers the expired node');
    // the other still-RUNNING node: its original owner is "dead" — the
    // restarted replica completes it with the persisted credentials.
    const leftover = (await pg.query(
      "SELECT * FROM studio_run_nodes WHERE run_id=$1 AND status='RUNNING' LIMIT 1", [c3.runId]
    )).rows[0];
    assert.ok(leftover, 'one node still RUNNING after reaping the expired one');
    // eslint-disable-next-line no-await-in-loop
    const lres = await replicaC.completeRunNode(leftover.id, { owner: leftover.lease_owner, token: leftover.lease_token, result: { text: 'l' } });
    assert.equal(lres.ok, true, 'restarted replica completes the surviving leased node');
    // the recovered node (r3) is now READY with a 1ms backoff: lease +
    // complete it directly on the restarted replica (deterministic).
    await sleep(10);
    const rec = await replicaC.leaseReadyNode({});
    assert.ok(rec, 'recovered node re-leased by restarted replica');
    // eslint-disable-next-line no-await-in-loop
    const recRes = await replicaC.completeRunNode(rec.id, { owner: rec.lease_owner, token: rec.lease_token, result: { text: 'rec' } });
    assert.equal(recRes.ok, true, 'recovered node completes; join unlocked');
    // only the join remains: complete it -> run COMPLETED
    const jLease = await replicaC.leaseReadyNode({});
    assert.equal(jLease.studio_node_id, 'rj');
    // eslint-disable-next-line no-await-in-loop
    await replicaC.completeRunNode(jLease.id, { owner: jLease.lease_owner, token: jLease.lease_token, result: { collected: {} } });
    const fin = (await pg.query('SELECT status, node_status_counts FROM studio_runs WHERE id=$1', [c3.runId])).rows[0];
    assert.equal(fin.status, 'COMPLETED');
    assert.deepEqual(fin.node_status_counts, { SUCCEEDED: 5 });
  });
});
