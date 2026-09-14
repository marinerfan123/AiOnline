-- 0019_delivery_spec
-- W1-03: DeliverySpec — locked output requirements for a project (Shot-centric generation).
-- Stored as JSONB on projects (1:1), validated at the app layer with explicit defaults/versioning.
-- Fields (W1-03 acceptance): aspect_ratio, resolution, duration, fps, platform, subtitles,
--   audio, safe_area, variants.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_spec JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN projects.delivery_spec IS
  'W1-03 DeliverySpec: aspect_ratio, resolution, duration, fps, platform, subtitles, audio, safe_area, variants (defaults+versioning)';
