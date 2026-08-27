-- 0011: M02-B legacy credential backfill into the authoritative key pool.
-- Forward-only, idempotent, non-destructive, dedupe-safe.
--
-- Rationale: api_keys is the single business authority for provider credentials
-- (M02-A). Some providers still carry their only credential in the legacy column
-- providers.api_key, so the UI shows "Key Pool = 0" while the runtime falls back
-- to providers.api_key (dispatcher effectiveApiKey) and generation works. This
-- migration promotes that legacy key into the pool ONCE, so the pool becomes the
-- visible, manageable authority and the admin UI reflects reality.
--
-- Safety invariants (B4):
--   * INSERT-only. providers.api_key is NOT modified or dropped — the runtime
--     LEGACY_FALLBACK stays fully intact; a later controlled cutover decides
--     deprecation, not this migration.
--   * Dedupe: ON CONFLICT (provider_id, api_key) DO NOTHING + a NOT EXISTS guard.
--     Re-running on an already-backfilled DB is a no-op; an identical key already
--     in the pool is never duplicated.
--   * Placeholder/empty keys skipped (length < 6 or contains '*'), matching the
--     runtime's notion of a real secret.
--   * Provenance label 'legacy-backfill' marks the promoted row for audit and
--     for the rollback procedure (drop WHERE label='legacy-backfill').
--
-- Rollback:
--   DELETE FROM api_keys WHERE label = 'legacy-backfill';
--   (providers.api_key was never touched, so no data is lost and the legacy
--    fallback continues to serve generation exactly as before this migration.)
INSERT INTO api_keys (id, provider_id, api_key, label, status, weight, created_at, updated_at)
SELECT
  'k-' || replace(gen_random_uuid()::text, '-', ''),
  p.id,
  p.api_key,
  'legacy-backfill',
  'active',
  100,
  NOW(),
  NOW()
FROM providers p
WHERE p.api_key IS NOT NULL
  AND length(p.api_key) >= 6
  AND p.api_key NOT LIKE '%*%'
  AND NOT EXISTS (
    SELECT 1 FROM api_keys k WHERE k.provider_id = p.id AND k.api_key = p.api_key
  )
ON CONFLICT (provider_id, api_key) DO NOTHING;
