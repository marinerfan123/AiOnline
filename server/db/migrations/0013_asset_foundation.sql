-- 0013_asset_foundation
-- M04-S: evolve `media` into the authoritative Asset entity (additive only) and
-- add the canonical project↔asset relation.
--
-- Safety:
--   - Idempotent (IF NOT EXISTS throughout).
--   - Forward-only; does not alter 0001-0012.
--   - All new media columns are NULLABLE with no NOT NULL constraints —
--     existing legacy rows remain valid and unmodified (no backfill required;
--     the V2 API derives legacy status/type/origin at read time).
--   - No drops, no renames, no type changes. Legacy /api/media* DML is
--     untouched and keeps working against the same table.
--   - project_assets is a new relation table (NOT project JSONB); it can
--     later grow version/lineage columns without re-identifying anything.

-- === media → Asset evolution (additive) ===
ALTER TABLE media ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS width INT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS height INT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS duration_ms INT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS generation_batch_id TEXT;
-- updated_at is required for the Asset contract and newest-first asset lists.
-- Backfill ONLY NULL values: on databases where a prior hotfix/runtime already
-- wrote a real media.updated_at, M04-S must not collapse that semantic history
-- back to created_at.
ALTER TABLE media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
UPDATE media SET updated_at = COALESCE(created_at, NOW()) WHERE updated_at IS NULL;

-- FKs are intentionally NOT added (media.task_id precedent; legacy rows have
-- empty-string task ids that would violate a strict FK, and legacy DML writes
-- media rows with arbitrary ids). Referential integrity for NEW rows is
-- enforced at the API layer (assetFoundation validates project/workspace/
-- owner before writing).

-- === Fast query paths (100k+ assets per workspace architecture-safe) ===
CREATE INDEX IF NOT EXISTS ix_media_project ON media (project_id) WHERE project_id IS NOT NULL AND project_id <> '';
CREATE INDEX IF NOT EXISTS ix_media_workspace ON media (workspace_id) WHERE workspace_id IS NOT NULL AND workspace_id <> '';
CREATE INDEX IF NOT EXISTS ix_media_owner_project ON media (user_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_media_project_updated ON media (project_id, updated_at DESC) WHERE project_id IS NOT NULL AND project_id <> '';
CREATE INDEX IF NOT EXISTS ix_media_owner_status ON media (user_id, status, is_deleted);

-- === Canonical project ↔ asset membership ===
CREATE TABLE IF NOT EXISTS project_assets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,          -- media.id (stable asset identity)
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, asset_id)
);
CREATE INDEX IF NOT EXISTS ix_project_assets_asset ON project_assets (asset_id);
