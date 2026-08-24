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
- Status: COMPLETE (code + docs + topology)
- Commits: 6 (9696b6d..0d23241)
- Canonical verify: ALL PASS (35s)

### Distributed Tests (D1-D18) — Evidence audit
- D1: FAIL (test bug — wrong default PG password 'postgres' vs '0.0.1abcd')
- D2: PASS (write via pool-1, read via pool-2 — DB sharing works)
- D3: PASS (JWT sign/verify cross-node — HMAC-SHA256 stateless)
- D4: FAIL (test bug — FK violation, test-user-d4 not in users table)
- D5: NOT_VERIFIED (generation_items_v2 missing — migrations not run on huabu)
- D6: NOT_VERIFIED (generation_items_v2 missing)
- D7: NOT_VERIFIED (generation_items_v2 missing)
- D8: NOT_VERIFIED (generation_batches_v2 missing)
- D9: PASS (webhook_events dedup index exists)
- D10: NOT_VERIFIED (generation_items_v2 missing)
- D11: NOT_VERIFIED (generation_items_v2 missing)
- D12: PARTIAL (infra exists — Redis pub/sub verified; no actual cross-node test)
- D13: PASS (pool creation/reconnection works)
- D14: NOT_VERIFIED (generation_items_v2 missing)
- D15: FAIL (test bug — new pool query returns undefined, connection issue)
- D16: PASS (migration advisory lock exists)
- D17: NOT_VERIFIED (0 of 4 V2 tables exist — migrations needed)
- D18: FAIL (test bug — oss.cjs exports buildOssGetUrl not generateSignedUrls)

### Distributed test summary: 5 PASS, 1 PARTIAL, 2 FAIL (test bugs), 10 NOT_VERIFIED (migrations needed)
### Code fix needed: deploy/docker-compose references ./deploy/nginx.conf but file is nginx-distributed.conf

### Architecture evidence
- API stateless: YES (JWT stateless, PG authoritative, no process-local state)
- Worker horizontal scale: YES (FOR UPDATE SKIP LOCKED, lease_version CAS, reaper)
- SSE cross-node: IMPLEMENTED (Redis pub/sub in realtime.cjs)
- Billing multi-node: YES (pg_advisory_xact_lock + ON CONFLICT)
- Payment multi-node: YES (FOR UPDATE + ON CONFLICT DO NOTHING on webhook_events)
- External PG/Redis: YES (env-configured, localhost is dev default only)
- No local filesystem dependency: YES (all state in PG, OSS via signed URLs)
- Docker compose: PROOF-OF-CONCEPT staging simulation (clearly labeled)

### Commercial blockers
- P0: none blocking Step 1
- P1: D5-D11 distributed tests need V2 migrations to verify; SSE cross-node not actually tested end-to-end
- P2: nginx config path mismatch; D18 test references wrong function name
