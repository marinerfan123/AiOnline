-- 0010: M02-A AI Control Plane Foundation schema
-- Forward, idempotent (IF NOT EXISTS throughout). Adds control-plane metadata
-- WITHOUT touching generation business schema (0002 *_v2 tables are untouched)
-- and without dropping/renaming any legacy column (Phase-1 iron rule).
--
-- Authority decisions (see docs/system-v2/modules/M02A-ai-control-foundation.md):
--   * api_keys remains the single business authority for provider credentials.
--     We only ADD runtime-projection columns (rpm/concurrency/cooldown/last_used/
--     last_error/updated_at) so the key-pool domain can be persisted/audited.
--     The full secret stays in api_key; these columns never contain it.
--   * Capability registry lives ON the logical model row (models.ai_capabilities /
--     ai_parameter_schemas) — no parallel capability table. Provider bindings can
--     only NARROW capabilities, never extend them.
--   * ai_routing_decisions = auditable routing decision log (one row per decision).
--   * ai_provider_health = derived health snapshot (5-state model), contract stage.
--
-- Rollback: DROP the new columns/tables (none are referenced by legacy runtime).

-- === 1) Logical-model capability registry (structured, versionable, validated by
--      domain/capability.cjs before write) ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='ai_capabilities') THEN
    ALTER TABLE models ADD COLUMN ai_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='ai_parameter_schemas') THEN
    ALTER TABLE models ADD COLUMN ai_parameter_schemas JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='capability_version') THEN
    ALTER TABLE models ADD COLUMN capability_version INT NOT NULL DEFAULT 1;
  END IF;
END $$;

-- === 2) Key-pool runtime projection columns (no secret; audit/UI state) ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_keys' AND column_name='rpm') THEN
    ALTER TABLE api_keys ADD COLUMN rpm INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_keys' AND column_name='concurrency') THEN
    ALTER TABLE api_keys ADD COLUMN concurrency INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_keys' AND column_name='cooldown_until') THEN
    ALTER TABLE api_keys ADD COLUMN cooldown_until TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_keys' AND column_name='last_used_at') THEN
    ALTER TABLE api_keys ADD COLUMN last_used_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_keys' AND column_name='last_error_code') THEN
    ALTER TABLE api_keys ADD COLUMN last_error_code TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_keys' AND column_name='health') THEN
    ALTER TABLE api_keys ADD COLUMN health TEXT NOT NULL DEFAULT 'UNKNOWN'
      CHECK (health IN ('UNKNOWN','HEALTHY','DEGRADED','UNHEALTHY','DISABLED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_keys' AND column_name='updated_at') THEN
    ALTER TABLE api_keys ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_api_keys_provider_status_upd ON api_keys(provider_id, status) WHERE status = 'active';

-- === 3) Routing decision audit log (one row per routing_decision_id) ===
CREATE TABLE IF NOT EXISTS ai_routing_decisions (
  id TEXT PRIMARY KEY DEFAULT ('rd-' || replace(gen_random_uuid()::text, '-', '')),
  model_id TEXT NOT NULL,
  capability TEXT,
  region TEXT,
  selected_binding_id TEXT,
  selected_provider_id TEXT,
  reason TEXT,
  fallback_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  rejected JSONB NOT NULL DEFAULT '[]'::jsonb,
  weights JSONB,
  seed INT,
  request_id TEXT,
  generation_task_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_aicrd_model ON ai_routing_decisions(model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_aicrd_task ON ai_routing_decisions(generation_task_id) WHERE generation_task_id IS NOT NULL;

-- === 4) Provider health snapshot (5-state derived; contract stage, M02-D engine) ===
CREATE TABLE IF NOT EXISTS ai_provider_health (
  provider_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (state IN ('UNKNOWN','HEALTHY','DEGRADED','UNHEALTHY','DISABLED')),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  circuit_state TEXT,
  success_rate NUMERIC,
  p95_latency_ms INT,
  rate_limited BOOLEAN,
  key_availability NUMERIC,
  consecutive_failures INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_aiph_state ON ai_provider_health(state);
