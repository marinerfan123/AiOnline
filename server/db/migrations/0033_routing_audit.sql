-- 0033_routing_audit
-- W3-06: routing decision audit record — selected/rejected candidates, scores/reasons,
--        policy/plan and timestamp, queryable by generation.

CREATE TABLE IF NOT EXISTS routing_audit (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  selected TEXT,
  rejected JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT,
  policy JSONB,
  plan TEXT,
  actor TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_routing_audit_generation ON routing_audit (generation_id);
