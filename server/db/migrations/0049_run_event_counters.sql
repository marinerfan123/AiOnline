-- 0049_run_event_counters.sql
-- G21 audit follow-up (2026-09-04): run_event_counters was introduced by the
-- relay race fix as a lazy CREATE TABLE IF NOT EXISTS inside runEventStore.cjs
-- only — the same drift pattern as run_events before 0043. A migrate-rebuilt
-- DB would miss the counter table while a backup-restored DB has it. Bring it
-- into the migration chain; the store's IF NOT EXISTS becomes a no-op.
-- Forward-only, additive.

CREATE TABLE IF NOT EXISTS run_event_counters (
  run_id TEXT PRIMARY KEY,
  seq BIGINT NOT NULL
);
