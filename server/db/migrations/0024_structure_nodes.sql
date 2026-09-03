-- 0024_structure_nodes
-- W1-12/W1-13: durable, ordered, project-scoped structure hierarchy that converges on Shot.
-- A leaf node of type 'shot' references a shots row; internal nodes are acts/scenes/etc. per project mode.

CREATE TABLE IF NOT EXISTS project_structure_nodes (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  parent_id UUID,
  type TEXT NOT NULL,           -- narrative: story/act/sequence/scene/shot ; ad : brief/concept/sequence/scene/shot ; ecom : product/selling_point/segment/scene/shot
  order_index INT NOT NULL DEFAULT 0,
  shot_id UUID,
  label TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_structure_project_order ON project_structure_nodes(project_id, parent_id, order_index);
CREATE INDEX IF NOT EXISTS ix_structure_project_shot ON project_structure_nodes(project_id, shot_id);
