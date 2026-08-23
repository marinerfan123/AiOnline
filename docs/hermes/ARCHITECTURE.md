# ARCHITECTURE.md — Moling AI

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Node.js 22 + Express (CommonJS)
- PostgreSQL: primary store, V2 state machine, authoritative source of truth
- Redis: cache only, rate limiting, graceful degradation to memory
- OSS: Aliyun OSS / Tencent COS (external object storage)

## V2 Generation

- PostgreSQL-backed durable workflow (no Temporal)
- State machine: queued → leased → generating → generated → uploading → done
- Billing: credit holds with pg_advisory_xact_lock for idempotency
- Redis: optional key lease acceleration, not authoritative

## Migrations

- server/db/migrate.cjs (advisory lock, checksum, transactional)
- server/db/migrations/*.sql (ordered by version prefix)
- Tracking: schema_migrations table
- Fail-closed: refuses production database names

## Backup / Restore

- scripts/backup-db.cjs: logical backup with schema metadata + checksums
- scripts/restore-db.cjs: DDL generation from schema metadata, safety guards
- scripts/verify-backup.cjs: manifest + SHA256 verification
- scripts/dr-drill.cjs: full DR drill (seed → backup → restore → parity)
- Limitations: FK constraints not captured; pg_dump preferred for production
- BACKUP_AT_REST_ENCRYPTION_REQUIRED_FOR_PRODUCTION: YES

## Security

- Redis is cache-only — V2 durable state survives Redis loss
- OSS is external — provider URLs stored in DB, objects in cloud storage
- Secrets in .env (not committed), DB tables (backed up but marked sensitive)
- .env.example: safe template with placeholder values
