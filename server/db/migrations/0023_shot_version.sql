-- 0023_shot_version
-- W1-10: optimistic concurrency for Shot updates (additive version column).
-- Also indexes the Shot's project-scoped ordering (episode, seq) for deterministic ordering.

ALTER TABLE shots ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS ix_shots_project_seq
  ON shots(episode_id, seq);

COMMENT ON COLUMN shots.version IS 'W1-10 optimistic-update version (bumped on each write; 409 on stale update)';
