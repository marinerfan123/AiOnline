# PROJECT_STATE.md

Branch: feat/commercial-generation-v2
HEAD: 2e9b641
Profile: default (Hermes CLI)
Date: 2026-08-22 (Overnight Run)

## Completed

- Phase 0: Architecture audit, evidence verification, baseline frozen (f5e84c2)
- Phase 1 Step 1: Green test baseline, ESLint/typecheck/build fixes (2bd6786)
- Phase 1 Step 2: API Integration Test Harness (39 tests, e1e301c)
- Phase 1 Step 2.1: Ephemeral port + OSS secret coverage (e1e301c)
- Phase 1 Step 2.2: OSS authorization security fix (e1e301c)
- Phase B: V2 Failure Injection Harness (fake-provider, fake-oss, FaultInjector) (2e9b641)
- Phase C: Worker Crash Recovery tests (9 integration tests) (2e9b641)
- Phase D: Reconciler crash window tests (5 tests) (2e9b641)
- Phase G: Billing Chaos/Idempotency tests (7 tests) (2e9b641)

## Test Numbers

- V2: 153/153 PASS
- Unit: 51/51 PASS
- API: 39/39 PASS
- Typecheck: PASS
- ESLint: 0 errors / 17 warnings
- Build: PASS
- Syntax: 116/116 PASS

## Open Tasks

- Phase E: OSS failure injection (E1-E5)
- Phase F: Redis failure testing
- Phase H: Auth/Secret regression tests
- Phase I: API error safety regression
- Phase J: Full quality gate
- Phase K: Flake test (3 consecutive runs)
- Phase L: Persistent context (IN PROGRESS)
- Phase M: Context efficiency rules
- Phase N: Final backup
- Phase O: Commit strategy

## Risks

- queryProviderStatus in reconciler.cjs still uses injected stub — needs real adapter
- Redis connects to localhost:6379 in tests (rate limiting bypassed via NODE_ENV=test)
- /api/oss GET now requires admin (fixed in Step 2.2)
