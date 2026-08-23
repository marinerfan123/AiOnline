# BACKUP.md — Moling AI Database Backup

## Overview

Moling AI uses PostgreSQL as the authoritative source of truth for all durable state. Backup tooling is provided via Node.js scripts that work without requiring `pg_dump` locally (Windows-friendly).

## Commands

```bash
# Create backup
npm run backup:db -- --db <database_name> --output <backup_dir>

# Verify backup integrity
npm run backup:verify <backup_dir>

# Restore to new database (TEST ONLY)
npm run restore:db -- --backup <backup_dir> --db <target_db_name> --allow-overwrite-test

# Full DR drill (seed → backup → restore → parity → verify)
npm run dr:test
```

## Backup Format

Each backup produces:

```
YYYYMMDD-HHMMSS/
  manifest.json        # Backup metadata (no secrets)
  schema-meta.json     # Table column definitions + primary keys
  data.json            # Full table row data
  checksums.sha256     # SHA256 of schema-meta.json and data.json
```

## Safety Rules

- Backup script warns about non-test databases but does not block
- Restore script REJECTS any database name that does not contain `test`, `restore`, `dr`, or `backup`
- Restore script REJECTS overwriting non-empty databases unless `--allow-overwrite-test` is passed
- Never backup/restore production databases from this workstation

## Backup Directory

Test backups go to:
```
C:\Users\Administrator\hermes-backups\github_ai_online\phase1-step6\
```

Backup files are marked SENSITIVE — do not commit to Git.

## Retention Policy (Planned)

| Type | Count | Notes |
|------|-------|-------|
| Daily | 7 | Automated |
| Weekly | 4 | Automated |
| Monthly | 3 | Automated |
| Pre-deploy | 3 | Manual |
| Pre-migration | Always | Manual — never delete before verifying migration success |

## Security

- Backup files contain DB data including user emails, credit balances, and potentially hashed passwords
- BACKUP_AT_REST_ENCRYPTION_REQUIRED_FOR_PRODUCTION = YES (Phase 1.5 requirement)
- Secrets (JWT, API keys, OSS credentials) are stored in DB tables but NOT written to manifest
- Production backups require encrypted storage and off-site replication

## Restore Testing

Run `npm run dr:test` regularly to verify restore capability. Last verified: 2026-08-23.

## Limitations

- Logical backup (no pg_dump custom format on Windows)
- FK constraints not captured in DDL — tables with FK dependencies may not be recreated
- For production restores, use `pg_dump -Fc` / `pg_restore` on the PostgreSQL host
- RTO ≈ 15-30s for test data; production RTO depends on DB size
