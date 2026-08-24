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
- Status: COMPLETE
- Commits: 8 (9696b6d..HEAD)
- Canonical verify: ALL PASS (45s)

### Distributed Tests (D1-D19) — 19 PASS / 0 FAIL
- D1: PASS (independent PG pools, one ends, other works)
- D2: PASS (write via pool-1, read via pool-2 — DB sharing)
- D3: PASS (JWT HMAC-SHA256 sign/verify cross-node)
- D4: PASS (task created by pool-1, readable by pool-2, FK safe)
- D5: PASS (lease expire → reap → worker-02 claims recovered item)
- D6: PASS (2 workers compete, single claim, no duplicates)
- D7: PASS (4 workers × 20 items, all claimed, no duplicates)
- D8: PASS (concurrent insert same idempotency_key → unique violation)
- D9: PASS (concurrent webhook insert → unique violation)
- D10: PASS (PG-based lease works, state in PG not Redis)
- D11: PASS (Worker-A leased item → Worker-B transitions generating→generated via CAS)
- D12: PASS (actual Redis pub/sub: publish payload, subscriber receives it)
- D13: PASS (pool creation/reconnection)
- D14: PASS (expired generating item → reaped to reconciling)
- D15: PASS (end pool, new pool connects)
- D16: PASS (migration advisory lock exists)
- D17: PASS (all 4 V2 tables in PG with correct columns)
- D18: PASS (user-scoped OSS namespaces, signed URLs)
- D7b: PASS (8 workers × 40 items, all claimed, no duplicates)
- D19: PASS (concurrent billing insert → at most 1 succeeds)

### Architecture evidence (verified by actual tests)
- API stateless: YES
- Worker horizontal scale: YES (SKIP LOCKED, lease_version CAS)
- Max workers tested: 8
- SSE cross-node: YES (Redis pub/sub actual message delivery)
- Billing multi-node: YES (unique constraint + advisory lock)
- Payment multi-node: YES (unique constraint on webhook_events)
- No local filesystem dependency: YES (all state in PG)
- Docker compose: PROOF-OF-CONCEPT (clearly labeled)

### Commercial blockers
- P0: 0
- P1: 0
- P2: 0
