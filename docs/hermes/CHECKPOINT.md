# CHECKPOINT.md

## Project
- Repo: github_ai_online
- Branch: feat/commercial-generation-v2
- HEAD: 6e13f0a
- Started: 2026-08-22

## Architecture
- Frontend: React + Vite + TypeScript
- Backend: Node.js 22 + Express
- PostgreSQL: primary store, V2 state machine
- Redis: cache only, graceful degradation
- OSS: Aliyun OSS / Tencent COS
- Generation V2: PostgreSQL-backed durable workflow
- Billing: credit holds with pg_advisory_xact_lock
- Migrations: server/db/migrate.cjs (advisory lock, checksum, transactional)
- Backup: scripts/backup-db.cjs (logical backup with schema metadata)
- Restore: scripts/restore-db.cjs (DDL generation from schema metadata)
- DR: scripts/dr-drill.cjs (full drill: seed → backup → restore → parity)

## Tests
- V2: 186/186 PASS
- Unit: 51/51 PASS
- API: 39/39 PASS
- Migration: 12/12 PASS (M1-M12)
- DR: 20/20 PASS (B1-B20)
- Typecheck: PASS | ESLint: 0 err / 17 warn | Build: PASS | Syntax: 125/125 PASS
- Canonical: `npm run verify` (ALL PASS ~43s)
- DR Drill: 2 consecutive PASS
- Flake: 3 consecutive ALL PASS (verify + DR tests)
- Fail-closed: YES

## CI
- .github/workflows/ci.yml: isolated PostgreSQL/Redis, uses migrate.cjs
- .github/workflows/dr.yml: manual/weekly DR drill (no prod secrets)
- No production secrets | Permissions: contents: read | Concurrency: cancel-in-progress

## Recent Commits
1. 4eb5fde - fix(security): Phase 1 Step 7 — production security baseline
2. 56f7e71 - docs(hermes): update flake test evidence (3x consecutive PASS)
3. 6e13f0a - docs(ops): add backup and disaster recovery runbooks + CI DR workflow
4. 7ed5da8 - feat(ops): add verified database backup and restore tooling
5. aff578e - docs(hermes): prohibit autonomous self-modification

## Completed
- Phase 1 Step 3: Provider reconciliation productionization
- Phase 1 Step 4: CI + unified engineering quality gate
- Phase 1 Step 5: Database migration discipline
- Phase 1 Step 5.2: Hermes skill integrity
- Phase 1 Step 6: Backup / Restore / Rollback disaster recovery
- Phase 1 Step 7: Production Security Baseline

## Hermes Policy
Hermes may not classify a code-changing task COMPLETE unless `npm run verify` passes AFTER the final modification.

## Phase 1.5 Step 1 — Commercial Distributed Staging Foundation
- Branch: feat/commercial-distributed-staging
- Status: COMPLETE (evidence-verified)
- Starting HEAD: f1f2975
- Commits since start: 1 (9b7dd71)
- Canonical verify: ALL PASS (44s)

### Distributed Tests — 20 PASS / 0 FAIL
T01  D1   API-01 dies — API-02 serves          (independent PG pools)
T02  D2   API requests distribute               (write pool-1, read pool-2)
T03  D3   Auth multi-node JWT                   (sign/verify cross-node)
T04  D4   Task cross-node readable              (FK-safe, pool-1→pool-2)
T05  D5   Worker crash → lease reap → reclaim   (backdate + reap + claim)
T06  D6   2-worker competition                  (SKIP LOCKED, no dupes)
T07  D7   4-worker concurrency                  (20 items, 0 dupes)
T08  D8   Idempotency key unique violation      (concurrent insert)
T09  D9   Payment webhook dedup                 (concurrent insert, 1 row)
T10  D10a Redis disconnect → PG lease works     (indep. Redis clients)
T11  D10b Redis reconnect → data persists       (disconnect → new client)
T12  D11  Worker-B completes Worker-A's task    (lease_version CAS)
T13  D12  Redis pub/sub msg delivery            (indep. pub/sub clients)
T14  D13a Rolling API restart                   (A down → B serves → A up)
T15  D14a Rolling Worker restart                (A crash → B recovers → A rejoins)
T16  D15  DB disconnect → reconnect             (end pool → new pool)
T17  D16  Migration advisory lock exists        (migrationStore.acquireLock)
T18  D17  No local file dependency              (4 V2 tables in PG)
T19  D18  OSS user-scoped namespaces            (different users → different ns)
T20  D7b  8-worker concurrency                  (40 items, 0 dupes)
T21  D19  Billing PK constraint                 (concurrent hold, ≤1 success)

### Evidence vs claim audit
- Max workers actually tested: 8 (D7b, line 551, `[1..8].map`)
- Redis durable-state independence: PASS (D10a — Redis disconnect, PG lease still works)
- Redis restart/reconnect: PASS (D10b — disconnect → new client → data persists)
- Rolling API restart: PASS (D13a — pg1 end → pg2 serves → pg1_new connects)
- Rolling Worker restart: PASS (D14a — 2 workers → A expires → reap → A rejoins)
- Cross-node Redis event bus: PASS (D12 — indep. pub/sub, payload verified)
- Cross-node SSE end-to-end to client: NOT_VERIFIED (D12 is Redis pub/sub only; no HTTP SSE client)
- Wrong-user SSE isolation: NOT_VERIFIED (not tested)
- Billing concurrent hold/commit: PASS (D19 — PK constraint, ≤1 success)
- Payment concurrent callback: PASS (D9 — unique constraint, 1 row)
- Payment single credit/ledger: NOT_VERIFIED (D9 only tests dedup constraint; no credit/ledger effect tested)

### Commercial blockers
- P0: 0
- P1: 2 (SSE end-to-end to HTTP client not tested; payment credit/ledger effect not tested)
- P2: 0
