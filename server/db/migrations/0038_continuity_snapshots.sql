-- G14 — Continuity persistence (03 §2 production_continuity_snapshots) + character aliases (02 §19).
-- Derived/validated continuity state becomes a per-shot DB row (shot is the
-- single continuity anchor), instead of living only in derivedAt memory.

CREATE TABLE IF NOT EXISTS production_continuity_snapshots (
  shot_id            TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  mode               TEXT NOT NULL DEFAULT 'narrative',
  character_states   JSONB NOT NULL DEFAULT '[]'::jsonb,
  environment_states JSONB NOT NULL DEFAULT '[]'::jsonb,
  source             TEXT NOT NULL DEFAULT 'derive',   -- derive | manual | provider
  captured_by        TEXT,
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_continuity_project ON production_continuity_snapshots (project_id);

-- Character aliases: additive on project_characters (0027); @-resolver match
-- surface (alias array) per Blueprint 02 §19 UX.
ALTER TABLE project_characters ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb;
