-- 0016_episodes
-- M05-E: episodes table for short-drama workflow.
-- Each episode is linked to one canvas (the storyboard layout), one project,
-- one workspace. Status transitions: draft -> published (irreversible).
-- Archived episodes do not compete for seq slots (unique index is partial).

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY DEFAULT 'ep-' || gen_random_uuid()::text,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canvas_id TEXT NOT NULL REFERENCES studio_canvases(id) ON DELETE CASCADE,
  seq INT NOT NULL CHECK (seq >= 1),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  meta JSONB NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_episodes_project_seq
  ON episodes(project_id, seq) WHERE status != 'archived';

CREATE INDEX IF NOT EXISTS ix_episodes_project
  ON episodes(project_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_episodes_canvas
  ON episodes(canvas_id);
