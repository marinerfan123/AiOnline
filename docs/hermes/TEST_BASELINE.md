# TEST_BASELINE.md — Moling AI

## Baseline (2026-08-23)

| Suite | Pass | Total | Status |
|-------|------|-------|--------|
| Syntax | 125 | 125 | PASS |
| Typecheck | - | - | PASS |
| ESLint | 0 err / 17 warn | - | PASS |
| Unit | 51 | 51 | PASS |
| V2 | 186 | 186 | PASS |
| API | 39 | 39 | PASS |
| Migration | 12 | 12 | PASS |
| DR (B1-B20) | 20 | 20 | PASS |
| Security (S1-S20) | 20 | 20 | PASS |
| Build | - | - | PASS |

## DR Drill Evidence

- Run 1: PASS (~16s)
- Run 2: PASS (~28s)
- Backup duration: ~300ms
- Restore duration: ~1650ms
- Parity: PASS (core V2 tables verified)

## Commands

```bash
npm run verify          # Quality gate (syntax, typecheck, eslint, unit, v2, api, build)
npm run test:dr         # DR tests (B1-B20)
npm run dr:test         # Full DR drill (seed → backup → restore → parity)
npm run test:migration  # Migration tests (M1-M12)
```

## Local Tags

- baseline/moling-disaster-recovery
- baseline/moling-db-migrations
- baseline/moling-ci-quality-gate
- baseline/moling-provider-reconciliation
- baseline/moling-phase1-safety-net
