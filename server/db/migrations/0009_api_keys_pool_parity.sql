-- 0009: Align api_keys with the certified key-pool runtime schema.
-- Root cause: server.js key pool queries (SELECT provider_id, id, api_key,
-- label, status, weight ...; INSERT ... ON CONFLICT (provider_id, api_key))
-- require label, weight and UNIQUE(provider_id, api_key), but 0006 created
-- api_keys without them. Freshly migrated prod DBs fail key pool init
-- ("column label does not exist"), breaking provider dispatch pairs.
-- Staging only worked because its DB still carried the legacy inline-DDL
-- api_keys (label/weight present).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS.
-- DBs whose api_keys already has the columns (legacy inline DDL) pass through
-- unchanged; the unique index creation is the only new constraint.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS label TEXT DEFAULT '';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS weight INT NOT NULL DEFAULT 100;

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_provider_api_key
  ON api_keys (provider_id, api_key);
