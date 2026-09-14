-- 0017_shots
-- M05-E: shots table for episode-level shot timeline.
-- Each shot maps one canvas_node to a sequence position within an episode.

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY DEFAULT 'shot-' || gen_random_uuid()::text,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  canvas_node_id TEXT NOT NULL,
  seq INT NOT NULL CHECK (seq >= 1),
  asset_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  duration_seconds INT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_shots_episode
  ON shots(episode_id, seq);

CREATE INDEX IF NOT EXISTS ix_shots_node
  ON shots(canvas_node_id);
