-- harness/fixtures/schema.sql
-- Minimal schema for Golden Path harness testing
-- This is a skeleton; later stages will extend as needed.

-- Projects table (simplified)
CREATE TABLE IF NOT EXISTS golden_path_projects (
  id TEXT PRIMARY KEY,
  path_id TEXT NOT NULL,  -- 'GP01' | 'GP02' | 'GP03'
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|completed|failed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB
);

-- Steps table (tracks progress per project)
CREATE TABLE IF NOT EXISTS golden_path_steps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES golden_path_projects(id),
  step_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|passed|failed|not_ready
  evidence_file TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for querying project steps
CREATE INDEX IF NOT EXISTS idx_gp_steps_project ON golden_path_steps(project_id);
