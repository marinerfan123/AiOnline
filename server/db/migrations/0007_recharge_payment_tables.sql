-- 0007: Recharge/payment tables moved from legacy inline DDL to the migration chain.
-- Root cause: server.js removed runtime DDL in production (f6b2c7b), but the
-- recharge/payment schema was only ever created by that inline block. Migrated
-- production/staging DBs therefore lack these tables, and the order-expiry
-- ticker logs "payment_settings does not exist" on every tick.
--
-- Idempotent by design: tables/indexes use IF NOT EXISTS; the payment_settings
-- seed uses ON CONFLICT DO NOTHING. DBs that still have these tables from the
-- legacy inline DDL pass through unchanged.
--
-- Schema source of truth: final state of the legacy inline DDL block in
-- server/server.js (recharge_orders incl. Phase-2/4 upgrades, topup_packages,
-- payment_settings, payment_providers).
--
-- Ordering note: payment_providers is created before recharge_orders because
-- recharge_orders.provider_id carries a FK to it.

-- Global payment settings (single row id=1)
CREATE TABLE IF NOT EXISTS payment_settings (
  id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  default_expires_min INT NOT NULL DEFAULT 15,
  min_amount        INT NOT NULL DEFAULT 1000,
  max_amount        INT NOT NULL DEFAULT 10000000,
  daily_limit       INT NOT NULL DEFAULT 10000000,
  max_open_orders   INT NOT NULL DEFAULT 5,
  allow_test        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enable_wxpay      BOOLEAN NOT NULL DEFAULT TRUE,
  enable_alipay     BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO payment_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Payment providers (credentials stored encrypted; API never returns plaintext)
CREATE TABLE IF NOT EXISTS payment_providers (
  id              TEXT PRIMARY KEY DEFAULT 'pp-' || gen_random_uuid()::text,
  name            TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL DEFAULT 'easypay',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  weight          INT NOT NULL DEFAULT 1,
  sort_order      INT NOT NULL DEFAULT 0,
  api_base        TEXT DEFAULT '',
  pid_enc         TEXT,
  pkey_enc        TEXT,
  webhook_secret_enc TEXT,
  product_name_prefix TEXT DEFAULT '充值',
  allow_refund    BOOLEAN NOT NULL DEFAULT FALSE,
  remark          TEXT DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  supported_methods JSONB DEFAULT '["alipay","wxpay"]'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_pp_enabled ON payment_providers(enabled, sort_order);

-- Recharge orders (legacy Phase 2 + payment P0 upgrades, final shape)
CREATE TABLE IF NOT EXISTS recharge_orders (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL DEFAULT 'wechat',
  amount        INT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  pay_order_no  TEXT UNIQUE NOT NULL,
  sign          TEXT DEFAULT '',
  meta          JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at       TIMESTAMPTZ,
  provider_id   TEXT REFERENCES payment_providers(id) ON DELETE SET NULL,
  channel_trade_no TEXT,
  channel_method   TEXT,
  channel_raw      JSONB DEFAULT '{}',
  expired_at       TIMESTAMPTZ,
  fail_reason      TEXT,
  package_id       TEXT,
  bonus            INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_ro_user   ON recharge_orders(user_id);
CREATE INDEX IF NOT EXISTS ix_ro_payno  ON recharge_orders(pay_order_no);
CREATE INDEX IF NOT EXISTS ix_ro_provider ON recharge_orders(provider_id);
CREATE INDEX IF NOT EXISTS ix_ro_ctrade ON recharge_orders(channel_trade_no);
CREATE INDEX IF NOT EXISTS ix_ro_status ON recharge_orders(status, created_at DESC);

-- Topup packages (legacy Phase 4)
CREATE TABLE IF NOT EXISTS topup_packages (
  id          TEXT PRIMARY KEY DEFAULT 'pkg-' || gen_random_uuid()::text,
  name        TEXT NOT NULL DEFAULT '',
  credits     INT  NOT NULL DEFAULT 0,
  price       INT  NOT NULL DEFAULT 0,
  bonus       INT  NOT NULL DEFAULT 0,
  sort_order  INT  NOT NULL DEFAULT 0,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  remark      TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_tp_sort ON topup_packages(sort_order);
