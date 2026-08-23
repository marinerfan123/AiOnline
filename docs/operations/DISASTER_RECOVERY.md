# DISASTER_RECOVERY.md — Moling AI

## Recovery Model

| Tier | Component | Recovery |
|------|-----------|----------|
| 0 | PostgreSQL (users, billing, generation state, migrations) | Backup/restore |
| 1 | Application config (.env, secrets) | Config manifest + manual restore |
| 2 | Redis (rate limit, cache) | Auto-rebuild from PostgreSQL |
| 3 | OSS objects | Deterministic keys; metadata in DB |

## Commands

```bash
# Backup
npm run backup:db -- --db <name> --output <dir>
npm run backup:verify <dir>

# Restore (TEST ONLY)
npm run restore:db -- --backup <dir> --db <name> --allow-overwrite-test

# Full drill
npm run dr:test
```

## Scenarios

### Scenario 1: Bad Application Release

**Detection:** Health check failure, error spike, deploy feedback.
**Immediate action:** Rollback code via Git.
**Do not:** Touch database.
**Recovery:**
1. `git revert <bad-commit>` or checkout baseline tag
2. Redeploy
**Verification:** `npm run verify`, health endpoint.

### Scenario 2: Bad Migration

**Detection:** Migration fails, app won't start, inconsistent state.
**Immediate action:** Stop migration, do not force retry.
**Do not:** Run manual SQL fixes on production.
**Recovery:**
1. If migration rolled back (transactional): re-run after fix
2. If partial: restore pre-migration backup
3. `node scripts/restore-db.cjs --backup <pre-migration-backup> --db <target>`
**Verification:** Migration status, app boot, parity check.

### Scenario 3: Database Loss/Corruption

**Detection:** Connection failures, query errors, data inconsistency.
**Immediate action:** Stop application writes.
**Do not:** Attempt to start app on corrupted DB.
**Recovery:**
1. Assess extent of damage
2. Restore latest verified backup to clean DB
3. Verify parity before switching traffic
**Verification:** Full DR drill, billing parity, generation state.

### Scenario 4: Redis Loss

**Impact:** Rate limiting degrades to memory fallback. Cache loss.
**Recovery:** Restart Redis. No data loss — Redis is cache-only.
**Verification:** V2 durable state in PostgreSQL unchanged.

### Scenario 5: OSS Object Missing

**Detection:** 404 on asset URLs, user reports.
**Do not:** Blindly regenerate paid AI assets.
**Recovery:**
1. Check `generation_items_v2.provider_url` for source
2. Re-upload from provider URL if available
3. Mark as `review_required` if not recoverable
**Verification:** Asset accessible, metadata consistent.

### Scenario 6: Worker Crash

**Impact:** In-flight items stuck in `leased` or `generating`.
**Recovery:** Reaper tick recovers expired leases automatically.
**Verification:** Items return to `queued`/`reconciling` within lease timeout.

### Scenario 7: Provider Response Lost

**Impact:** Item in `reconciling` with unknown outcome.
**Recovery:** Reconciler queries provider API. If still unknown: `review_required`.
**Do not:** Resubmit to provider blindly (double charge risk).
**Verification:** Billing state unchanged, item in `review_required`.

### Scenario 8: Configuration Loss

**Impact:** Missing .env, lost secrets.
**Recovery:**
1. Restore from config backup/secure storage
2. Verify DB connection, JWT, OSS, provider keys
**Verification:** App boots, health check passes.

## Pre-Deployment Checklist

1. Verify release SHA matches expected version
2. Create DB backup: `npm run backup:db -- --db <prod>`
3. Verify backup: `npm run backup:verify <dir>`
4. Record backup ID in deployment manifest
5. Apply migration (if any)
6. Health check: app boot, V2 status, billing query

## Pre-Migration Checklist

Same as pre-deployment, plus:
- Verify migration SQL on test DB first
- Confirm rollback plan with verified backup

## RTO / RPO

| Metric | Value |
|--------|-------|
| Test RTO | ~15-30s (backup) + ~2-30s (restore) |
| RPO | Last backup (no PITR configured) |
| PITR | NOT_CONFIGURED (Phase 1.5 requirement) |
