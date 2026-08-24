-- 0003_generation_v2_runtime_schema_parity
-- Forward-only compatibility migration from legacy 0002 Generation V2 schema
-- to the authoritative runtime schema used by server/modules/generation-v2/schema.cjs.

-- Batches: legacy 0002 used payload/requested_at and omitted runtime commercial fields.
ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE generation_batches_v2 SET user_id = 'legacy' WHERE user_id IS NULL;
ALTER TABLE generation_batches_v2 ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS unit_price NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS reserved_total NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS success_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS failed_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS canceled_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS request_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE generation_batches_v2 SET request_payload = payload WHERE payload IS NOT NULL AND request_payload = '{}'::jsonb;
ALTER TABLE generation_batches_v2 ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_batches_v2_user_idempotency
  ON generation_batches_v2 (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Items: legacy 0002 used retry_count/next_retry_at/provider_request_key names.
ALTER TABLE generation_items_v2 ALTER COLUMN item_index TYPE SMALLINT USING item_index::smallint;
ALTER TABLE generation_items_v2 ALTER COLUMN lease_version TYPE BIGINT USING lease_version::bigint;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;
UPDATE generation_items_v2 SET attempt_count = retry_count WHERE retry_count IS NOT NULL AND attempt_count = 0;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE generation_items_v2 SET next_attempt_at = next_retry_at WHERE next_retry_at IS NOT NULL;
ALTER TABLE generation_items_v2 ALTER COLUMN lease_owner DROP DEFAULT;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS key_id TEXT;
UPDATE generation_items_v2 SET key_id = provider_request_key WHERE key_id IS NULL AND provider_request_key IS NOT NULL;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS oss_url TEXT;
UPDATE generation_items_v2 SET oss_url = oss_object_key WHERE oss_url IS NULL AND oss_object_key IS NOT NULL;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS last_error TEXT;
UPDATE generation_items_v2 SET last_error = error_message WHERE last_error IS NULL AND error_message IS NOT NULL;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ;
ALTER TABLE generation_items_v2 ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
DO $$
BEGIN
  ALTER TABLE generation_items_v2 DROP CONSTRAINT IF EXISTS generation_items_v2_status_check;
  ALTER TABLE generation_items_v2 ADD CONSTRAINT generation_items_v2_status_check CHECK (status IN (
    'queued','leased','generating','provider_accepted','reconciling','reconcile_wait',
    'generated','uploading','retry_wait','review_required','done','failed','canceled'
  ));
END $$;

DROP INDEX IF EXISTS idx_generation_items_v2_claim;
CREATE INDEX IF NOT EXISTS idx_generation_items_v2_claim
  ON generation_items_v2 (status, next_attempt_at, priority DESC, created_at)
  WHERE status IN ('queued','retry_wait') AND mode='real';
DROP INDEX IF EXISTS idx_generation_items_v2_lease;
CREATE INDEX IF NOT EXISTS idx_generation_items_v2_lease
  ON generation_items_v2 (lease_expires_at)
  WHERE status IN ('leased','generating');
DROP INDEX IF EXISTS idx_generation_items_v2_batch;
CREATE INDEX IF NOT EXISTS idx_generation_items_v2_batch
  ON generation_items_v2 (batch_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_items_v2_batch_index
  ON generation_items_v2 (batch_id, item_index);

-- Attempts: align primary column names and runtime outcome fields.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='generation_item_attempts_v2' AND column_name='id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='generation_item_attempts_v2' AND column_name='attempt_id'
  ) THEN
    ALTER TABLE generation_item_attempts_v2 RENAME COLUMN id TO attempt_id;
  END IF;
END $$;
ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS lease_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS key_id TEXT;
UPDATE generation_item_attempts_v2 SET key_id = provider_key WHERE key_id IS NULL AND provider_key IS NOT NULL;
ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS provider_request_id TEXT;
ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS http_status INT;
ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE generation_item_attempts_v2 ADD COLUMN IF NOT EXISTS latency_ms INT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_attempts_v2_client_request
  ON generation_item_attempts_v2 (client_request_id) WHERE client_request_id IS NOT NULL;

-- Holds: runtime settlement uses hold_id/pool/settled_at with numeric amounts.
ALTER TABLE generation_credit_holds_v2 ADD COLUMN IF NOT EXISTS hold_id BIGSERIAL;
ALTER TABLE generation_credit_holds_v2 ALTER COLUMN amount TYPE NUMERIC(14,4) USING amount::numeric;
ALTER TABLE generation_credit_holds_v2 ADD COLUMN IF NOT EXISTS pool TEXT;
UPDATE generation_credit_holds_v2 SET pool = CASE WHEN kind IN ('reward','recharge') THEN kind ELSE 'recharge' END WHERE pool IS NULL;
ALTER TABLE generation_credit_holds_v2 ALTER COLUMN pool SET NOT NULL;
ALTER TABLE generation_credit_holds_v2 ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
UPDATE generation_credit_holds_v2 SET settled_at = COALESCE(committed_at, released_at) WHERE settled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_credit_holds_v2_hold_id
  ON generation_credit_holds_v2 (hold_id);

-- Heartbeats: runtime writes last_seen_at/meta.
ALTER TABLE generation_worker_heartbeats_v2 ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
UPDATE generation_worker_heartbeats_v2 SET last_seen_at = last_heartbeat WHERE last_seen_at IS NULL AND last_heartbeat IS NOT NULL;
ALTER TABLE generation_worker_heartbeats_v2 ALTER COLUMN last_seen_at SET DEFAULT NOW();
ALTER TABLE generation_worker_heartbeats_v2 ALTER COLUMN last_seen_at SET NOT NULL;
ALTER TABLE generation_worker_heartbeats_v2 ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Outbox: legacy 0002 modeled item/batch/user and boolean published; runtime uses aggregate fields and published_at.
ALTER TABLE generation_outbox_v2 ALTER COLUMN event_id DROP DEFAULT;
ALTER TABLE generation_outbox_v2 ALTER COLUMN event_id TYPE BIGINT USING CASE WHEN event_id ~ '^[0-9]+$' THEN event_id::bigint ELSE abs(hashtext(event_id))::bigint END;
CREATE SEQUENCE IF NOT EXISTS generation_outbox_v2_event_id_seq;
SELECT setval('generation_outbox_v2_event_id_seq', COALESCE((SELECT max(event_id) FROM generation_outbox_v2), 0) + 1, false);
ALTER TABLE generation_outbox_v2 ALTER COLUMN event_id SET DEFAULT nextval('generation_outbox_v2_event_id_seq');
ALTER SEQUENCE generation_outbox_v2_event_id_seq OWNED BY generation_outbox_v2.event_id;
ALTER TABLE generation_outbox_v2 ADD COLUMN IF NOT EXISTS aggregate_type TEXT;
UPDATE generation_outbox_v2 SET aggregate_type = 'generation_item' WHERE aggregate_type IS NULL;
ALTER TABLE generation_outbox_v2 ALTER COLUMN aggregate_type SET NOT NULL;
ALTER TABLE generation_outbox_v2 ADD COLUMN IF NOT EXISTS aggregate_id TEXT;
UPDATE generation_outbox_v2 SET aggregate_id = COALESCE(item_id, batch_id, event_id::text) WHERE aggregate_id IS NULL;
ALTER TABLE generation_outbox_v2 ALTER COLUMN aggregate_id SET NOT NULL;
ALTER TABLE generation_outbox_v2 ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE generation_outbox_v2 ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS idx_generation_outbox_v2_pending;
CREATE INDEX IF NOT EXISTS idx_generation_outbox_v2_pending
  ON generation_outbox_v2 (created_at)
  WHERE published_at IS NULL;
