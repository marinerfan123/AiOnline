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
Skill location: `~/AppData/Local/hermes/skills/software-development/generation-v2-testing/SKILL.md`
Modified sections: "Production Reconciliation Testing (R1-R12)" and "PostgreSQL Migration Testing (M1-M12)"
Resolution: No revert possible (no version history). Documented here as permanent rule.

## Architecture Decisions

- No Temporal — PostgreSQL V2 state machine is sufficient
- No ORM migrations — raw SQL with `server/db/migrate.cjs`
- PostgreSQL is source of truth for all generation state
- Billing invariants use `pg_advisory_xact_lock` for idempotency
- Redis is cache-only with graceful degradation to memory

## Test Strategy

- Canonical verify: `npm run verify`
- V2 tests: `--test-concurrency=1` (DB pollution prevention)
- API tests: isolated `moling_test` database, dynamic ports
- Migration tests: fresh DB per test with `CREATE/DROP DATABASE`
