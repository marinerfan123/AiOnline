-- 0008: Remaining legacy runtime tables moved from inline DDL to the migration chain.
-- Companion to 0007. Root cause is identical: production startup no longer runs
-- structural DDL (f6b2c7b), but these tables were only ever created by the
-- legacy inline block in server/server.js, so migrated production DBs lack them
-- and runtime features (agents, payment audit, skills/market, pricing, feedback,
-- system error logging, studio projects, cron markers) hit missing relations.
--
-- Idempotent by design (IF NOT EXISTS everywhere; the model_pricing backfill
-- inserts only rows for model_ids not already present). DBs already carrying
-- these tables from the legacy inline DDL pass through unchanged.
--
-- Schema source of truth: final state of the legacy inline DDL blocks in
-- server/server.js.

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_url TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  age INTEGER DEFAULT 0,
  tags TEXT[] DEFAULT '{}',
  style JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  description TEXT DEFAULT '',
  reference_images TEXT[] DEFAULT '{}',
  base_model TEXT DEFAULT '',
  source TEXT DEFAULT 'user'
);

-- Webhook 幂等表（L2 双保险）：同 (provider_id, channel_trade_no, event_type) 唯一
CREATE TABLE IF NOT EXISTS webhook_events (
  id              BIGSERIAL PRIMARY KEY,
  provider_id     TEXT,
  channel_trade_no TEXT NOT NULL,
  event_type      TEXT NOT NULL DEFAULT 'paid',
  out_trade_no    TEXT,
  status          TEXT NOT NULL DEFAULT 'new',
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  raw             JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, channel_trade_no, event_type)
);
CREATE INDEX IF NOT EXISTS ix_we_pending ON webhook_events(status, updated_at) WHERE status IN ('new','processing','failed');

-- 支付审计（L6，脱敏，绝不记密钥）
CREATE TABLE IF NOT EXISTS payment_audit (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  actor       TEXT DEFAULT '',
  user_id     TEXT,
  order_id    TEXT,
  provider_id TEXT,
  detail      JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_pa_created ON payment_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS skill_registry (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  stage        TEXT DEFAULT 'generation',
  adapter      TEXT NOT NULL,
  params       JSONB DEFAULT '{}',
  cost_credits INT DEFAULT 0,
  enabled      BOOLEAN DEFAULT TRUE,
  description  TEXT DEFAULT '',
  author       TEXT DEFAULT '',
  icon         TEXT DEFAULT '',
  version      TEXT DEFAULT '1.0.0',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_sr_enabled ON skill_registry(enabled);

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY DEFAULT 'prod-' || gen_random_uuid()::text,
  title         TEXT NOT NULL,
  subtitle      TEXT DEFAULT '',
  cover_url     TEXT DEFAULT '',
  kind          TEXT DEFAULT 'skill_pack',
  ref_key       TEXT DEFAULT '',
  price_credits INT DEFAULT 0,
  price_cents   INT DEFAULT 0,
  status        TEXT DEFAULT 'published',
  author        TEXT DEFAULT '',
  description   TEXT DEFAULT '',
  tags          TEXT[] DEFAULT '{}',
  installs      INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_prod_status ON products(status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_skills (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_key    TEXT NOT NULL,
  acquired_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, skill_key)
);
CREATE INDEX IF NOT EXISTS ix_us_user ON user_skills(user_id);

CREATE TABLE IF NOT EXISTS model_cost_rates (
  id                 TEXT PRIMARY KEY DEFAULT 'mcr-' || gen_random_uuid()::text,
  provider_id        TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  model_type         TEXT DEFAULT 'text',
  input_cost_per_1k  NUMERIC DEFAULT 0,
  output_cost_per_1k NUMERIC DEFAULT 0,
  cost_per_unit      NUMERIC DEFAULT 0,
  currency           TEXT DEFAULT 'CNY',
  source             TEXT DEFAULT 'manual',
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS ix_mcr_provider ON model_cost_rates(provider_id);

-- 统一消费台账（双边）
CREATE TABLE IF NOT EXISTS consumption_ledger (
  id                     BIGSERIAL PRIMARY KEY,
  scope                  TEXT NOT NULL DEFAULT 'user',
  actor_id               TEXT DEFAULT '',
  purpose                TEXT NOT NULL,
  provider_id            TEXT DEFAULT '',
  model_id               TEXT DEFAULT '',
  model_type             TEXT DEFAULT '',
  input_units            INT DEFAULT 0,
  output_units           INT DEFAULT 0,
  backend_cost_cents     NUMERIC DEFAULT 0,
  customer_charge_credits INT DEFAULT 0,
  customer_charge_cents  NUMERIC DEFAULT 0,
  margin_cents           NUMERIC DEFAULT 0,
  task_ref               TEXT DEFAULT '',
  idempotency_key        TEXT DEFAULT '',
  status                 TEXT DEFAULT 'ok',
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  binding_id             TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_cl_scope_time ON consumption_ledger(scope, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_cl_actor ON consumption_ledger(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_cl_purpose ON consumption_ledger(purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_cl_idem ON consumption_ledger(idempotency_key) WHERE idempotency_key <> '';

CREATE TABLE IF NOT EXISTS model_price_history (
  id            TEXT PRIMARY KEY DEFAULT 'mph-' || gen_random_uuid()::text,
  model_id      TEXT NOT NULL,
  display_name  TEXT DEFAULT '',
  credit_cost   NUMERIC(18,4) DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mph_model ON model_price_history(model_id, updated_at DESC);

-- 用户侧价：单逻辑模型一行
CREATE TABLE IF NOT EXISTS model_pricing (
  model_id     TEXT PRIMARY KEY,
  credit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  reward_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency     TEXT DEFAULT 'CNY',
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mp_model ON model_pricing(model_id);

-- 一次性回填：从 models.credit_cost 初始化 model_pricing（幂等：只补缺失 model_id）
INSERT INTO model_pricing (model_id, credit_price, reward_price, currency, updated_at)
SELECT DISTINCT ON (model_id) model_id,
  COALESCE(NULLIF(credit_cost, 0), 0) AS credit_price,
  0 AS reward_price,
  'CNY' AS currency,
  NOW() AS updated_at
FROM models
WHERE model_id NOT IN (SELECT model_id FROM model_pricing)
ORDER BY model_id, credit_cost DESC;

-- 每线路成本
CREATE TABLE IF NOT EXISTS provider_model_costs (
  binding_id   TEXT NOT NULL REFERENCES provider_model_bindings(id) ON DELETE CASCADE,
  provider_id  TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  cost         NUMERIC NOT NULL DEFAULT 0,
  currency     TEXT DEFAULT 'CNY',
  unit         TEXT NOT NULL DEFAULT 'per_1k_input_token',
  effective_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (binding_id, unit)
);
CREATE INDEX IF NOT EXISTS ix_pmc_pm ON provider_model_costs(provider_id, model_id);
CREATE INDEX IF NOT EXISTS ix_pmc_binding ON provider_model_costs(binding_id);

-- Node 内存 worker 游标持久化
CREATE TABLE IF NOT EXISTS cron_marker (
  name      TEXT PRIMARY KEY,
  last_run  TIMESTAMPTZ,
  cursor    JSONB DEFAULT '{}'
);

-- 用户反馈
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  type        TEXT DEFAULT 'other',
  title       TEXT DEFAULT '',
  content     TEXT DEFAULT '',
  contact     TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 用户举报
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  type        TEXT DEFAULT 'other',
  target_url  TEXT DEFAULT '',
  content     TEXT DEFAULT '',
  evidence    TEXT DEFAULT '',
  contact     TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 系统监控日志强化：核心错误持久化
CREATE TABLE IF NOT EXISTS system_error_logs (
  id          BIGSERIAL PRIMARY KEY,
  category    TEXT DEFAULT 'app',
  source      TEXT DEFAULT 'app',
  message     TEXT NOT NULL,
  meta        JSONB DEFAULT '{}',
  stack       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_sel_created ON system_error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_sel_category ON system_error_logs(category);

-- 无限画布工程
CREATE TABLE IF NOT EXISTS studio_projects (
  id            TEXT PRIMARY KEY DEFAULT 'proj-' || gen_random_uuid()::text,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'story',
  status        TEXT NOT NULL DEFAULT 'planning',
  current_stage TEXT NOT NULL DEFAULT 'idea',
  description   TEXT DEFAULT '',
  cover_url     TEXT DEFAULT '',
  meta          JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_studio_owner_updated ON studio_projects(owner_id, updated_at DESC);

-- 智能体规则触发日志
CREATE TABLE IF NOT EXISTS agent_rule_logs (
  id BIGSERIAL PRIMARY KEY,
  rule_id TEXT,
  fired_at TIMESTAMPTZ DEFAULT NOW(),
  result JSONB DEFAULT '{}'
);
