# CHECKPOINT.md — Moling AI / 墨灵AI Engineering Context

## Project
- Repo: github_ai_online
- Branch: feat/commercial-generation-v2
- HEAD: 6ab9cdf
- Started: 2026-08-22 overnight run

## Architecture (Verified)
- Frontend: React + Vite + TypeScript
- Backend: Node.js 24 + Express (server/server.js monolith)
- PostgreSQL: primary data store, V2 state machine
- Redis: cache only, graceful degradation to memory
- OSS: Aliyun OSS / Tencent COS (multi-slot config)
- Generation V2: PostgreSQL-backed durable workflow (lease + heartbeat + reaper + reconciler)
- Billing: credit holds with pg_advisory_xact_lock for idempotency
- Model Hub: provider/adapter abstraction layer
- Provider Reconciliation: provider-status-router.cjs (Agnes/MiniMax/Volcano one-shot HTTP)

## Tests
- V2: 186/186 PASS (incl. reconciliation, failure injection, crash recovery, billing chaos)
- Unit: 51/51 PASS
- API: 39/39 PASS
- Typecheck: PASS
- ESLint: 0 errors / 17 warnings
- Build: PASS
- Syntax: 121/121 PASS
- Canonical verify: `npm run verify` (ALL PASS in ~42s)
- Fail-closed: YES (tested)

## CI
- .github/workflows/ci.yml: GitHub Actions, isolated PostgreSQL/Redis
- No production secrets
- Permissions: contents: read
- Concurrency: cancel-in-progress on push

## Verified Risks
- Redis connects to localhost:6379 in tests (rate limiting bypassed in NODE_ENV=test)
- 7 HIGH npm audit (postcss, shell-quote, concurrently) — all fixable via `npm audit fix`

## Recent Commits
1. e1e301c - fix(security): restrict OSS configuration to admins
2. 2e9b641 - test(generation-v2): add failure injection harness and crash/billing recovery tests
3. 331f57f - test(generation-v2): add OSS failure injection, Redis degradation, and persistent project context
4. 47b21b5 - feat(generation-v2): productionize provider reconciliation
5. 6ab9cdf - ci: add unified engineering quality gate

## Completed Phases
- Phase A: OSS authorization fix (requireAdmin on GET /api/oss)
- Phase B: Failure injection harness (FaultInjector, FakeProvider, FakeOss)
- Phase C: Worker crash recovery (lease expiry, reaper, reconciling)
- Phase D: Reconciler crash window tests
- Phase E: OSS failure injection
- Phase F: Redis degradation tests
- Phase G: Billing chaos/idempotency
- Phase J: Full quality gate
- Phase K: Flake check
- Phase L/N: Persistent context
- Phase 1 Step 3: Provider reconciliation productionization
- Phase 1 Step 4: CI + unified engineering quality gate

## Hermes Commit Policy
Hermes may not classify a code-changing task COMPLETE unless `npm run verify` passes AFTER the final modification.

## Next Step
Phase 1 Step 5: Database Migration Discipline
