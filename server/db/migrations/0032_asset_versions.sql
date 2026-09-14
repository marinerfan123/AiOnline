-- 0032_asset_versions
-- W3-11: Asset Version — uploaded/generated/derived versions preserve media.id compatibility
--        while adding version identity + status.

CREATE TABLE IF NOT EXISTS asset_versions (
  version_id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- upload | generated | derived
  status TEXT NOT NULL DEFAULT 'pending', -- pending | ready | failed
  origin_asset_id TEXT,
  generation_id TEXT,
  model TEXT,
  provider TEXT,
  storage_key TEXT,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- media.id compatibility: index on media_id so legacy lookups keep working.
CREATE INDEX IF NOT EXISTS ix_asset_versions_media ON asset_versions (media_id);
CREATE INDEX IF NOT EXISTS ix_asset_versions_project ON asset_versions (project_id);
