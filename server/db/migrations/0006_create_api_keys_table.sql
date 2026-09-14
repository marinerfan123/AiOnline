-- 0006: Create api_keys table for per-provider key pool management
-- Required by server/modules/modelhub/bindings.cjs loadDispatchPairs()
-- Legacy providers with api_key in providers table still work (fallback)

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY DEFAULT ('k-' || gen_random_uuid()),
  provider_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'isolated', 'disabled')),
  remark TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_api_keys_provider ON api_keys(provider_id);
CREATE INDEX IF NOT EXISTS ix_api_keys_status ON api_keys(status) WHERE status = 'active';
