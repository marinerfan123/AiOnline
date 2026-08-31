# Migration Governance

## Overview

This document establishes the governance rules for PostgreSQL schema migrations in the Moling AI Product P1 codebase.

## Current State

| Field | Value |
|-------|-------|
| Current HEAD | `0016_studio_run_engine.sql` |
| Total migrations | 15 |
| Next available | `0017` |
| Historical gap | `0015` (recorded; never backfilled) |
| Anchor version | `0016` (Phase-1 Canvas, immutable) |

## Immutable Rules

1. **Never renumber** applied migrations
2. **Never rewrite** historical migration content
3. **Never delete** migration files
4. **Never execute** migrations against production from this workflow
5. **One writer per version** — atomic directory lock plus atomic registry replacement
6. **Never backfill a historical gap** — new P1 allocation is numeric-head + 1

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Inventory | `server/db/migration-inventory.cjs` | Read-only snapshot of all migrations |
| Allocator | `server/db/migration-allocator.cjs` | Version reservation & conflict prevention |
| Preflight | `server/db/migration-preflight.cjs` | Validates new migrations before entry |
| Rollback Policy | `docs/migrations/rollback-policy.md` | Classification & rollback strategy |

## Workflow

### Creating a new migration

```bash
# 1. Claim a version
node server/db/migration-allocator.cjs acquire 0017 my-worktree "Add new feature"

# 2. Create the migration file
# server/db/migrations/0017_feature_name.sql

# 3. Run preflight check
node server/db/migration-preflight.cjs \
  --file server/db/migrations/0017_feature_name.sql \
  --require-reservation

# 4. If IRREVERSIBLE, create rollback doc
# docs/migrations/rollbacks/0017_feature_name.md

# 5. Commit (only your worktree's files)
git add server/db/migrations/0017_feature_name.sql
git commit -m "feat: add 0017_feature_name"

# 6. Release reservation
node server/db/migration-allocator.cjs release 0017 my-worktree
```

### Checking status

```bash
# View all migrations
node server/db/migration-inventory.cjs

# View active reservations
node server/db/migration-allocator.cjs status

# List reservations
node server/db/migration-allocator.cjs list
```

## CI Gate

Reservation verification is fail-closed and enabled by default. Local analysis
may opt out only with `--no-require-reservation`; CI must never use that option.

## Concurrency and lock limitations

The JSON registry is protected by atomic `mkdir` and written via a
same-directory temporary file followed by atomic rename. It requires a
filesystem that guarantees those operations; object storage and weak network
filesystems are unsupported. A killed lock holder can leave `<registry>.lock`;
an operator must confirm the owner is dead before removing it. The allocator
times out rather than stealing the lock.

Preflight rejects migration-owned transaction control and warns on `ALTER
TABLE` and non-concurrent index creation. These are static heuristics, not a
production lock simulation; table size, lock timeout and rollout review remain
mandatory.

The CI pipeline runs `migration-preflight.cjs` on all new `.sql` files:

```yaml
- name: Migration Preflight
  run: |
    node server/db/migration-preflight.cjs \
      --file server/db/migrations/${{ env.NEW_MIGRATION }} \
      --require-reservation
```

## Rollback Classification

See `docs/migrations/rollback-policy.md` for full classification rules.

### Current Chain Analysis

| Version | File | Classification | Notes |
|---------|------|----------------|-------|
| 0001 | baseline_legacy_schema | REVERSIBLE | All CREATE IF NOT EXISTS |
| 0002 | generation_v2_schema | REVERSIBLE | Additive schema |
| 0003 | generation_v2_runtime_schema_parity | REVERSIBLE | Indexes only |
| 0004 | billing_transactional_integrity | REVERSIBLE | Constraints only |
| 0005 | legacy_image_client_request_id | REVERSIBLE | Add column |
| 0006 | create_api_keys_table | REVERSIBLE | New table |
| 0007 | recharge_payment_tables | IRREVERSIBLE | May seed data |
| 0008 | legacy_runtime_tables | IRREVERSIBLE | Seeds cron_marker, feedback |
| 0009 | api_keys_pool_parity | REVERSIBLE | Add columns + index |
| 0010 | ai_control_plane_foundation | REVERSIBLE | New tables only |
| 0011 | legacy_key_pool_backfill | IRREVERSIBLE | Data migration |
| 0012 | project_workspace_foundation | REVERSIBLE | New tables |
| 0013 | asset_foundation | PARTIALLY IRREVERSIBLE | Adds columns + backfills |
| 0014 | studio_canvas_persistence | REVERSIBLE | New tables |
| 0016 | studio_run_engine | REVERSIBLE | New tables (anchor) |
