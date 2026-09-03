'use strict';
/**
 * M05-D1 — studio-worker.cjs process-level integration test + engine workerTick
 * regression test (LOCAL TEST DB ONLY).
 *
 * Guards two CRITICAL regressions found in the worker audit:
 *
 *  1. buildExecContext threw `TypeError: Cannot read properties of undefined
 *     (reading 'length')` for EVERY node (studio_run_nodes has no `dependencies`
 *     column — the `(node.dependencies || []) && node.dependencies.length`
 *     expression evaluated `undefined.length` because `[]` is truthy). This
 *     bricked workerTick: no node could ever execute, every run failed on retry
 *     exhaustion. Test 1 proves workerTick now completes a run end-to-end.
 *
 *  2. studio-worker.cjs awaited `daemon.start()` BEFORE registering SIGTERM/
 *     SIGINT handlers. `daemon.start()` returns a run-until-stopped promise
 *     (resolves only after `daemon.stop()`), so the "started" log never printed
 *     and graceful shutdown was dead code — signals killed the process with the
 *     default handler (no in-flight lease drain). Test 2 spawns the REAL
 *     entrypoint and proves "started" prints and SIGTERM drains + exits 0.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('node:child_process');
const {
  bootstrapRunDb, dropDb, seedProject, engineCreateRun, makeEngine, sleep,
  nodes, edge,
} = require('../helpers/studio-run-test.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKER_ENTRY = path.join(REPO_ROOT, 'server', 'studio-worker.cjs');

let db;
let pg;

test.before(async () => {
  db = await bootstrapRunDb();
  pg = db.pg;
});
test.after(async () => { if (db) { await db.pg.end(); await dropDb(db.dbName); } });

function seedPromptOutput() {
  return seedProject(pg, {
    nodeRows: [nodes.prompt('p1'), nodes.output('o1')],
    edgeRows: [edge('e1', 'p1', 'o1', 'text', 'text')],
  });
}

// ── Test 1: engine workerTick completes a run (buildExecContext fix) ────────
test('engine: workerTick completes a prompt->output run (buildExecContext regression)', { concurrency: 1 }, async () => {
  const s = await seedPromptOutput();
  const engine = makeEngine(pg, { workerId: 'w-tick-regression' }); // NO relay
  const created = await engineCreateRun(pg, engine, s, { idempotencyKey: 'tick-regress-1' });
  assert.equal(created.status, 'QUEUED');

  // Drive the run to terminal purely through workerTick (the path that used to
  // throw for every node).
  let status = 'QUEUED';
  for (let i = 0; i < 50 && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(status); i++) {
    await engine.workerTick({ concurrency: 2, batch: 8, retryBackoffMs: [1] });
    const r = await pg.query('SELECT status FROM studio_runs WHERE id=$1', [created.runId]);
    status = r.rows[0] && r.rows[0].status;
  }
  assert.equal(status, 'COMPLETED', 'workerTick should drive the run to COMPLETED');
});

// ── Test 2: process-level started + graceful shutdown (signal-handler fix) ───
function workerEnv() {
  return {
    ...process.env,
    PG_HOST: process.env.TEST_PG_HOST || '127.0.0.1',
    PG_PORT: process.env.TEST_PG_PORT || '5432',
    PG_DATABASE: db.dbName,
    PG_USER: process.env.TEST_PG_USER || 'postgres',
    PG_PASSWORD: process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd',
    PG_SSLMODE: 'disable',
    STUDIO_WORKER_TICK_MS: '50',
    STUDIO_WORKER_REAPER_MS: '100',
    STUDIO_WORKER_GRACEFUL_SHUTDOWN_MS: '3000',
    // The relay writes run_events (FK -> studio_runs) on a separate connection
    // and deadlocks a terminal transition while the engine tx holds the run row
    // FOR UPDATE (separate finding, not this test's target). Disable it here so
    // the run reaches COMPLETED and graceful shutdown can be observed.
    STUDIO_WORKER_DISABLE_RELAY: '1',
  };
}

function spawnWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_ENTRY], { cwd: REPO_ROOT, env: workerEnv() });
    let out = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const spawnTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      done(reject, new Error(`worker never printed "started" within 10s: ${out}`));
    }, 10000);
    spawnTimer.unref?.();
    const onData = (chunk) => {
      out += chunk.toString();
      if (!settled && out.includes('[studio-worker] started')) {
        clearTimeout(spawnTimer);
        done(resolve, { child, getOut: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(spawnTimer); done(reject, e); });
    child.on('exit', (code) => {
      clearTimeout(spawnTimer);
      done(reject, new Error(`worker exited early (code=${code}) before "started": ${out}`));
    });
  });
}

test('studio-worker: prints started, completes a run, drains and exits 0 on SIGTERM', { concurrency: 1 }, async (t) => {
  const s = await seedPromptOutput();
  const engine = makeEngine(pg, { workerId: 'w-seed' });
  const created = await engineCreateRun(pg, engine, s, { idempotencyKey: 'worker-e2e' });
  assert.equal(created.status, 'QUEUED');

  const { child, getOut } = await spawnWorker();
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });

  // The worker leases globally; wait for the run to reach a terminal state.
  let status = 'QUEUED';
  for (let i = 0; i < 200 && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(status); i++) {
    await sleep(50);
    const r = await pg.query('SELECT status FROM studio_runs WHERE id=$1', [created.runId]);
    status = r.rows[0] && r.rows[0].status;
  }
  assert.equal(status, 'COMPLETED', `worker should complete the run, got ${status}. log=${getOut()}`);

  // Graceful shutdown: SIGTERM must trigger the drain handler and exit 0.
  const exitPromise = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  child.kill('SIGTERM');
  const exited = await Promise.race([exitPromise, sleep(8000).then(() => null)]);
  assert.ok(exited, 'worker should exit within 8s of SIGTERM');
  assert.equal(exited.code, 0, `expected exit code 0, got ${JSON.stringify(exited)}. log=${getOut()}`);

  const finalOut = getOut();
  assert.ok(finalOut.includes('SIGTERM received; draining'), 'drain log must be emitted on SIGTERM');
});
