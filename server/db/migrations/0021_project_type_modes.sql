-- 0021_project_type_modes
-- W1-05: Project Type configuration — make project_type explicit + extensible.
-- Adds the modern modes (narrative / advertising / ecommerce / other) alongside the legacy
--   values (general / studio / short_drama) which are kept valid for backwards compatibility.
-- Legacy values are NOT rewritten; the app-layer projectTypeModes.cjs maps them deterministically.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_type_check;

ALTER TABLE projects ADD CONSTRAINT projects_project_type_check
  CHECK (project_type IN ('narrative', 'advertising', 'ecommerce', 'other', 'general', 'studio', 'short_drama'));

COMMENT ON COLUMN projects.project_type IS
  'W1-05 Project Type: narrative/advertising/ecommerce/other (modern modes) + general/studio/short_drama (legacy, mapped by projectTypeModes.cjs)';
