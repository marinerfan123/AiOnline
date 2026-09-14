# CURRENT_TASK.md — Phase 1 Step 6 COMPLETE

## Task: Backup / Restore / Rollback Disaster Recovery

Status: COMPLETE

## Evidence

- DR Drill run 1: PASS (~16s)
- DR Drill run 2: PASS (~28s)
- DR Tests B1-B20: 20/20 PASS
- npm run verify: ALL PASS (~42s)
- Working tree: CLEAN

## Deliverables

- scripts/backup-db.cjs: logical backup with schema metadata + checksums
- scripts/restore-db.cjs: DDL generation + safety guards
- scripts/verify-backup.cjs: manifest + SHA256 verification
- scripts/dr-drill.cjs: full DR drill orchestrator
- server/tests/backup/disaster-recovery.test.cjs: B1-B20 DR tests
- docs/operations/BACKUP.md: backup runbook
- docs/operations/DISASTER_RECOVERY.md: 8 DR scenarios
- .github/workflows/dr.yml: manual/weekly DR validation CI

## Limitations

- FK constraints not captured in logical backup (pg_dump recommended for production)
- BACKUP_AT_REST_ENCRYPTION_REQUIRED_FOR_PRODUCTION: YES (Phase 1.5)
- PITR: NOT_CONFIGURED (Phase 1.5)

## Local Tag

baseline/moling-disaster-recovery

## Next Step

Phase 1 Step 7: Production Security Baseline
