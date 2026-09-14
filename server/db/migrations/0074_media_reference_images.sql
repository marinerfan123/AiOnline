-- 0074_media_reference_images.sql
-- Persist generation reference images so img2img/reference mode can be audited and shown in workspace details.
ALTER TABLE media
  ADD COLUMN IF NOT EXISTS reference_images JSONB NOT NULL DEFAULT '[]'::jsonb;
