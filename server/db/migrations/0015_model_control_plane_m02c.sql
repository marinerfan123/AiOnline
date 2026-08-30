-- 0015: M02-C Model Control Plane — versioned revisions, entitlements, durable routing policy
-- Forward-only, idempotent (IF NOT EXISTS everywhere). Adds control-plane metadata
-- on top of 0010 (M02-A) / 0011 (M02-B). Does not alter or drop any legacy /
-- Generation-V2 column. No data migration: existing models keep working; revision
-- publishing is opt-in (publish creates revision 1).
--
-- Authority decisions (see docs/system-v2/modules/M02C-model-control-plane.md):
--   * ai_model_revisions = IMMUTABLE model revision manifests. A row is never
--     updated (content + content_hash are frozen at publish time); a new
--     revision supersedes the active one. content_hash = sha256 of the
--     canonical manifest, so any consumer (billing, audit, router) can verify
--     exactly which model definition a generation was created under.
--   * ai_model_capability_grants = workspace/user entitlements. Grant rows are
--     optional: with NO grant rows for a model the model is OPEN (backward
--     compatible); once any grant row exists the model is ENFORCED and
--     unmatched users are denied (default-deny inside the enforced set).
--   * ai_routing_policy = DURABLE canary/routing metadata. The DB is the
--     authority for canary state; process memory may cache but is never
--     authoritative. One active policy per (model, capability, target binding).
--   * ai_routing_decisions gains two nullable audit columns (routing_policy,
--     model_revision_id) so each recorded decision can be traced to the policy
--     and model revision it ran under.

-- === 1) Immutable model revision manifests ===
CREATE TABLE IF NOT EXISTS ai_model_revisions (
  id TEXT PRIMARY KEY DEFAULT ('mr-' || replace(gen_random_uuid()::text, '-', '')),
  model_id TEXT NOT NULL,
  revision INT NOT NULL,
  content_hash TEXT NOT NULL,
  manifest JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  supersedes TEXT,
  published_by TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  UNIQUE (model_id, revision)
);
CREATE INDEX IF NOT EXISTS ix_mrevisions_model_status ON ai_model_revisions(model_id, status);
CREATE INDEX IF NOT EXISTS ix_mrevisions_model_rev ON ai_model_revisions(model_id, revision DESC);

-- === 2) Workspace / user capability entitlements ===
CREATE TABLE IF NOT EXISTS ai_model_capability_grants (
  id TEXT PRIMARY KEY DEFAULT ('mcg-' || replace(gen_random_uuid()::text, '-', '')),
  workspace_id TEXT,
  user_id TEXT,
  model_id TEXT NOT NULL,
  capability TEXT,
  status TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  granted_by TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mcg_ws ON ai_model_capability_grants(workspace_id, model_id);
CREATE INDEX IF NOT EXISTS ix_mcg_user ON ai_model_capability_grants(user_id, model_id);
CREATE INDEX IF NOT EXISTS ix_mcg_model ON ai_model_capability_grants(model_id);

-- === 3) Durable routing (canary) policy — DB is the authority ===
CREATE TABLE IF NOT EXISTS ai_routing_policy (
  id TEXT PRIMARY KEY DEFAULT ('mrp-' || replace(gen_random_uuid()::text, '-', '')),
  model_id TEXT NOT NULL,
  capability TEXT,
  target_binding_id TEXT NOT NULL,
  percent INT NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  salt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  revision INT NOT NULL DEFAULT 1,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mrpol_model ON ai_routing_policy(model_id, status);
-- Dedupe: exactly one policy per (model, capability, target) and per (model, target)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mrpol_scoped ON ai_routing_policy(model_id, capability, target_binding_id) WHERE capability IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mrpol_allcaps ON ai_routing_policy(model_id, target_binding_id) WHERE capability IS NULL;

-- === 4) Routing decision audit: bind decisions to policy + model revision ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ai_routing_decisions' AND column_name='routing_policy') THEN
    ALTER TABLE ai_routing_decisions ADD COLUMN routing_policy JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ai_routing_decisions' AND column_name='model_revision_id') THEN
    ALTER TABLE ai_routing_decisions ADD COLUMN model_revision_id TEXT;
  END IF;
END $$;
