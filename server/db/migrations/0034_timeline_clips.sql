-- 0034_timeline_clips
-- W5-01: Timeline/track/clip schema — project-scoped editing timeline of selected Shot assets.
--        Clips bind to Shot asset versions (W3-13) with track + order + in/out timing.

CREATE TABLE IF NOT EXISTS project_timeline (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE TABLE IF NOT EXISTS timeline_tracks (id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL REFERENCES project_timeline(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'video', order_index INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE TABLE IF NOT EXISTS timeline_clips (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES timeline_tracks(id) ON DELETE CASCADE,
  shot_id TEXT,
  asset_version_id TEXT,
  order_index INT NOT NULL DEFAULT 0,
  start_ms BIGINT NOT NULL DEFAULT 0,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_timeline_clips_track ON timeline_clips (track_id, order_index);
