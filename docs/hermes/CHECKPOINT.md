# CHECKPOINT.md — Moling AI / 墨灵AI Engineering Context

## Project
- Repo: github_ai_online
- Branch: feat/commercial-generation-v2
- HEAD: 331f57f
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

## Tests
- V2: 160/160 PASS (incl. failure injection, crash recovery, billing chaos)
- Unit: 51/51 PASS
- API: 39/39 PASS (auth, authorization, setup, generation intake, billing, secret leakage)
- Typecheck: PASS
- ESLint: 0 errors / 17 warnings
- Build: PASS
- Syntax: 118/118 PASS
- Flake: 3x consecutive runs green

## Verified Risks
- reconciler queryProviderStatus: production adapter uses injected stub; real provider reconciliation not yet implemented
- Redis connects to localhost:6379 in tests (rate limiting bypassed in NODE_ENV=test)
- /api/oss GET requires admin (fixed in Step 2.2)

## Recent Commits
1. e1e301c - fix(security): restrict OSS configuration to admins
2. 2e9b641 - test(generation-v2): add failure injection harness and crash/billing recovery tests
3. 331f57f - test(generation-v2): add OSS failure injection, Redis degradation, and persistent project context

## Completed Phases
- Phase A: OSS authorization fix (requireAdmin on GET /api/oss)
- Phase B: Failure injection harness (FaultInjector, FakeProvider, FakeOss)
- Phase C: Worker crash recovery (lease expiry, reaper, reconciling)
- Phase D: Reconciler crash window tests (success/unknown/failed/exception/stale_lease)
- Phase E: OSS failure injection (PUT failure rollback, deterministic keys)
- Phase F: Redis degradation tests (memory fallback, key pool fallback)
- Phase G: Billing chaos/idempotency (concurrent reserve, double commit/release, race conditions)
- Phase J: Full quality gate
- Phase K: Flake check (3 consecutive runs)

## Do Not Redo
- Phase 0 architecture audit (f5e84c2)
- Phase 1 Step 1 green test baseline (2bd6786)
- Phase 1 Step 2 API test harness (e1e301c)
- Phase 1 Step 2.1 ephemeral port + OSS secret coverage
- Phase 1 Step 2.2 OSS security fix

## Next Step
Phase 1 Step 3 or next engineering task as directed.
