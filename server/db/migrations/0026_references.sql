-- 0026_references
-- W2-03: first-class project References (Character/Environment/Product/Object/Style/Camera/
--        Composition/Motion/Brand/Audio), project-scoped, with role/source/membership.

CREATE TABLE IF NOT EXISTS project_references (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  source TEXT,
  source_id TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_references_project ON project_references (project_id);
CREATE INDEX IF NOT EXISTS ix_references_project_type ON project_references (project_id, type);
