-- 0035_project_manager_v2
-- MOLING_STUDIO_MASTER_BLUEPRINT_V2.0 — G01 Workspace/Project Manager.
-- ADDITIVE / forward-only: folders + recycle bin + recent + project format version.
-- Does not alter or drop any existing column/table. Legacy rows keep working
-- (new projects columns carry defaults; folder_id NULL = root).

CREATE TABLE IF NOT EXISTS workspace_folders (
  id TEXT PRIMARY KEY DEFAULT 'folder-' || gen_random_uuid()::text,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active folder name per (workspace, parent). Soft-deleted rows excluded so
-- a recycled folder's name can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_folders_active_name
  ON workspace_folders(workspace_id, parent_id, name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_workspace_folders_workspace
  ON workspace_folders(workspace_id, parent_id);

-- Project manager extensions (all additive).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS folder_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS schema_version INT NOT NULL DEFAULT 1 CHECK (schema_version >= 1);

CREATE INDEX IF NOT EXISTS ix_projects_folder ON projects(workspace_id, folder_id);
CREATE INDEX IF NOT EXISTS ix_projects_deleted ON projects(workspace_id, deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_projects_last_opened ON projects(workspace_id, last_opened_at DESC NULLS LAST);
