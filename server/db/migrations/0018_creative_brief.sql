-- 0018_creative_brief
-- W1-01: Creative Brief — the locked input contract for a project (Shot-centric product generation).
-- Stored as a JSONB column on projects so it is 1:1 with the project and validated at the app layer.
-- Fields (W1-01 acceptance): goal, audience, platform, duration, aspect_ratio, language,
--   key_message, cta, brand, tone, style, references, budget, deadline, deliverables, restrictions.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS creative_brief JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN projects.creative_brief IS
  'W1-01 Creative Brief: goal, audience, platform, duration, aspect_ratio, language, key_message, cta, brand, tone, style, references, budget, deadline, deliverables, restrictions';
