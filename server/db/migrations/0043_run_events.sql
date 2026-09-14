-- 0043_run_events.sql
-- G21 audit fix: run_events existed only as a lazy CREATE TABLE inside
-- runEventStore.cjs — never in the migration chain (migrate.cjs discovers
-- migrations/*.sql only), so a migrate-rebuilt DB diverged from a backup-
-- restored one, and rows could orphan (no FK). Bring the table into the chain
-- and add the FK against studio_runs with cascade delete. The store's
-- CREATE TABLE IF NOT EXISTS stays as a harmless no-op when this has run.
-- Forward-only, additive.

CREATE TABLE IF NOT EXISTS run_events (
  run_id      TEXT NOT NULL,
  seq         BIGINT NOT NULL,
  type        TEXT NOT NULL,
  payload_json JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, seq)
);

-- Audit fix: no orphaned events; deleting a run clears its event log.
ALTER TABLE run_events
  ADD CONSTRAINT fk_run_events_run
  FOREIGN KEY (run_id) REFERENCES studio_runs(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_run_events_run_seq ON run_events (run_id, seq);
