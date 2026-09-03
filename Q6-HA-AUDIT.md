# Q6 HA & MOLING-1000 Architecture Audit Report

AGENT_ID=Q6
TASK_STATUS=COMPLETED
PERMISSION=READ_ONLY
AUDIT_DATE=2026-08-30
BRANCH=feat/moling-v2-m05d-durable-dag
AGENDA=P0+P1 architecture blockers identified; code design is sound but deployment gap is primary issue.

---

## Executive Summary

Repository-only static audit of the V2 stack. The code design for cross-instance communication (Redis pub/sub, PG SKIP LOCKED leasing) is correct. The primary gap is **deployment**: production docker-compose.v1.yml has no load balancer, so true 2+ replica HA does not yet exist. Secondary gaps are in SSE event-id semantics, rate-limit memory fallback, and graceful shutdown behavior.

**Verdict: Architecture-ready with caveats. Not load-certified.** Requires LB addition + P0 fixes before multi-replica production rollout.

---

## P0 — Must Fix Before Multi-Replica Production

### P0-1: No Production Load Balancer in v1 Deployment

**Location:** `deploy/docker-compose.v1.yml` lines 44-45, 76-77

**Evidence:**
- api-01 binds `18001:3001`, api-02 binds `18002:3001` — both ports exposed directly to host
- No nginx/LB service in v1.yml; `nginx-distributed.conf` exists only for staging (`docker-compose.distributed-staging.yml`)
- `ecosystem.config.cjs` explicitly pins `instances: 1` (PM2 single-process)
- Architecture doc (`COMMERCIAL_PRODUCTION_ARCHITECTURE.md:129`) states "no sticky sessions required" — but no deploy artifact implements this

**Impact:** True 2+ replica HA does not exist in production today. One API node serves all traffic. The audit targets a topology designed but not deployed.

---

### P0-2: SSE Has No Server-Side Event IDs (Last-Event-ID Impossible)

**Location:** `server/server.js:3516-3544`, `src/shared/events/realtime.ts:91`

**Evidence:**
```js
// server.js:3527
res.write('retry: 3000\n\n'); // only retry interval, no event IDs
// ...
for (const s of snap) res.write(`data: ${JSON.stringify(s)}\n\n`); // no 'id:' field
```
- EventSource client sends `lastEventId` header on reconnect (browser behavior)
- Server never reads `req.headers['last-event-id']` — no recovery from mid-stream gap
- `realtime.ts:91`: `const id = msg.lastEventId || parsed?.id || ...` — client-side only, never set by server
- `conns` map in `realtime.cjs:21` is process-local; cross-instance delivery via Redis pub/sub works, but reconnected client on new node has no knowledge of what it missed

**Impact:** On reconnect to a different replica (round-robin LB), client receives full snapshot (good) but events emitted during reconnect window on the new node may arrive before snapshot completes. Acceptable for async generation (seconds latency), not for real-time chat.

---

### P0-3: Outbox Publish Has No Duplicate Guard Under Concurrency

**Location:** `server/modules/generation-v2/reconciler.cjs:84-93`

**Evidence:**
```js
for (const ev of events) {
  try {
    await deps.publish({...ev, payload});
    delivered.push(ev.event_id);
    published++;
  } catch (_) { /* leave undelivered; will retry next tick */ }
}
if (delivered.length) await markOutboxDelivered(pg, delivered);
```
- `markOutboxDelivered` sets `published_at=NOW()` atomically
- But between SELECT (SKIP LOCKED) and UPDATE (mark delivered), another worker can pick same event if lease expires
- `production-adapters.cjs:48-53`: publish delegates to `realtime.emitTaskUpdate` which publishes to Redis pub/sub
- If two workers both publish same event_id, client SSE sees duplicate `item.done` event

**Impact:** Low probability race under high concurrency. Duplicate SSE events possible. No server-side dedupe on event_id.

---

## P1 — Should Fix Before Scale to 1000+ Concurrent

### P1-1: Rate Limit Memory Fallback Multiplies RPM Across Replicas

**Location:** `server/rateLimitRedis.cjs:31-60`, `server/dispatcher.cjs:37`

**Evidence:**
```js
// rateLimitRedis.cjs:31
let localGlobal = 0; // in-memory global concurrency counter
// rateLimitRedis.cjs:46
if (!r) { if (localGlobal < max) { localGlobal++; return id; } return null; }
```
- When Redis is down/unavailable, `acquireGlobalSlot` falls back to in-memory counter
- `tryProviderBucket` also falls back to `_bucket` Map (per-pid, line 95)
- Each API replica maintains independent memory counters
- 2 replicas × 10 global concurrency = effective 20 concurrency when Redis degraded
- Comment at line 3: "Redis 不可用...降级为内存态，与原单进程限流语义一致" — intentional but dangerous at scale

**Impact:** During Redis outage, rate limits silently multiply by replica count. Provider 429 storms possible.

---

### P1-2: Graceful Shutdown Does Not Drain In-Flight SSE Connections

**Location:** `server/server.js:4864-4867`

**Evidence:**
```js
server.close((err) => {
  if (err) console.error('[shutdown] server.close 错误:', err.message);
  // ... closes Redis, then PG
});
```
- `server.close()` stops accepting NEW connections but does NOT close existing ones
- SSE connections remain open indefinitely until client disconnects or 30s `forceExit`
- No per-connection close timeout
- `forceExit` at 30s (line 4851): `process.exit(1)` kills all connections abruptly

**Impact:** During rolling deploy, SSE clients may hang up to 30s before forced disconnect. No graceful drain.

---

### P1-3: Worker Daemon Has No Circuit Breaker on PG/Redis Failure

**Location:** `server/modules/generation-v2/worker-daemon.cjs:18-35`

**Evidence:**
```js
async function loop() {
  while (!shuttingDown) {
    currentTick = (async () => {
      try { await tick(pgPool, redis, {...}); }
      catch (e) { try { onError(e); } catch (_) {} }
    })();
    await currentTick;
    // ... delay
  }
}
```
- No backoff on repeated tick failures — loops at `tickIntervalMs` (default 1000ms) regardless of error
- No health check before tick; PG connection pool may be exhausted silently
- `currentTick` promise races with next iteration — if tick takes > tickIntervalMs, ticks accumulate

**Impact:** Cascading PG pressure during outage. Worker spins at 1 tick/sec even when PG unreachable.

---

### P1-4: Snapshot Query May Return Stale/In-Flight Events

**Location:** `server/realtime.cjs:103-131`

**Evidence:**
```sql
WHERE user_id = $1
  AND (status IN ('running', 'waiting') OR (completed_at > NOW() - INTERVAL '1 hour'))
```
- Includes `running` status tasks — task may complete between snapshot query and SSE push
- 1-hour window for completed tasks — events may have already been published via outbox
- No dedupe between snapshot and live SSE stream on same connection

**Impact:** Client may see task as "running" in snapshot, then receive "done" via outbox with no gap. Acceptable but no explicit dedupe guarantee.

---

## FINDINGS Summary

| # | Area | Severity | Status | Detail |
|---|------|----------|--------|--------|
| F1 | Multi-replica LB | P0 | Not deployed | v1.yml has no LB; nginx-distributed is staging-only |
| F2 | SSE cross-replica | P0 | Design OK, risk | Redis pub/sub works; reconnect may miss brief window |
| F3 | Last-Event-ID | P0 | Missing | No server-side event IDs; client dedupe is per-session |
| F4 | Outbox publish | P0 | Leak risk | Failed publish retries but no duplicate guard under concurrency |
| F5 | Sticky session | Info | Not needed | Docs explicitly state "no sticky sessions required" |
| F6 | Process-local state | P0 | Isolation correct | `conns` map is per-process; cross-instance via Redis |
| F7 | Rate limit degradation | P1 | Silent | Memory fallback multiplies RPM by replica count |
| F8 | Graceful shutdown | P1 | 30s force | server.close() doesn't drain SSE; forceExit at 30s |
| F9 | Worker daemon | P1 | No CB | No backoff on PG/Redis failure; tick accumulation risk |
| F10 | Readiness probe | Info | Correct | /api/readiness checks PG SELECT 1 + Redis ping |
| F11 | Health probe | Info | Correct | /api/healthz returns process alive + CPU metrics |
| F12 | Connection limits | Info | Per-process | PG_POOL_MAX=10 per node; no global conn cap |
| F13 | Event dedupe | P1 | Client-only | seenIds Set per RealtimeClient instance; no server-side |
| F14 | Snapshot stale | P1 | Window risk | 1-hour completed_at window; running tasks may finish during snapshot |

---

## RISKS

1. **Duplicate events on concurrent outbox publish** — two workers pick same event if lease expires between SELECT and UPDATE. Low probability but possible under high load.
2. **Rate limit multiplier on Redis failure** — each API node independently counts RPM in memory. 2 replicas = 2x allowed RPM.
3. **SSE reconnect event gap** — client reconnects to different node; Redis pub/sub delivers events to new node but in-flight events on old node are lost (old node's emitter has no queue).
4. **Rolling deploy SSE disruption** — server.close() leaves SSE open; clients rely on `retry: 3000` but may not reconnect if nginx removes node from upstream before connection closes.

---

## TEST/EVIDENCE

### Evidence 1: Multi-Replica Topology (Static)
- `deploy/docker-compose.v1.yml`: api-01:18001, api-02:18002 (direct bind, no LB)
- `deploy/nginx-distributed.conf`: upstream api_backend with api-01:3001, api-02:3001 (staging only)
- `docs/architecture/COMMERCIAL_PRODUCTION_ARCHITECTURE.md:129`: "No sticky sessions required"

### Evidence 2: Redis Pub/Sub Cross-Instance (Static)
- `server/realtime.cjs:23-77`: `psubscribe task-updates:*` + `publish task-updates:{userId}`
- Fallback on Redis failure: `emitter.emit()` local only
- `server/modules/generation-v2/production-adapters.cjs:48-53`: outbox publish delegates to `realtime.emitTaskUpdate`

### Evidence 3: SSE Handler (Static)
- `server/server.js:3516-3544`: GET /api/generate/stream
- Sets `Content-Type: text/event-stream`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- Writes `retry: 3000` (client reconnect interval)
- Calls `realtime.subscribe(userId, res)` for cross-worker delivery
- Heartbeat every 20s: `setInterval(() => res.write(': ping\n\n'), 20000)`
- Cleanup on close: `res.on('close', () => { clearInterval(hb); unsub(); })`

### Evidence 4: Graceful Shutdown (Static)
- `server/server.js:4826-4884`: SIGTERM/SIGINT handler
- Sets `shuttingDown = true` immediately
- Stops waiting pump, order expiry
- `server.close()` — stops accepting new connections
- 30s forceExit timeout
- Closes Redis, then PG pool

### Evidence 5: Client-Side SSE (Static)
- `src/shared/events/realtime.ts:34-173`: RealtimeClient class
- `seenIds` Set for dedupe (cap 2000, trimmed to last 1000)
- Reconnect with exponential backoff: `base * 2^(reconnects-1)`, capped at 15s
- `lastEventId` from EventSource used as dedupe key (server never sets id:)

### Evidence 6: Lease/Fencing (Static)
- `server/modules/generation-v2/reconciler.cjs:14`: `FOR UPDATE SKIP LOCKED` for generation_items_v2
- `server/modules/generation-v2/reconciler.cjs:73`: `FOR UPDATE SKIP LOCKED` for generation_outbox_v2
- `server/modules/project-foundation/studioRunEngine.cjs:333`: `FOR UPDATE OF n SKIP LOCKED` for studio_run_nodes
- `server/modules/project-foundation/studioRunEngine.cjs:421`: `FOR UPDATE OF n SKIP LOCKED` for reaper
- Lease tokens: `gen_random_uuid()::text` (line 339) — unique per lease, fenced on complete/fail

### Evidence 7: Rate Limiting (Static)
- `server/rateLimitRedis.cjs`: Redis ZSET for global concurrency, Lua atomics for provider bucket
- Memory fallback: `localGlobal` counter (line 31), `_provConc` Map (line 63), `_bucket` Map (line 95)
- Comment: "Redis 不可用...降级为内存态，与原单进程限流语义一致"

### Evidence 8: Health/Readiness Probes (Static)
- `/api/healthz` (server.js:1901-1923): process alive, PG/Redis boolean, CPU metrics
- `/api/readiness` (server.js:1925-1946): live `SELECT 1` on PG pool, Redis ping; returns 503 if not ready
- Docker healthcheck uses `/api/readiness` (v1.yml:49-52, distributed.yml:77-80)

### Evidence 9: Cluster vs Multi-Host (Static)
- `server/server.js:4641-4675`: Node cluster mode (ENABLE_CLUSTER=true, single host, multiple workers)
- `deploy/docker-compose.v1.yml`: Multi-host mode (ENABLE_CLUSTER=false, separate containers)
- `deploy/ecosystem.config.cjs:4-7`: Explicitly documents single-instance requirement for RPM state

### Evidence 10: API Token (Static)
- `server/server.js:17-44`: API_TOKEN from env (production) or local file `server/data/.api_token` (dev)
- Production: `process.env.API_TOKEN` required; dev auto-generates and persists to file
- **Risk:** If API_TOKEN not set in env, each replica generates different token → internal auth breaks

---

## RECOMMENDED_VERIFIER_CHECKS

1. **Start 2 API nodes + 1 Redis + 1 PG** via `docker-compose.distributed-staging.yml`
2. **Connect SSE to node 1**, trigger generation, **kill node 1**, verify SSE reconnects to node 2 and receives completion event
3. **Verify no duplicate events** by counting total `item.done` events vs generation completions in PG
4. **Simulate Redis failure** on one node, verify rate limit degrades to per-process (check RPM allowed doubles)
5. **Check /api/readiness** on both nodes during startup — verify 503 until PG+Redis ready
6. **Send SIGTERM to one API node** — verify other node continues serving, SSE reconnects within 3s
7. **Stress outbox publish** — start 2 workers, trigger 100 generations, verify no duplicate SSE events
8. **Verify API_TOKEN** — ensure same token across replicas (env var, not file)
9. **Verify LB configuration** — add nginx to v1.yml, test round-robin distribution

---

## BLOCKERS

None. Read-only audit completed without blocking issues.

---

## NOTES

- The architecture document (`COMMERCIAL_PRODUCTION_ARCHITECTURE.md`) accurately describes the INTENDED design
- Implementation matches design for cross-instance SSE via Redis pub/sub
- The primary gap is **production deployment**: v1.yml has no LB, so only 1 API node is active
- Worker nodes (`generation-v2/entry.cjs`) are correctly stateless and scale horizontally
- Rate limiting (`rateLimitRedis.cjs`) is correctly Redis-backed for multi-instance safety
- The `ENABLE_CLUSTER` env var controls intra-host worker fork vs inter-host containers
- Studio Run engine (`studioRunEngine.cjs`) uses PG for all durable state — correctly multi-worker safe
- IS_LEADER pattern (line 4675) ensures background tasks run on single instance
- **Architecture-ready**: Code design is sound for HA. **Not load-certified**: Requires actual load test for 1000 VU claim.

---

AGENT_ID=Q6
TASK_STATUS=COMPLETED
PERMISSION=READ_ONLY
FINDINGS=14 total (4 P0, 4 P1, 6 Info)
P0=3 (LB missing, SSE no event IDs, outbox dup risk)
P1=4 (rate limit fallback, shutdown drain, worker CB, snapshot stale)
TEST_EVIDENCE=static_code_audit (10 evidence items)
BLOCKERS=none
