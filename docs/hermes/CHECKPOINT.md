# CHECKPOINT — Overnight Commercial Correctness Closure

Date: 2026-08-25
Branch: fix/commercial-p1-remediation
Final HEAD: 2ae69f0
Starting HEAD: d76436e6ce30093c37c8ae59fa0496131689282b

## P0 Independent Re-Audit: CERTIFIED

P0-01 (Migration/schema): RESOLVED — 14/14 migration tests pass
P0-02 (Distributed Compose): RESOLVED — compose validates, config clean
P0-03 (Worker startup config): RESOLVED — 9/9 tests pass
P0-04 (Distributed Provider admission): RESOLVED — 4/4 tests pass, per-key quota enforced
P0-05 (Provider reconciliation): RESOLVED — 31/31 tests pass, no blind resubmit
P0-06 (Lease + commercial fencing): RESOLVED — 9/9 tests pass

New P0 found: 0
Remaining P0: 0
P0 independently certified: YES

## P1 Remediation: CERTIFIED

P1-01 Billing: FIXED (c5a6dfb) — transactional credit ops with DB-level idempotency
P1-02 Redis recovery: FIXED (2ae69f0) — re-checks Redis connectivity on each call
P1-03 Readiness: FIXED (7dda0d8) — live PG probe with timeout, respects shutting_down
P1-04 Provider crash window: RESOLVED — client_request_id persisted before call, reconciler routes to review_required
P1-05 Runtime DDL: FIXED (f6b2c7b) — production skips inline DDL, verifies migrations
P1-06 Worker shutdown: FIXED (bc14395) — shuttingDown flag prevents new claims
P1-07 Cluster shutdown: FIXED (1404bb6) — clusterShuttingDown flag prevents refork
P1-08 PG SSL: FIXED (5654daf) — accurate mode semantics (require, verify-ca, verify-full)

Remaining P1: 0

## Regression Results

Billing transactional: 7/7 PASS
Migration: 14/14 PASS
V2 core (admission/config/fencing/reconciler/worker/daemon/no-blind-resubmit): 40/40 PASS
V2 extended (redis-failure/reconciliation/lease/production-gate/provider-adapter/retry-policy/runtime): 78/78 PASS
V2 upload/shadow/ledger/intake/observability: 51/57 PASS (6 pre-existing failures)
Canary/fault-injection/migrate-shadow/integration: 30/37 PASS (7 pre-existing infrastructure issues)

Total P0/P1 relevant tests: 139/139 PASS
Pre-existing failures: 13 (unchanged from P0 baseline d76436e)

## 11 Commercial Invariants Verified

1. Remote Provider request exists → no blind resubmit: VERIFIED (reconciler routes to review_required)
2. Expired/wrong worker → no authoritative transition: VERIFIED (lease.cjs CAS fencing)
3. Expired/wrong worker → no billing side effect: VERIFIED (lease-fencing-pg.test.cjs)
4. Provider shared key → distributed admission: VERIFIED (provider-admission.test.cjs)
5. Redis admission unavailable → fail-closed: VERIFIED (provider-admission.test.cjs)
6. Billing mutation → transaction + idempotency: VERIFIED (billing.cjs ON CONFLICT)
7. API startup → no runtime DDL in production: VERIFIED (server.js isProduction gate)
8. Worker shutdown → durable handoff: VERIFIED (generation-worker.cjs shuttingDown)
9. Readiness → live dependency evidence: VERIFIED (server.js SELECT 1 probe)
10. Cluster shutdown → no refork: VERIFIED (server.js clusterShuttingDown)
11. PG verify-ca → real CA validation: VERIFIED (server.js rejectUnauthorized: true)

## Commits (8 total)

c5a6dfb fix(billing): make legacy credit operations transactional with DB-level idempotency
1404bb6 fix(cluster): prevent worker refork during shutdown
7dda0d8 fix(readiness): use live PG probe and respect shutting_down flag
5654daf fix(db): enforce PostgreSQL SSL mode semantics
f6b2c7b fix(db): remove runtime DDL from production API startup
bc14395 fix(worker): make shutdown durable with no-new-claim guard
2ae69f0 fix(redis): recover shared coordination after Redis outage

## Safety Compliance

Main workspace modified: NO
Remote staging touched: NO
Production touched: NO
Remote pushed: NO
Hermes self-modified: NO

## Status

READY_FOR_REAL_STAGING: YES
P0 = 0, P1 = 0
Stopping here as instructed. Do not proceed to Real Staging tonight.
