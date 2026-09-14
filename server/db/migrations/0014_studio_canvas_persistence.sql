-- 0014_studio_canvas_persistence
-- M05-C: durable Studio Canvas persistence + immutable versions.
-- Safety: expand-first, forward-only, additive. Does not modify legacy V1 Canvas/media/generation authority.

CREATE TABLE IF NOT EXISTS studio_canvases (
  id TEXT PRIMARY KEY DEFAULT 'canvas-' || gen_random_uuid()::text,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Primary Canvas',
  revision INT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  schema_version INT NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  viewport_json JSONB,
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  restored_from_version_id TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_canvases_primary_project ON studio_canvases(project_id) WHERE is_primary = TRUE AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_studio_canvases_project ON studio_canvases(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_studio_canvases_workspace ON studio_canvases(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS studio_canvas_nodes (
  id TEXT PRIMARY KEY DEFAULT 'scn-' || gen_random_uuid()::text,
  canvas_id TEXT NOT NULL REFERENCES studio_canvases(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_schema_version INT NOT NULL DEFAULT 1 CHECK (node_schema_version >= 1),
  position_x DOUBLE PRECISION NOT NULL DEFAULT 0,
  position_y DOUBLE PRECISION NOT NULL DEFAULT 0,
  width DOUBLE PRECISION,
  height DOUBLE PRECISION,
  z_index INT,
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_canvas_nodes_canvas_node ON studio_canvas_nodes(canvas_id, node_id);
CREATE INDEX IF NOT EXISTS ix_studio_canvas_nodes_canvas ON studio_canvas_nodes(canvas_id);

CREATE TABLE IF NOT EXISTS studio_canvas_edges (
  id TEXT PRIMARY KEY DEFAULT 'sce-' || gen_random_uuid()::text,
  canvas_id TEXT NOT NULL REFERENCES studio_canvases(id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  source_handle TEXT,
  target_node_id TEXT NOT NULL,
  target_handle TEXT,
  edge_type TEXT,
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_studio_canvas_edges_source FOREIGN KEY (canvas_id, source_node_id) REFERENCES studio_canvas_nodes(canvas_id, node_id) ON DELETE CASCADE,
  CONSTRAINT fk_studio_canvas_edges_target FOREIGN KEY (canvas_id, target_node_id) REFERENCES studio_canvas_nodes(canvas_id, node_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_canvas_edges_canvas_edge ON studio_canvas_edges(canvas_id, edge_id);
CREATE INDEX IF NOT EXISTS ix_studio_canvas_edges_canvas ON studio_canvas_edges(canvas_id);
CREATE INDEX IF NOT EXISTS ix_studio_canvas_edges_source ON studio_canvas_edges(canvas_id, source_node_id);
CREATE INDEX IF NOT EXISTS ix_studio_canvas_edges_target ON studio_canvas_edges(canvas_id, target_node_id);

CREATE TABLE IF NOT EXISTS studio_canvas_versions (
  id TEXT PRIMARY KEY DEFAULT 'scv-' || gen_random_uuid()::text,
  canvas_id TEXT NOT NULL REFERENCES studio_canvases(id) ON DELETE CASCADE,
  revision INT NOT NULL,
  version_number INT NOT NULL,
  name TEXT,
  description TEXT,
  snapshot_json JSONB NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  restore_source_version_id TEXT REFERENCES studio_canvas_versions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (canvas_id, version_number)
);
CREATE INDEX IF NOT EXISTS ix_studio_canvas_versions_canvas_created ON studio_canvas_versions(canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_studio_canvas_versions_canvas_revision ON studio_canvas_versions(canvas_id, revision DESC);

CREATE TABLE IF NOT EXISTS studio_canvas_mutations (
  id TEXT PRIMARY KEY DEFAULT 'scm-' || gen_random_uuid()::text,
  canvas_id TEXT NOT NULL REFERENCES studio_canvases(id) ON DELETE CASCADE,
  client_mutation_id TEXT NOT NULL,
  base_revision INT NOT NULL,
  resulting_revision INT NOT NULL,
  response_json JSONB NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (canvas_id, client_mutation_id)
);
CREATE INDEX IF NOT EXISTS ix_studio_canvas_mutations_canvas_created ON studio_canvas_mutations(canvas_id, created_at DESC);
