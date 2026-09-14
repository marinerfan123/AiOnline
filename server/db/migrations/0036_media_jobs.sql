-- 0036_media_jobs
-- MOLING_STUDIO_MASTER_BLUEPRINT_V2.0 — G06 Asset/Media: deterministic media
-- processing job queue (probe/thumbnail/proxy/waveform/transcode/frame_extract/
-- render). Jobs never block sync API requests; workers claim via lease CAS.
-- ADDITIVE / forward-only.

CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY DEFAULT 'mj-' || gen_random_uuid()::text,
  asset_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  project_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN
    ('probe','transcode','proxy','thumbnail','waveform','frame_extract','render')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','running','done','failed','cancelled')),
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB,
  error_code TEXT,
  error_message TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  idempotency_key TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active job per (asset, kind) unless the prior one is terminal-done.
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_jobs_active
  ON media_jobs(asset_id, kind)
  WHERE status IN ('queued','running');

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_jobs_idempotency
  ON media_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_media_jobs_claim
  ON media_jobs(status, kind, created_at)
  WHERE status = 'queued';
