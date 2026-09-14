-- 0028_environments
-- W2-02: project-scoped Environment domain — master reference, geometry, props, lighting,
--        time-of-day, palette and generated views.

CREATE TABLE IF NOT EXISTS project_environments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  master_reference_id TEXT,
  geometry JSONB NOT NULL DEFAULT '{}'::jsonb,
  props JSONB NOT NULL DEFAULT '{}'::jsonb,
  lighting JSONB NOT NULL DEFAULT '{}'::jsonb,
  time_of_day TEXT,
  palette JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_views JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_environments_project ON project_environments (project_id);
CREATE INDEX IF NOT EXISTS ix_environments_workspace ON project_environments (workspace_id);
