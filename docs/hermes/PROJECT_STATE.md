# PROJECT_STATE.md

Branch: feat/commercial-generation-v2
HEAD: 6e13f0a
Profile: default (Hermes CLI)
Date: 2026-08-23

## Completed

- Phase 0: Architecture audit, evidence verification, baseline frozen
- Phase 1 Step 1: Green test baseline, ESLint/typecheck/build fixes
- Phase 1 Step 2: API Integration Test Harness (39 tests)
- Phase 1 Step 2.1: Ephemeral port + OSS secret coverage
- Phase 1 Step 2.2: OSS authorization security fix
- Phase 1 Step 3: Provider reconciliation productionization
- Phase 1 Step 4: CI + unified engineering quality gate
- Phase 1 Step 5: Database migration discipline
- Phase 1 Step 5.2: Hermes skill integrity (QUARANTINED_AND_INACTIVE)
- Phase B: V2 Failure Injection Harness
- Phase C: Worker Crash Recovery tests
- Phase D: Reconciler crash window tests
- Phase G: Billing Chaos/Idempotency tests
- Phase 1 Step 6: Backup / Restore / Rollback disaster recovery

## Test Numbers

- V2: 186/186 PASS
- Unit: 51/51 PASS
- API: 39/39 PASS
- Migration: 12/12 PASS
- DR: 20/20 PASS (B1-B20)
- Typecheck: PASS
- ESLint: 0 errors / 17 warnings
- Build: PASS
- Syntax: 125/125 PASS

## Open Tasks

- Phase 1 Step 7: Production Security Baseline

## Backup Commands

```bash
npm run backup:db -- --db <name> --output <dir>
npm run backup:verify <dir>
npm run restore:db -- --backup <dir> --db <name> --allow-overwrite-test
npm run dr:test
```

## DR Evidence

- DR Drill run 1: PASS (~16s)
- DR Drill run 2: PASS (~28s)
- DR Tests: 20/20 PASS
- Restore parity: PASS (tables with FK constraints not recreated — documented limitation)

## RTO / RPO

- Test backup duration: ~300ms
- Test restore duration: ~1650ms
- PITR: NOT_CONFIGURED (Phase 1.5 requirement)
- BACKUP_AT_REST_ENCRYPTION_REQUIRED_FOR_PRODUCTION: YES

## Local Tag

baseline/moling-disaster-recovery
