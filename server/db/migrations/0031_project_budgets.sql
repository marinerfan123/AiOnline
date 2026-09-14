-- 0031_project_budgets
-- W3-09: project/workspace-scoped spend budget (overlay on existing user balance; balance stays
--        source of funds). Warning/approval thresholds are durable.

CREATE TABLE IF NOT EXISTS project_budgets (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  budget NUMERIC(18,4) NOT NULL,           -- spend ceiling for the project
  warning_threshold NUMERIC(18,4) NOT NULL DEFAULT 0.8,
  approval_threshold NUMERIC(18,4) NOT NULL DEFAULT 1.0,
  spent NUMERIC(18,4) NOT NULL DEFAULT 0,
  revised_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_project_budgets_workspace ON project_budgets (workspace_id);
