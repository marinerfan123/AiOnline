-- 0029_asset_rights
-- W2-05: minimum rights/provenance metadata for commercial assets.
-- origin/uploaded_by/generated_by/provider/model/generation_id/reference_assets/owner/license/
-- consent/commercial_usage/created_at represented when applicable.

CREATE TABLE IF NOT EXISTS asset_rights (
  asset_id TEXT PRIMARY KEY,
  origin TEXT,                     -- uploaded | generated | imported
  uploaded_by TEXT,
  generated_by TEXT,
  provider TEXT,
  model TEXT,
  generation_id TEXT,
  reference_assets JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner TEXT,
  license TEXT,
  consent JSONB NOT NULL DEFAULT '{}'::jsonb,
  commercial_usage BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_asset_rights_asset ON asset_rights (asset_id);
