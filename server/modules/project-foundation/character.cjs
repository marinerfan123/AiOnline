'use strict';
/**
 * W2-01 — Project-scoped Character authority (domain validation + legacy adapter).
 * Canonical appearance, references, wardrobe/current wardrobe, voice and state persist under
 * workspace/project scope. Pure module (no I/O) for unit-testability.
 */

/**
 * Adapt a legacy character record (older shape) into the current project_characters shape.
 * Missing new fields get safe defaults; unknown legacy keys are ignored (non-destructive).
 */
function adaptLegacyCharacter(legacy = {}) {
  const { id, project_id, name, appearance, wardrobe, current_wardrobe, voice } = legacy;
  return {
    id: legacy.id || legacy.char_id || legacy.character_id,
    project_id: project_id || legacy.projectId || null,
    workspace_id: legacy.workspace_id || legacy.workspaceId || null,
    name: name || legacy.display_name || legacy.character_name || '',
    canonical_appearance: appearance || legacy.appearance || {},
    reference_ids: Array.isArray(legacy.reference_ids) ? legacy.reference_ids : (legacy.references ? String(legacy.references).split(',').filter(Boolean) : []),
    wardrobe: wardrobe || legacy.wardrobe || {},
    current_wardrobe: current_wardrobe || legacy.currentWardrobe || legacy.current_wardrobe || {},
    voice: voice || legacy.voice || {},
    state: legacy.state || {},
  };
}

/** Validate a character record. Returns {ok, errors[]}. Scoped to workspace/project. */
function validateCharacter(c) {
  const errors = [];
  if (!c) { errors.push('character required'); return { ok: false, errors }; }
  if (!c.workspace_id) errors.push('workspace_id required');
  if (!c.project_id) errors.push('project_id required');
  if (!c.name || (typeof c.name === 'string' && !c.name.trim())) errors.push('name required');
  for (const k of ['canonical_appearance', 'wardrobe', 'current_wardrobe', 'voice', 'state']) {
    if (c[k] != null && (typeof c[k] !== 'object' || Array.isArray(c[k]))) errors.push(`${k} must be a JSON object`);
  }
  if (c.reference_ids != null && (typeof c.reference_ids !== 'object' || Array.isArray(c.reference_ids) === false)) errors.push('reference_ids must be an array');
  return { ok: errors.length === 0, errors };
}

module.exports = { adaptLegacyCharacter, validateCharacter };
