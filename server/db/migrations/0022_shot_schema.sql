-- 0022_shot_schema
-- W1-09: Locked Shot schema — extend the 0017 `shots` table with the Shot-centric product fields.
-- ADDITIVE: new columns carry defaults, so legacy Shot rows remain valid/readable.
-- Field groups (W1-09 acceptance): identity, story/intent, cinematography, context,
--   generation, output, commerce.

ALTER TABLE shots ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS story_intent JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS cinematography JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS generation_meta JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS output JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS commerce JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN shots.title IS 'W1-09 Shot title (identity)';
COMMENT ON COLUMN shots.story_intent IS 'W1-09 story/intent JSONB (non-breaking)';
COMMENT ON COLUMN shots.cinematography IS 'W1-09 cinematography JSONB (non-breaking)';
COMMENT ON COLUMN shots.context IS 'W1-09 context JSONB (non-breaking)';
COMMENT ON COLUMN shots.generation_meta IS 'W1-09 generation metadata JSONB (non-breaking)';
COMMENT ON COLUMN shots.output IS 'W1-09 output JSONB (non-breaking)';
COMMENT ON COLUMN shots.commerce IS 'W1-09 commerce JSONB (non-breaking)';
