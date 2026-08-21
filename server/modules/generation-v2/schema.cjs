'use strict';

// Generation V2 影子表：当前仅建模/测试，不接生产流量。
// PostgreSQL 是任务与账务唯一事实源；Redis 只做唤醒、限流和短租约加速。
const GENERATION_V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS generation_batches_v2 (
  batch_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  model_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image','video')),
  requested_count SMALLINT NOT NULL CHECK (requested_count BETWEEN 1 AND 4),
  unit_price NUMERIC(14,4) NOT NULL CHECK (unit_price >= 0),
  reserved_total NUMERIC(14,4) NOT NULL CHECK (reserved_total >= 0),
  success_count SMALLINT NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failed_count SMALLINT NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  canceled_count SMALLINT NOT NULL DEFAULT 0 CHECK (canceled_count >= 0),
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted','running','done','partial','failed','canceled')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS generation_items_v2 (
  item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES generation_batches_v2(batch_id) ON DELETE CASCADE,
  item_index SMALLINT NOT NULL CHECK (item_index >= 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued','leased','generating','provider_accepted','reconciling',
      'generated','uploading','retry_wait','review_required',
      'done','failed','canceled'
    )),
  priority INT NOT NULL DEFAULT 0,
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  provider_id TEXT,
  key_id TEXT,
  provider_request_id TEXT,
  provider_url TEXT,
  oss_url TEXT,
  last_error_code TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (batch_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_generation_items_v2_claim
  ON generation_items_v2 (status, next_attempt_at, priority DESC, created_at)
  WHERE status IN ('queued','retry_wait');
CREATE INDEX IF NOT EXISTS idx_generation_items_v2_lease
  ON generation_items_v2 (lease_expires_at)
  WHERE status IN ('leased','generating');
CREATE INDEX IF NOT EXISTS idx_generation_items_v2_batch
  ON generation_items_v2 (batch_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_items_v2_provider_request
  ON generation_items_v2 (provider_id, provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS generation_item_attempts_v2 (
  attempt_id BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES generation_items_v2(item_id) ON DELETE CASCADE,
  attempt_no INT NOT NULL CHECK (attempt_no > 0),
  lease_version BIGINT NOT NULL,
  provider_id TEXT,
  key_id TEXT,
  provider_request_id TEXT,
  client_request_id TEXT,
  status TEXT NOT NULL,
  http_status INT,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  latency_ms INT,
  UNIQUE (item_id, attempt_no)
);

ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_attempts_v2_client_request
  ON generation_item_attempts_v2 (client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS generation_credit_holds_v2 (
  hold_id BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES generation_items_v2(item_id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  pool TEXT NOT NULL CHECK (pool IN ('reward','recharge')),
  amount NUMERIC(14,4) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','committed','released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_transactions_v2_ref_kind
  ON credit_transactions (ref, kind)
  WHERE ref LIKE 'v2:%';

CREATE TABLE IF NOT EXISTS generation_worker_heartbeats_v2 (
  worker_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS generation_outbox_v2 (
  event_id BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0
);
ALTER TABLE generation_outbox_v2 ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE generation_outbox_v2 ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_generation_outbox_v2_pending
  ON generation_outbox_v2 (created_at)
  WHERE published_at IS NULL;
`;

async function applyGenerationV2Schema(pg) {
  if (!pg || typeof pg.query !== 'function') throw new TypeError('pg.query is required');
  await pg.query(GENERATION_V2_SCHEMA_SQL);
}

module.exports = { GENERATION_V2_SCHEMA_SQL, applyGenerationV2Schema };
