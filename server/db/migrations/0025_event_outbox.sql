-- 0025_event_outbox
-- W2-12: generic transactional outbox for ALL release-critical events
--        (project/shot/generation/asset/review/payment/reward), with retry state.
-- Event body is the W1-17 standardized envelope; idempotency_key makes re-delivery a no-op.

CREATE TABLE IF NOT EXISTS event_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | delivering | delivered | failed
  delivery_attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_event_outbox_ready
  ON event_outbox (status, next_attempt_at) WHERE status IN ('pending', 'failed');
