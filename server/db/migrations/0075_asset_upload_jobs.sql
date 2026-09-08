-- 0075_asset_upload_jobs.sql
-- G1-0 MIGRATION AUTHORITY REPAIR：asset_upload_jobs 由运行时 DDL（uploadQueue.cjs ensureUploadJobsTable）收编为编号迁移。
-- 迁移链成为该表的唯一权威；运行时不再建表。
CREATE TABLE IF NOT EXISTS asset_upload_jobs (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | done | failed
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_asset_upload_jobs_state ON asset_upload_jobs(state, created_at);
CREATE INDEX IF NOT EXISTS idx_asset_upload_jobs_task ON asset_upload_jobs(task_id);
