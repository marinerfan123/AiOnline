# COMMERCIAL SINGLE NODE GAP MATRIX

Phase 1.5 / Step 1 - Commercial Distributed Staging Foundation
Generated: 2026-08-24

## FINDINGS

| # | Component | File/Function | Current Behavior | Commercial Impact | Severity | Required Remediation |
|---|-----------|---------------|------------------|-------------------|----------|---------------------|
| SN-01 | API_TOKEN | server/server.js L16-30 | API_TOKEN read from local file `server/data/.api_token`; auto-generated if missing | Multi-node API servers would generate different tokens; auth inconsistency | **P0** | API_TOKEN must come from env only; remove local file fallback |
| SN-02 | Settings storage | server/server.js L3950,3965 | `server/data/settings.json` read/write as settings store | Settings diverge across nodes; no shared config | **P0** | Migrate settings to `settings` table in PostgreSQL |
| SN-03 | Media uploads | server/server.js L1298 | `server/data/media-uploads/` local directory for uploads | Uploads node-local; other nodes can't access | **P1** | Redirect to OSS/COS signed upload or temporary bounded dir |
| SN-04 | Readiness probe | server/server.js L1784 | Only `/api/healthz` exists; no `/readiness` | Load balancer can't distinguish process alive vs ready to serve | **P1** | Add `/readiness` endpoint checking PG + Redis connectivity |
| SN-05 | PG SSL | server/server.js L95-100, server/db.cjs L8-16 | No SSL mode config for PostgreSQL connection | Can't connect to managed PostgreSQL requiring SSL/TLS | **P1** | Add `PG_SSLMODE` env var; pass `ssl` option to Pool |
| SN-06 | Redis TLS | server/redis.cjs L9-11 | No TLS/SSL option for Redis connection | Can't connect to managed Redis requiring TLS | **P2** | Add `REDIS_TLS` env var; pass TLS options to ioredis |
| SN-07 | Worker identity fallback | server/modules/generation-v2/worker-service.cjs L3 | Default `v2-${process.pid}` without hostname | Same PID across nodes causes collision; heartbeat confusion | **P1** | Require `WORKER_ID` or `NODE_ID` env; use `os.hostname()` always |
| SN-08 | Worker identity entry | server/modules/generation-v2/entry.cjs | Uses `os.hostname()-${process.pid}` - acceptable but no env override | Good default but inflexible in containerized env | **P2** | Add `WORKER_ID` env override |
| SN-09 | Redis rate limiting | server/redis.cjs kvIncr | Falls back to in-memory counter when Redis down | Multi-node rate limits inaccurate; process-local only | **P1** (acceptable) | Already has graceful degradation; add observability warning |
| SN-10 | SSE event bus | server/realtime.cjs | Redis pub/sub for cross-worker SSE; local EventEmitter fallback | Cross-node SSE works via Redis; falls back to local on Redis down | **P1** | Acceptable; add metric for fallback usage |
| SN-11 | SSE V2 outbox | server/modules/generation-v2/reconciler.cjs + production-adapters.cjs | Outbox published via `realtime.emitTaskUpdate` which uses Redis pub/sub | V2 events reach any API node via Redis | PASS | Already correct |
| SN-12 | Billing concurrency | server/billing.cjs | `UPDATE users SET col = col - $1 WHERE id = $2 AND col >= $1` | Atomic DB-level check; safe across nodes | PASS | Already correct |
| SN-13 | Payment webhook dedup | server/payments/webhook.cjs | `FOR UPDATE` + `ON CONFLICT` unique index | Same webhook hitting 2 nodes: only one processes | PASS | Already correct |
| SN-14 | Generation lease | server/modules/generation-v2/lease.cjs | `FOR UPDATE SKIP LOCKED` + `lease_version` CAS | Multiple workers compete safely; one claims each item | PASS | Already correct |
| SN-15 | Idempotency | server/modules/generation-v2/intake.cjs | `ON CONFLICT (user_id, idempotency_key) DO NOTHING` | Duplicate generation requests across nodes safe | PASS | Already correct |
| SN-16 | Commercial intake | server/modules/generation-v2/commercial-intake.cjs | `pg_advisory_xact_lock(hashtext(...))` + transaction | Concurrent batch creation serialized at DB level | PASS | Already correct |
| SN-17 | Migration lock | server/db/migration-store.cjs | `pg_try_advisory_xact_lock` with fixed tag | Only one migration runs at a time across all nodes | PASS | Already correct |
| SN-18 | Graceful API shutdown | server/server.js L4584-4629 | SIGTERM: stop accepting, wait in-flight, close DB/Redis | Rolling restarts safe; 10s force-kill timeout | PASS | Already correct |
| SN-19 | Graceful worker shutdown | server/modules/generation-v2/entry.cjs | SIGTERM: drain runtime, end PG pool | Worker death recoverable via reaper/lease expiry | PASS | Already correct |
| SN-20 | Auth multi-node | server/auth.cjs L9 | JWT_SECRET from env; HMAC-SHA256 stateless signing | Any API node validates JWT; no session state needed | PASS | Already correct |
| SN-21 | Auth cookie security | server/auth.cjs L88-97 | `isHttps()` checks x-forwarded-proto; dynamic Secure flag | Works behind LB with TLS termination | PASS | Already correct |
| SN-22 | Cluster mode | server/server.js L4410-4438 | Node cluster with ENABLE_CLUSTER/Web_CONCURRENCY | Intra-host multi-core; inter-host still single-process | **P2** | Document: use orchestrator (K8s/Docker Swarm) for multi-host |
| SN-23 | Order expiry worker | server/payments/order-expiry.cjs | Node in-memory scheduler; leader-only via IS_LEADER | Multi-host: each host has a leader; redundant but safe (idempotent) | **P2** | Acceptable; expiry is idempotent by design |
| SN-24 | Object storage | server/oss.cjs, server/assetFinalize.cjs | OSS/COS via DB config; provider URLs in DB | Multi-node safe: all nodes share OSS + DB | PASS | Already correct |
| SN-25 | OSS signed URLs | server/oss.cjs | Server-side signed URLs; no client-side credentials | Browser never receives broad OSS credential | PASS | Already correct |
| SN-26 | PG pool external config | server/server.js L100 | `PG_POOL_MAX` env var, default 10 | Configurable but no capacity model documented | **P2** | Add connection capacity model documentation |
| SN-27 | V2 PG pool external config | server/modules/generation-v2/entry.cjs | `V2_PG_POOL_MAX` env var, default 10 | Configurable per-worker | PASS | Already correct |
| SN-28 | Local JSON data files | server/server.js L922,926 | `readDataFile`/`writeDataFile` for legacy data | Legacy JSON files not used as authoritative state (PG is) | **P2** | Verify no production path depends on these |
| SN-29 | pg_dump/pg_restore DR | scripts/backup-db.cjs | pg_dump -Fc available; only tested locally | Works on Linux but no containerized ops tooling | **P2** | Create containerized DR tooling |
| SN-30 | PITR/WAL | - | No PITR configured | No point-in-time recovery for production PostgreSQL | **P1** | Document managed provider PITR workflow |
| SN-31 | Backup encryption | docs/hermes/DECISIONS.md | `BACKUP_AT_REST_ENCRYPTION_REQUIRED_FOR_PRODUCTION: YES` | Backups unencrypted; compliance risk | **P1** | Document provider-managed encryption requirement |
| SN-32 | Node ID in logs | server/server.js | No NODE_ID in startup banner or structured logs | Hard to distinguish nodes in centralized logs | **P2** | Add NODE_ID to log prefix and health endpoints |
| SN-33 | CORS config | server/server.js L1140,1304 | `CORS_ORIGIN` env var | Works with LB; no multi-node issue | PASS | Already correct |

## SUMMARY

### PASS (already multi-node safe): 12
- Billing concurrency (SN-12)
- Payment webhook dedup (SN-13)
- Generation lease (SN-14)
- Idempotency (SN-15)
- Commercial intake (SN-16)
- Migration lock (SN-17)
- Graceful API shutdown (SN-18)
- Graceful worker shutdown (SN-19)
- Auth multi-node (SN-20)
- Auth cookie security (SN-21)
- Object storage (SN-24)
- OSS signed URLs (SN-25)
- SSE V2 outbox (SN-11)

### P0 - Must fix: 2
- SN-01: API_TOKEN local file
- SN-03: Media uploads local directory (partially: temporary uploads)

### P1 - Should fix: 10
- SN-02: Settings local JSON
- SN-04: No /readiness endpoint
- SN-05: PG SSL
- SN-07: Worker identity collision
- SN-09: Rate limit degradation observability
- SN-10: SSE fallback observability
- SN-30: PITR
- SN-31: Backup encryption

### P2 - Nice to have: 11
- SN-06: Redis TLS
- SN-08: Worker identity env override
- SN-22: Cluster mode documentation
- SN-23: Order expiry multi-host
- SN-26: Connection capacity model doc
- SN-28: Legacy JSON files audit
- SN-29: Containerized pg_dump tooling
- SN-32: Node ID in logs
- SN-33: CORS (already pass, listed for completeness)
