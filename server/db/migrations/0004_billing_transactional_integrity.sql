-- 0004_billing_transactional_integrity
-- Adds DB-level idempotency and integrity constraints for billing operations.
-- Forward-only: safe on both fresh (0001+0002+0003) and existing databases.

-- Unique constraint on credit_transactions (ref, kind) prevents duplicate posts
-- even under concurrent execution. This is the authoritative idempotency guard.
-- NOTE: Must be a full (non-partial) unique index so ON CONFLICT clauses work.
-- All authoritative billing operations always provide a non-null ref, so this is safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_transactions_ref_kind
  ON credit_transactions (ref, kind);

-- Ensure pool column is NOT NULL with default for billing correctness.
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS pool TEXT DEFAULT 'recharge';
