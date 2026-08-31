# Migration Rollback Policy

## Classification Framework

All migrations are classified as either **REVERSIBLE** or **IRREVERSIBLE**. This classification drives rollback strategy and CI gates.

### REVERSIBLE (schema-only, additive)

Migrations that ONLY add new tables, columns, or indexes without modifying existing data or schema structure.

**Criteria:**
- Uses `CREATE TABLE IF NOT EXISTS` only
- Uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` only
- Uses `CREATE INDEX IF NOT EXISTS` only
- No `DROP`, `ALTER ... DROP`, `ALTER ... ALTER COLUMN`, or data modification
- Checksum-stable: file content unchanged after application

**Rollback strategy:** Create a companion `DOWN` migration that drops the added objects. The down migration must be verified against a fresh migrated database before being applied.

**Examples in current chain:**
- `0001_baseline_legacy_schema.sql` — REVERSIBLE (all CREATE IF NOT EXISTS)
- `0002_generation_v2_schema.sql` — REVERSIBLE
- `0003_generation_v2_runtime_schema_parity.sql` — REVERSIBLE
- `0004_billing_transactional_integrity.sql` — REVERSIBLE
- `0005_legacy_image_client_request_id.sql` — REVERSIBLE
- `0006_create_api_keys_table.sql` — REVERSIBLE
- `0009_api_keys_pool_parity.sql` — REVERSIBLE
- `0010_ai_control_plane_foundation.sql` — REVERSIBLE
- `0012_project_workspace_foundation.sql` — REVERSIBLE
- `0014_studio_canvas_persistence.sql` — REVERSIBLE
- `0016_studio_run_engine.sql` — REVERSIBLE

### IRREVERSIBLE (data migration, structural change)

Migrations that modify existing data, drop columns/tables, or change schema in ways that cannot be automatically undone.

**Criteria (any one):**
- Uses `DROP TABLE`, `DROP COLUMN`, `ALTER TABLE ... DROP`
- Uses `ALTER TABLE ... ALTER COLUMN ... TYPE` or `SET NOT NULL`
- Performs data migration (`UPDATE`, `INSERT ... ON CONFLICT`, data backfill)
- References production data that cannot be restored from schema alone

**Rollback strategy:** NO automated rollback. Must declare explicit forward-fix or restore strategy:
1. **Forward-fix**: Apply a new migration that corrects the state
2. **Restore from backup**: Point-in-time recovery from known-good backup
3. **Data reconstruction**: Re-seed from canonical source

**Examples in current chain:**
- `0007_recharge_payment_tables.sql` — IRREVERSIBLE (may seed payment_settings)
- `0008_legacy_runtime_tables.sql` — IRREVERSIBLE (seeds cron_marker, feedback, reports)
- `0011_legacy_key_pool_backfill.sql` — IRREVERSIBLE (data migration from providers.api_key)
- `0013_asset_foundation.sql` — PARTIALLY IRREVERSIBLE (adds columns + indexes, backfills media.updated_at)

## Rollback Execution Rules

1. **Never auto-reverse**: No migration runner shall automatically generate or execute rollback SQL.
2. **Signed off**: Each rollback requires explicit approval (comment in migration file + human sign-off).
3. **Backed up**: Database backup must exist before any rollback execution.
4. **Verified**: Rollback must be tested on a replica/fresh DB matching production schema version.
5. **Documented**: Rollback procedure recorded in docs/migrations/rollbacks/.

## Version Allocation Rules (P1)

1. **Contiguous numbering**: Versions must increment by 1 from current head.
2. **Single writer**: One worktree owns one version at a time via reservation system.
3. **No gaps**: Skipping versions is prohibited. If a version is abandoned, document it and continue.
4. **Head anchor**: `0016_studio_run_engine.sql` is the current HEAD and must remain intact.
5. **History immutable**: Never renumber, rewrite, or remove applied migrations.

## CI Gate

The CI pipeline checks:
1. Migration files exist with valid 4-digit version format
2. No duplicate versions across worktrees (via reservation lock)
3. New migrations pass preflight (see preflight.md)
4. Rollback documentation exists for IRREVERSIBLE migrations
