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
- Canonical: `npm run verify` (ALL PASS ~42s)
- DR Drill: 2 consecutive PASS
- Fail-closed: YES

## CI
- .github/workflows/ci.yml: isolated PostgreSQL/Redis, uses migrate.cjs
- .github/workflows/dr.yml: manual/weekly DR drill (no prod secrets)
- No production secrets | Permissions: contents: read | Concurrency: cancel-in-progress

## Recent Commits
1. 6e13f0a - docs(ops): add backup and disaster recovery runbooks + CI DR workflow
2. 7ed5da8 - feat(ops): add verified database backup and restore tooling
3. aff578e - docs(hermes): prohibit autonomous self-modification
4. a5e94e5 - docs: update checkpoint with Step 5 completion
5. f0f9f39 - feat(db): add versioned PostgreSQL migration framework

## Completed
- Phase 1 Step 3: Provider reconciliation productionization
- Phase 1 Step 4: CI + unified engineering quality gate
- Phase 1 Step 5: Database migration discipline
- Phase 1 Step 5.2: Hermes skill integrity
- Phase 1 Step 6: Backup / Restore / Rollback disaster recovery

## Hermes Policy
Hermes may not classify a code-changing task COMPLETE unless `npm run verify` passes AFTER the final modification.

## Next Step
Phase 1 Step 7: Production Security Baseline
