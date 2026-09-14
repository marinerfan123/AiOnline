-- 0037_media_checksum
-- G06: checksum provenance on uploads (sha256 of object bytes, client-computed
-- at PUT time; server-side read-back verification is a G21 audit item).
-- ADDITIVE / forward-only.

ALTER TABLE media ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;

CREATE INDEX IF NOT EXISTS ix_media_checksum ON media(checksum_sha256)
  WHERE checksum_sha256 IS NOT NULL;
