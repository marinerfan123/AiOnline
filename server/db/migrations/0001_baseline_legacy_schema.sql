-- 0001_baseline_legacy_schema
-- Captures all runtime DDL from server/server.js as a single idempotent migration.
-- Safe to run on both fresh and existing databases (IF NOT EXISTS throughout).

-- === Core tables ===
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'official',
  base_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  supported_types TEXT[] DEFAULT '{}',
  enabled BOOLEAN DEFAULT TRUE,
  protocol TEXT DEFAULT 'openai-compatible',
  remark TEXT DEFAULT '',
  default_endpoint JSONB DEFAULT '{}',
  capacity_model TEXT DEFAULT 'limited',
  bucket_max INT,
  cooldown_ms INT DEFAULT 60000,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mapping_name TEXT DEFAULT '',
  type TEXT DEFAULT 'image',
  provider_id TEXT REFERENCES providers(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT TRUE,
  supported_resolutions TEXT[] DEFAULT '{}',
  capabilities JSONB DEFAULT '{}',
  endpoint JSONB DEFAULT '{}',
  param_template JSONB DEFAULT '{}'::jsonb,
  credit_cost NUMERIC(18,4) DEFAULT 0,
  supports_reward_balance BOOLEAN NOT NULL DEFAULT TRUE,
  reward_credits_required NUMERIC(18,4) NOT NULL DEFAULT 0,
  max_concurrent INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  type TEXT DEFAULT 'image',
  thumbnail TEXT DEFAULT '',
  full_url TEXT DEFAULT '',
  prompt TEXT DEFAULT '',
  model TEXT DEFAULT '',
  ratio TEXT DEFAULT '1:1',
  source TEXT DEFAULT 'user',
  is_favorite BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  oss_url TEXT DEFAULT '',
  oss_object_key TEXT DEFAULT '',
  oss_uploaded BOOLEAN DEFAULT FALSE,
  category TEXT DEFAULT 'generated',
  status TEXT DEFAULT 'success',
  error_message TEXT DEFAULT '',
  failed_at TIMESTAMPTZ,
  file_size BIGINT,
  task_id TEXT DEFAULT '',
  provider_url TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- === Forward-compat: add missing columns safely ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='status') THEN ALTER TABLE media ADD COLUMN status TEXT DEFAULT 'success'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='error_message') THEN ALTER TABLE media ADD COLUMN error_message TEXT DEFAULT ''; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='failed_at') THEN ALTER TABLE media ADD COLUMN failed_at TIMESTAMPTZ; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='file_size') THEN ALTER TABLE media ADD COLUMN file_size BIGINT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='character_id') THEN ALTER TABLE media ADD COLUMN character_id TEXT DEFAULT NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='task_id') THEN ALTER TABLE media ADD COLUMN task_id TEXT DEFAULT ''; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='provider_url') THEN ALTER TABLE media ADD COLUMN provider_url TEXT DEFAULT ''; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='mapping_name') THEN ALTER TABLE models ADD COLUMN mapping_name TEXT DEFAULT ''; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='credit_cost') THEN ALTER TABLE models ADD COLUMN credit_cost NUMERIC(18,4) DEFAULT 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='estimated_seconds') THEN ALTER TABLE models ADD COLUMN estimated_seconds INT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='category') THEN ALTER TABLE models ADD COLUMN category TEXT DEFAULT ''; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='creator') THEN ALTER TABLE models ADD COLUMN creator JSONB DEFAULT '{}'::jsonb; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='commercial_use') THEN ALTER TABLE models ADD COLUMN commercial_use BOOLEAN; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='max_concurrent') THEN ALTER TABLE models ADD COLUMN max_concurrent INT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='supports_reward_balance') THEN ALTER TABLE models ADD COLUMN supports_reward_balance BOOLEAN NOT NULL DEFAULT TRUE; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='reward_credits_required') THEN ALTER TABLE models ADD COLUMN reward_credits_required NUMERIC(18,4) NOT NULL DEFAULT 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='sort_order') THEN ALTER TABLE models ADD COLUMN sort_order INT NOT NULL DEFAULT 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='param_template') THEN ALTER TABLE models ADD COLUMN param_template JSONB DEFAULT '{}'::jsonb; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='revision') THEN ALTER TABLE providers ADD COLUMN revision INT NOT NULL DEFAULT 1; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='updated_at') THEN ALTER TABLE providers ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW(); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='updated_by') THEN ALTER TABLE providers ADD COLUMN updated_by TEXT DEFAULT ''; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='revision') THEN ALTER TABLE models ADD COLUMN revision INT NOT NULL DEFAULT 1; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='updated_at') THEN ALTER TABLE models ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW(); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='updated_by') THEN ALTER TABLE models ADD COLUMN updated_by TEXT DEFAULT ''; END IF;
END $$;

-- === provider_model_bindings ===
CREATE TABLE IF NOT EXISTS provider_model_bindings (
  id TEXT PRIMARY KEY DEFAULT 'pmb-' || gen_random_uuid()::text,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model_name TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INT NOT NULL DEFAULT 0,
  weight INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (model_id, provider_id)
);
CREATE INDEX IF NOT EXISTS ix_pmb_model ON provider_model_bindings(model_id);
CREATE INDEX IF NOT EXISTS ix_pmb_provider ON provider_model_bindings(provider_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='upstream_model_name') THEN ALTER TABLE provider_model_bindings ADD COLUMN upstream_model_name TEXT NOT NULL DEFAULT ''; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='priority') THEN ALTER TABLE provider_model_bindings ADD COLUMN priority INT NOT NULL DEFAULT 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='weight') THEN ALTER TABLE provider_model_bindings ADD COLUMN weight INT NOT NULL DEFAULT 0; END IF;
END $$;

-- === OSS config ===
CREATE TABLE IF NOT EXISTS oss_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  provider TEXT DEFAULT 'aliyun-oss',
  access_point_name TEXT DEFAULT '',
  endpoint_external TEXT DEFAULT '',
  endpoint_internal TEXT DEFAULT '',
  bucket TEXT DEFAULT '',
  region TEXT DEFAULT '',
  region_label TEXT DEFAULT '',
  access_key_id TEXT DEFAULT '',
  access_key_secret TEXT DEFAULT '',
  path_prefix TEXT DEFAULT 'images/',
  custom_domain TEXT DEFAULT '',
  enabled BOOLEAN DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS oss_configs (
  id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL DEFAULT 'aliyun-oss',
  display_name TEXT DEFAULT '',
  bucket TEXT DEFAULT '',
  region TEXT DEFAULT '',
  region_label TEXT DEFAULT '',
  app_id TEXT DEFAULT '',
  access_key_id TEXT DEFAULT '',
  access_key_secret TEXT DEFAULT '',
  endpoint_external TEXT DEFAULT '',
  path_prefix TEXT DEFAULT 'images/',
  custom_domain TEXT DEFAULT '',
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE oss_config ADD COLUMN IF NOT EXISTS active_id TEXT DEFAULT '';
INSERT INTO oss_config (id, enabled) VALUES (1, TRUE) ON CONFLICT (id) DO NOTHING;

-- === Settings ===
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());
INSERT INTO settings (key, value) VALUES ('app', '{}') ON CONFLICT (key) DO NOTHING;

-- === Generation tasks (legacy) ===
CREATE TABLE IF NOT EXISTS generation_tasks (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  model TEXT DEFAULT '',
  prompt TEXT DEFAULT '',
  count INT DEFAULT 1,
  content_type TEXT DEFAULT 'image',
  result JSONB,
  error TEXT DEFAULT '',
  pending_ids TEXT[] DEFAULT '{}',
  client_meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS generation_tasks_status_idx ON generation_tasks (status);
CREATE INDEX IF NOT EXISTS generation_tasks_created_at_idx ON generation_tasks (created_at);

-- === Generation jobs / attempts ===
CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES generation_tasks(task_id) ON DELETE CASCADE,
  model_id TEXT,
  provider_id TEXT,
  binding_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  cost INT DEFAULT 0,
  attempt_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS generation_jobs_task_id_idx ON generation_jobs (task_id);
CREATE INDEX IF NOT EXISTS generation_jobs_status_idx ON generation_jobs (status);
CREATE INDEX IF NOT EXISTS generation_jobs_created_at_idx ON generation_jobs (created_at);

CREATE TABLE IF NOT EXISTS generation_attempts (
  attempt_id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(job_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  attempt_no INT NOT NULL,
  model_id TEXT,
  binding_id TEXT,
  provider_id TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  latency_ms INT,
  status TEXT NOT NULL,
  http_status INT,
  provider_error_code TEXT,
  cost INT DEFAULT 0,
  retry_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (job_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS generation_attempts_job_id_idx ON generation_attempts (job_id);
CREATE INDEX IF NOT EXISTS generation_attempts_task_id_idx ON generation_attempts (task_id);
CREATE INDEX IF NOT EXISTS generation_attempts_created_at_idx ON generation_attempts (created_at);

-- === Phase A: Auth + Billing ===
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT 'u-' || gen_random_uuid()::text,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  reward_credits NUMERIC(18,4) NOT NULL DEFAULT 0,
  recharge_credits NUMERIC(18,4) NOT NULL DEFAULT 0,
  credits NUMERIC(18,4) GENERATED ALWAYS AS (reward_credits + recharge_credits) STORED,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS credit_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount NUMERIC(18,4) NOT NULL,
  ref TEXT,
  balance_after NUMERIC(18,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ct_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS ix_ct_ref ON credit_transactions(ref);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  aggregate TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outbox_unpub ON outbox(published) WHERE published = FALSE;

-- FK + columns added by runtime
ALTER TABLE media ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_media_user ON media(user_id);
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS cost NUMERIC(18,4) DEFAULT 0;
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS pool TEXT DEFAULT 'recharge';
CREATE INDEX IF NOT EXISTS ix_gt_user ON generation_tasks(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_gt_idem ON generation_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS provider_id TEXT;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS model_id TEXT;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS provider_key TEXT;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS provider_task_id TEXT;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS resume_meta JSONB DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS ix_gt_provider_task ON generation_tasks(provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_gt_running_provider ON generation_tasks(status, provider_task_id) WHERE status='running' AND provider_task_id IS NOT NULL;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS cost_pool TEXT DEFAULT 'recharge';

-- === Default assets + media extras ===
CREATE TABLE IF NOT EXISTS default_assets (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  title TEXT DEFAULT '',
  type TEXT DEFAULT 'image',
  thumbnail TEXT DEFAULT '',
  full_url TEXT DEFAULT '',
  prompt TEXT DEFAULT '',
  model TEXT DEFAULT '',
  ratio TEXT DEFAULT '1:1',
  source TEXT DEFAULT 'default',
  category TEXT DEFAULT 'generated',
  status TEXT DEFAULT 'success',
  sort INT DEFAULT 0,
  tags JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE default_assets ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;
ALTER TABLE media ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;
ALTER TABLE media ADD COLUMN IF NOT EXISTS default_key TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS ix_media_default ON media(user_id, default_key) WHERE default_key IS NOT NULL;

-- === Phase C: reference_styles ===
CREATE TABLE IF NOT EXISTS reference_styles (
  id TEXT PRIMARY KEY DEFAULT 'rs-' || gen_random_uuid()::text,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  preview_url TEXT NOT NULL DEFAULT '',
  full_url TEXT DEFAULT '',
  prompt TEXT DEFAULT '',
  negative_prompt TEXT DEFAULT '',
  model_id TEXT DEFAULT '',
  ratio TEXT DEFAULT '1:1',
  tags JSONB DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  ai_reason TEXT DEFAULT '',
  reject_reason TEXT DEFAULT '',
  source_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  reviewed_by TEXT DEFAULT '',
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_promoted BOOLEAN DEFAULT FALSE,
  commission_rate INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_reference_styles_status ON reference_styles(status);
CREATE INDEX IF NOT EXISTS ix_reference_styles_user ON reference_styles(user_id);
CREATE INDEX IF NOT EXISTS ix_reference_styles_tags ON reference_styles USING GIN(tags);
CREATE INDEX IF NOT EXISTS ix_reference_styles_created ON reference_styles(created_at DESC);
ALTER TABLE reference_styles ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE;
ALTER TABLE reference_styles ADD COLUMN IF NOT EXISTS commission_rate INT DEFAULT 0;
ALTER TABLE media ADD COLUMN IF NOT EXISTS reference_style_id TEXT REFERENCES reference_styles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_media_style ON media(reference_style_id) WHERE reference_style_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_media_task ON media(task_id) WHERE task_id <> '';

CREATE TABLE IF NOT EXISTS style_earnings (
  id TEXT PRIMARY KEY DEFAULT 'se-' || gen_random_uuid()::text,
  reference_style_id TEXT REFERENCES reference_styles(id) ON DELETE SET NULL,
  designer_id TEXT,
  customer_id TEXT,
  media_id TEXT,
  charge_credits INT DEFAULT 0,
  commission_credits INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_style_earnings_style ON style_earnings(reference_style_id);
CREATE INDEX IF NOT EXISTS ix_style_earnings_designer ON style_earnings(designer_id);

-- === Phase M3/M4: request/audit logs, agents ===
CREATE TABLE IF NOT EXISTS request_logs (
  id BIGSERIAL PRIMARY KEY,
  method TEXT, path TEXT, ip TEXT, status INT, latency_ms INT,
  user_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT, action TEXT, target TEXT, detail JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS agents (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  daily_budget INT DEFAULT 0,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type TEXT DEFAULT 'model';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS skill_key TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS ix_agents_type ON agents(agent_type);

CREATE TABLE IF NOT EXISTS agent_providers (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL REFERENCES agents(key) ON DELETE CASCADE,
  provider TEXT DEFAULT '', model TEXT DEFAULT '',
  weight INT DEFAULT 1, priority INT DEFAULT 10, cost_per_call INT DEFAULT 0,
  enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT DEFAULT '',
  condition JSONB DEFAULT '{}', action JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_calls (
  id BIGSERIAL PRIMARY KEY, agent_key TEXT, user_id TEXT, provider TEXT DEFAULT '',
  latency_ms INT, status TEXT DEFAULT '', cost INT DEFAULT 0,
  input_tokens INT DEFAULT 0, output_tokens INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- === provider_model_bindings migration (oss_config to oss_configs) ===
DO $$
DECLARE v_active TEXT;
BEGIN
  SELECT active_id INTO v_active FROM oss_config WHERE id=1;
  IF (SELECT count(*) FROM oss_configs) = 0 THEN
    INSERT INTO oss_configs (id, provider_type, display_name, bucket, region, region_label, access_key_id, access_key_secret, endpoint_external, path_prefix, custom_domain, enabled)
    SELECT 'oss-legacy', COALESCE((SELECT provider FROM oss_config WHERE id=1), 'aliyun-oss'),
           '默认（从旧配置迁移）',
           bucket, region, region_label, access_key_id, access_key_secret, endpoint_external, path_prefix, custom_domain, TRUE
    FROM oss_config WHERE id=1;
    UPDATE oss_config SET active_id='oss-legacy' WHERE id=1;
  END IF;
END $$;

-- Type conversions (idempotent in PG)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='credit_cost' AND data_type='integer') THEN ALTER TABLE models ALTER COLUMN credit_cost TYPE NUMERIC(18,4); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='reward_credits_required' AND data_type='integer') THEN ALTER TABLE models ALTER COLUMN reward_credits_required TYPE NUMERIC(18,4); END IF;
END $$;

-- Additional ALTERs from server.js that aren't covered by DO blocks
ALTER TABLE providers ADD COLUMN IF NOT EXISTS max_concurrent INT DEFAULT 2;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS rate_limits JSONB DEFAULT '{}'::jsonb;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS capacity_model TEXT DEFAULT 'limited';
ALTER TABLE providers ADD COLUMN IF NOT EXISTS bucket_max INT;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS cooldown_ms INT DEFAULT 60000;
