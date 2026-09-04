'use strict';
/**
 * M05-D1 — Dedicated Studio Worker production entrypoint.
 *
 * Commercial invariant: API replicas and Studio Worker replicas scale
 * INDEPENDENTLY. This process is a Studio Worker only — it serves NO HTTP,
 * holds NO session, and requires NO leader / cluster-worker-#1 / singleton /
 * PID / hostname. Any number of Studio Worker replicas may run concurrently;
 * correctness comes exclusively from PostgreSQL:
 *   - FOR UPDATE SKIP LOCKED leasing (no double lease)
 *   - unique lease token + owner fencing (stale completions rejected)
 *   - expired-lease reaper (crash / reclaim recovery)
 *
 * The same stateless engine (createStudioRunEngine) the API uses is driven
 * here by a worker daemon (reaper + workerTick per tick). It is safe to kill
 * at any instant: the only durable authority is PostgreSQL.
 *
 * Usage:
 *   node server/studio-worker.cjs
 *
 * Env (same PG_* contract as server.js):
 *   PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD/PG_SSLMODE
 *   PG_POOL_MAX (bounded pool; default 10)
 *   STUDIO_WORKER_TICK_MS   (poll interval, default 1000)
 *   STUDIO_WORKER_CONCURRENCY (max parallel node executions, default 4)
 *   STUDIO_WORKER_BATCH     (nodes leased per tick, default 10)
 *   STUDIO_WORKER_REAPER_MS (reaper cadence in ms, default 5000)
 *   STUDIO_WORKER_GRACEFUL_SHUTDOWN_MS (drain window in ms, default 30000)
 *   STUDIO_WORKER_DISABLE_RELAY (set '1' to skip the run_events SSE relay)
 *   STUDIO_WORKER_ID        (optional display/lease-owner label; NOT a
 *                           correctness requirement — a random suffix is
 *                           appended so co-running replicas stay distinct)
 */
const os = require('os');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createStudioRunEngine } = require('./modules/project-foundation/studioRunEngine.cjs');
const budgetSpentStoreMod = require('./modules/project-foundation/budgetSpentStore.cjs');
const { createRunEventRelay } = require('./modules/project-foundation/runEventRelay.cjs');
const { createWorkerDaemon } = require('./modules/generation-v2/worker-daemon.cjs');

function buildPgPool() {
  const pgSslMode = process.env.PG_SSLMODE || 'prefer';
  const pgHost = process.env.PG_HOST || 'localhost';
  let ssl;
  if (pgSslMode === 'disable') ssl = undefined;
  else if (pgSslMode === 'verify-ca') ssl = { rejectUnauthorized: true };
  else if (pgSslMode === 'verify-full') ssl = { rejectUnauthorized: true, servername: pgHost };
  else ssl = { rejectUnauthorized: false }; // prefer / require
  return new Pool({
    host: pgHost,
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'huabu',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '0.0.1abcd',
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
    ...(ssl ? { ssl } : {}),
  });
}

async function main() {
  const baseId = process.env.STUDIO_WORKER_ID || `studio-${os.hostname()}`;
  // Distinct label per process for observability / lease_owner ONLY. Never a
  // uniqueness or correctness authority (SKIP LOCKED + token fencing are).
  const workerId = `${baseId}-${crypto.randomBytes(3).toString('hex')}`;

  const pgPool = buildPgPool();
  // Refuse to start on a dead DB (matches the server "data must be in PG" rule):
  // retry a bounded number of times, then exit non-zero so the orchestrator reschedules.
  const PG_MAX_RETRY = 5, PG_RETRY_DELAY_MS = 2000;
  let ready = false;
  for (let attempt = 1; attempt <= PG_MAX_RETRY; attempt++) {
    try { await pgPool.query('SELECT 1'); ready = true; break; }
    catch (e) {
      if (attempt < PG_MAX_RETRY) {
        console.warn(`[studio-worker] PG connect failed (${attempt}/${PG_MAX_RETRY}): ${e.message}`);
        await new Promise((r) => setTimeout(r, PG_RETRY_DELAY_MS));
      } else {
        console.error('[studio-worker] PG connect failed after max retries; exiting.', e.message);
        process.exit(1);
      }
    }
  }
  if (!ready) process.exit(1);

  // G21: every engine emit also lands in run_events (durable SSE log) via the
  // relay — failures warn-only, never block execution (relay own autocommit pool).
  // The relay is OPTIONAL and best-effort: if constructing it throws, the worker
  // DEGRADES to a no-relay engine (the engine already treats a null relay as
  // absent) instead of dying — matching the engine's "never block execution" rule.
  let relay = null;
  // G21 relay is best-effort AND optional. It can also be disabled outright as
  // an escape hatch: the relay writes run_events (FK -> studio_runs.id, migration
  // 0043) on a SEPARATE autocommit connection, so any engine emit that runs while
  // the surrounding transaction holds a FOR UPDATE lock on the studio_runs row
  // (e.g. aggregateRun on a terminal transition) can deadlock — the relay's FK
  // check waits on that row lock while the transaction waits on the relay.
  if (process.env.STUDIO_WORKER_DISABLE_RELAY !== '1') {
    try {
      relay = createRunEventRelay({ pg: { query: (sql, params) => pgPool.query(sql, params) } });
    } catch (e) {
      console.warn('[studio-worker] run-event relay unavailable; continuing without SSE relay:', e && e.message);
    }
  }

  const engine = createStudioRunEngine({
    pg: {
      query: (sql, params) => pgPool.query(sql, params),
      connect: () => pgPool.connect(),
    },
    workerId,
    relay,
    budgetSpentStore: budgetSpentStoreMod,
    onLog: (tag, payload) => { try { console.log(JSON.stringify({ tag: 'studio-run', event: tag, ...(payload || {}) })); } catch (_) {} },
  });

  const tickIntervalMs = Number(process.env.STUDIO_WORKER_TICK_MS) || 1000;
  const concurrency = Number(process.env.STUDIO_WORKER_CONCURRENCY) || 4;
  const batch = Number(process.env.STUDIO_WORKER_BATCH) || 10;
  const reaperEveryMs = Number(process.env.STUDIO_WORKER_REAPER_MS) || 5000;
  const gracefulShutdownMs = Number(process.env.STUDIO_WORKER_GRACEFUL_SHUTDOWN_MS) || 30000;
  let lastReap = 0;

  const daemon = createWorkerDaemon({
    workerId,
    pgPool,
    tickIntervalMs,
    gracefulShutdownMs,
    onError: (e) => console.warn('[studio-worker] tick error:', e && e.message),
    tick: async () => {
      const now = Date.now();
      // Reap expired leases on a slower cadence than the lease poll; correctness
      // does not depend on this — a missed reap just delays recovery.
      if (now - lastReap >= reaperEveryMs) {
        lastReap = now;
        try { await engine.reapExpiredNodes({ limit: 200 }); }
        catch (e) { console.warn('[studio-worker] reaper error:', e && e.message); }
      }
      try { await engine.workerTick({ concurrency, batch }); }
      catch (e) { console.warn('[studio-worker] worker tick error:', e && e.message); }
    },
  });

  // CRITICAL: register signal handlers BEFORE awaiting daemon.start().
  // daemon.start() returns a promise that only resolves once daemon.stop()
  // runs (it is a run-until-stopped loop); awaiting it first leaves these
  // handlers never installed, so SIGTERM/SIGINT would kill the process with the
  // DEFAULT handler — no drain of in-flight leases. We must drain in-flight
  // leases inside the graceful-shutdown window instead.
  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return; stopping = true;
    console.log(`[studio-worker] ${signal} received; draining in-flight leases (up to ${gracefulShutdownMs}ms; leases expire/reclaim if we die mid-node)`);
    try { await daemon.stop(); } catch (_) {}
    try { await pgPool.end(); } catch (_) {}
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(`[studio-worker] started (id=${workerId}, tick=${tickIntervalMs}ms, concurrency=${concurrency}, batch=${batch}, reaper=${reaperEveryMs}ms)`);
  await daemon.start();
}

main().catch((e) => { console.error('[studio-worker] fatal:', e); process.exit(1); });
