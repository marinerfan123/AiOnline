-- 0015_studio_run_engine
-- M05-D1: durable Studio DAG core.
-- PostgreSQL is the durable scheduling authority for Studio Runs.
-- Safety: expand-first, forward-only, additive. No changes to legacy V1,
-- Generation V2, billing, or M05-C canvas authority.

CREATE TABLE IF NOT EXISTS studio_runs (
  id TEXT PRIMARY KEY DEFAULT 'run-' || gen_random_uuid()::text,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canvas_id TEXT NOT NULL REFERENCES studio_canvases(id) ON DELETE CASCADE,
  canvas_revision INT NOT NULL CHECK (canvas_revision >= 1),
  canvas_schema_version INT NOT NULL CHECK (canvas_schema_version >= 1),
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','RUNNING','WAITING','COMPLETED','FAILED','CANCELLED','BLOCKED')),
  run_mode TEXT NOT NULL DEFAULT 'ALL' CHECK (run_mode IN ('ALL','SELECTED','FROM_NODE')),
  compiled_graph_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_code TEXT,
  failure_message TEXT,
  node_status_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  nodes_total INT NOT NULL DEFAULT 0,
  executor_unavailable BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (canvas_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ix_studio_runs_project ON studio_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_studio_runs_workspace ON studio_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_studio_runs_status_created ON studio_runs(status, created_at DESC);
-- Idempotency scope is (canvas_id, idempotency_key) — defined inline on the
-- table and matched by the engine's ON CONFLICT target. A project-level
-- idempotency unique would over-constrain: the same client key is legal on
-- two different canvases of one project, and the engine's trust boundary is
-- the canvas row, not the project row.

-- Durable per-node scheduling state. Normalized columns (counters, lease,
-- retry) are the worker hot path — workers never re-parse compiled_graph_json.
CREATE TABLE IF NOT EXISTS studio_run_nodes (
  id TEXT PRIMARY KEY DEFAULT 'srn-' || gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES studio_runs(id) ON DELETE CASCADE,
  studio_node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  execution_kind TEXT NOT NULL
    CHECK (execution_kind IN ('SOURCE','TRANSFORM','GENERATION','ASSET','OUTPUT','STRUCTURAL')),
  status TEXT NOT NULL DEFAULT 'BLOCKED'
    CHECK (status IN ('BLOCKED','READY','LEASED','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED','SKIPPED')),
  dependency_count INT NOT NULL DEFAULT 0 CHECK (dependency_count >= 0),
  remaining_dependency_count INT NOT NULL DEFAULT 0 CHECK (remaining_dependency_count >= 0),
  attempt INT NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INT NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, studio_node_id)
);
CREATE INDEX IF NOT EXISTS ix_studio_run_nodes_run ON studio_run_nodes(run_id);
CREATE INDEX IF NOT EXISTS ix_studio_run_nodes_run_status ON studio_run_nodes(run_id, status);
CREATE INDEX IF NOT EXISTS ix_studio_run_nodes_lease_ready ON studio_run_nodes (run_id, next_retry_at, created_at) WHERE status = 'READY';
CREATE INDEX IF NOT EXISTS ix_studio_run_nodes_ready_eligible ON studio_run_nodes (next_retry_at, created_at) WHERE status = 'READY';
CREATE INDEX IF NOT EXISTS ix_studio_run_nodes_lease_expires ON studio_run_nodes (status, lease_expires_at) WHERE status IN ('LEASED','RUNNING','WAITING');

-- Normalized dependency edges of the immutable run graph. Justified:
-- fan-out decrement (STEP 35) and reaper/aggregate paths need set-based
-- propagation WITHOUT re-parsing compiled_graph_json on every completion.
CREATE TABLE IF NOT EXISTS studio_run_node_edges (
  run_id TEXT NOT NULL REFERENCES studio_runs(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  UNIQUE (run_id, source_node_id, target_node_id),
  CONSTRAINT fk_studio_run_node_edges_source FOREIGN KEY (run_id, source_node_id) REFERENCES studio_run_nodes(run_id, studio_node_id) ON DELETE CASCADE,
  CONSTRAINT fk_studio_run_node_edges_target FOREIGN KEY (run_id, target_node_id) REFERENCES studio_run_nodes(run_id, studio_node_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_studio_run_node_edges_source ON studio_run_node_edges (run_id, source_node_id);
CREATE INDEX IF NOT EXISTS ix_studio_run_node_edges_target ON studio_run_node_edges (run_id, target_node_id);

-- Minimal durable domain event trail (no Kafka / distributed bus).
-- Restart-safe observability + foundation for M05-D2 run SSE; payloads are
-- sanitized (ids/statuses only — no prompts, secrets, or signed URLs).
CREATE TABLE IF NOT EXISTS studio_run_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES studio_runs(id) ON DELETE CASCADE,
  run_node_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_studio_run_events_run ON studio_run_events(run_id, id);
CREATE INDEX IF NOT EXISTS ix_studio_run_events_type ON studio_run_events(event_type, created_at DESC);
