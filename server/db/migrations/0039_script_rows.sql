-- G13 — Script/Storyboard Phase-1: per-row script model (Blueprint 04 Script section).
-- A script becomes an ordered, per-scene set of typed rows (dialogue / action /
-- transition / parenthetical / header / shot_direction). Scenes are positional
-- (scene_index), not yet linked to episodes/shots; a later migration will bind
-- rows to shots when the script/storyboard link solidifies. Times are integer
-- milliseconds (project-wide convention).

CREATE TABLE IF NOT EXISTS script_rows (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  episode_id       TEXT,
  scene_index      INT NOT NULL DEFAULT 0,
  row_index        INT NOT NULL DEFAULT 0,
  kind             TEXT NOT NULL DEFAULT 'dialogue'
                   CHECK (kind IN ('dialogue','action','transition','parenthetical','header','shot_direction')),
  speaker          TEXT,
  text             TEXT NOT NULL,
  beat             TEXT,
  timing_ms        BIGINT,
  continuity_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup path: one project/episode's rows in scene-then-row order.
CREATE INDEX IF NOT EXISTS idx_script_rows_project_episode_scene_row
  ON script_rows (project_id, episode_id, scene_index, row_index);
