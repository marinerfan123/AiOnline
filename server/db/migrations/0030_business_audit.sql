-- 0030_business_audit
-- W2-11: transactional business audit trail for critical actions.
-- actor/workspace/object/before/after/action/timestamp recorded in the same txn as the write.

CREATE TABLE IF NOT EXISTS business_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  workspace_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_before JSONB,
  object_after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_audit_actor ON business_audit (actor);
CREATE INDEX IF NOT EXISTS ix_audit_object ON business_audit (object_type, object_id);
CREATE INDEX IF NOT EXISTS ix_audit_created ON business_audit (created_at DESC);
