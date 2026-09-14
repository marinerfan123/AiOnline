-- 0027_characters
-- W2-01: project-scoped Character authority — canonical appearance, references, wardrobe /
--        current wardrobe, voice and state persist under workspace/project scope.

CREATE TABLE IF NOT EXISTS project_characters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  canonical_appearance JSONB NOT NULL DEFAULT '{}'::jsonb,
  reference_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  wardrobe JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_wardrobe JSONB NOT NULL DEFAULT '{}'::jsonb,
  voice JSONB NOT NULL DEFAULT '{}'::jsonb,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_characters_project ON project_characters (project_id);
CREATE INDEX IF NOT EXISTS ix_characters_workspace ON project_characters (workspace_id);
