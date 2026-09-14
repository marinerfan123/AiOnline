# DECISIONS.md — Engineering Decisions & Protocols

## Self-Modification Prohibition (2026-08-22)

During Moling project tasks, Hermes MUST NOT modify:
- Hermes skills
- Hermes system prompts
- Hermes policies
- Hermes permissions
- Hermes memory/configuration

unless a separate explicitly approved and versioned task is issued by the human operator.

Violation history: Step 3 patched `generation-v2-testing` SKILL.md without explicit approval.
Resolution: No revert possible. Documented here as permanent rule.

## Architecture Decisions

- No Temporal — PostgreSQL V2 state machine is sufficient
- No ORM migrations — raw SQL with `server/db/migrate.cjs`
- PostgreSQL is source of truth for all generation state
- Billing invariants use `pg_advisory_xact_lock` for idempotency
- Redis is cache-only with graceful degradation to memory
- Backup tooling uses logical backup (Node.js pg) — pg_dump preferred for production

## Test Strategy

- Canonical verify: `npm run verify`
- V2 tests: `--test-concurrency=1` (DB pollution prevention)
- API tests: isolated `moling_test` database, dynamic ports
- Migration tests: fresh DB per test with `CREATE/DROP DATABASE`
- DR tests: B1-B20, backup safety + restore parity + fail-closed
- Security tests: S1-S20, SSRF + auth + CORS + CSRF + secrets + payment

## Security Decisions (Step 7)

- SSRF: `ssrf.cjs` blocks private IPs, DNS rebinding, cloud metadata endpoints
- CORS: `CORS_ORIGIN` env required for production; same-origin only by default
- CSRF: `SameSite=Strict` on session cookies
- Secrets: crypto.cjs fail-closed on non-standard format (no plaintext passthrough)
- SIGN_SECRET: null instead of empty string (no forged signatures)
- Webhook errors: generic messages only (no DB internals leaked)
- Logbus: bounded dedup map (10000 entries, 60s TTL) prevents memory leak
- Admin SSE: CORS wildcards removed

## Migration Rollback Philosophy (Step 6)

- Forward migration preferred over DOWN migrations
- Destructive migrations use expand/contract strategy
- Database rollback only via verified backup restore (human-approved)
- Application rollback via Git/release rollback

## Backup Policy (Step 6)

- Backup before every production migration
- Backup before every production deployment
- Retention: daily 7, weekly 4, monthly 3, pre-deploy 3, pre-migration always
- BACKUP_AT_REST_ENCRYPTION_REQUIRED_FOR_PRODUCTION: YES (Phase 1.5)
- PITR: NOT_CONFIGURED (Phase 1.5 requirement)
