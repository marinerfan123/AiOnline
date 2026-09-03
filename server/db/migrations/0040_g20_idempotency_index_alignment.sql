-- 0040_g20_idempotency_index_alignment
-- G20 audit M1 fix: generation_batches_v2.idempotency_key dedup constraint was
-- a PARTIAL unique index (0003: WHERE idempotency_key IS NOT NULL) while the
-- authoritative runtime schema (schema.cjs) declares a FULL unique constraint
-- and intake.cjs issues `ON CONFLICT (user_id, idempotency_key)` (no predicate).
-- PostgreSQL validates ON CONFLICT inference at plan time against the actual
-- index — on a migration-built DB the partial index made intake fail with
-- "no unique or exclusion constraint matching".
-- Fix (forward-only): replace the partial index with the full unique index.
-- NULL idempotency_keys remain pairwise-distinct under full unique semantics
-- (Postgres treats NULLs as distinct), so multi-NULL batches still insert —
-- identical to the authoritative schema. Same index name, so schema.cjs parity
-- checks and test harness initTestSchema stay consistent.

DROP INDEX IF EXISTS uq_generation_batches_v2_user_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_batches_v2_user_idempotency
  ON generation_batches_v2 (user_id, idempotency_key);
