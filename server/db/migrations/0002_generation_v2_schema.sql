-- 0002_generation_v2_schema
-- Captures Generation V2 PostgreSQL-backed durable workflow schema.
-- Reference: server/modules/generation-v2/schema.cjs

CREATE TABLE IF NOT EXISTS generation_batches_v2 (
  batch_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  requested_count INT NOT NULL DEFAULT 1,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'queued',
  idempotency_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS generation_items_v2 (
  item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES generation_batches_v2(batch_id) ON DELETE CASCADE,
  item_index INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  lease_version INT NOT NULL DEFAULT 0,
  lease_owner TEXT DEFAULT '',
  lease_expires_at TIMESTAMPTZ,
  provider_id TEXT,
  provider_request_id TEXT,
  provider_response_url TEXT,
  provider_request_key TEXT,
  client_request_id TEXT,
  content_type TEXT NOT NULL DEFAULT 'image',
  provider_url TEXT DEFAULT '',
  oss_object_key TEXT DEFAULT '',
  error_message TEXT DEFAULT '',
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'real';

CREATE INDEX IF NOT EXISTS idx_generation_items_v2_claim
  ON generation_items_v2 (status, created_at) WHERE status IN ('queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS idx_generation_items_v2_lease
  ON generation_items_v2 (lease_expires_at, status) WHERE status IN ('leased', 'generating');
CREATE INDEX IF NOT EXISTS idx_generation_items_v2_batch
  ON generation_items_v2 (batch_id, item_index);
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_items_v2_provider_request
  ON generation_items_v2 (provider_id, provider_request_id) WHERE provider_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS generation_item_attempts_v2 (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES generation_items_v2(item_id) ON DELETE CASCADE,
  attempt_no INT NOT NULL,
  provider_id TEXT,
  provider_key TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  error_message TEXT DEFAULT '',
  UNIQUE (item_id, attempt_no)
);

ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_attempts_v2_client_request
  ON generation_item_attempts_v2 (client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS generation_credit_holds_v2 (
  item_id TEXT PRIMARY KEY REFERENCES generation_items_v2(item_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  amount INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_transactions_v2_ref_kind
  ON generation_credit_holds_v2 (ref, kind);

CREATE TABLE IF NOT EXISTS generation_worker_heartbeats_v2 (
  worker_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generation_outbox_v2 (
  event_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE generation_outbox_v2 ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE generation_outbox_v2 ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_generation_outbox_v2_pending
  ON generation_outbox_v2 (published) WHERE published = FALSE;
