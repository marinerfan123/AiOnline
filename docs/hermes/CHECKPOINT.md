# CHECKPOINT.md

## Project
- Repo: github_ai_online
- Branch: feat/commercial-generation-v2
- HEAD: f0f9f39
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

## Tests
- V2: 186/186 PASS
- Unit: 51/51 PASS
- API: 39/39 PASS
- Migration: 12/12 PASS (M1-M12)
- Typecheck: PASS | ESLint: 0 err / 17 warn | Build: PASS | Syntax: 124/124 PASS
- Canonical: `npm run verify` (ALL PASS ~38s)
- Fail-closed: YES

## CI
- .github/workflows/ci.yml: isolated PostgreSQL/Redis, uses migrate.cjs
- No production secrets | Permissions: contents: read | Concurrency: cancel-in-progress

## Recent Commits
1. f0f9f39 - feat(db): add versioned PostgreSQL migration framework
2. c073e50 - docs: update checkpoint with Step 4 completion
3. 6ab9cdf - ci: add unified engineering quality gate
4. 47b21b5 - feat(generation-v2): productionize provider reconciliation

## Completed
- Phase 1 Step 3: Provider reconciliation productionization
- Phase 1 Step 4: CI + unified engineering quality gate
- Phase 1 Step 5: Database migration discipline

## Hermes Policy
Hermes may not classify a code-changing task COMPLETE unless `npm run verify` passes AFTER the final modification.

## Next Step
Phase 1 Step 6: Backup / Restore / Rollback
