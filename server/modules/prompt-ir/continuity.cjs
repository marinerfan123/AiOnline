'use strict';
/**
 * W4-11/W4-12 — Continuity state schema + derive/apply service (pure, no I/O).
 * Project-scoped continuity state (character/environment/wardrobe as derived state bound to shots).
 * W4-11: validate/bind a continuity state. W4-12: derive state from character/env + apply to a Shot.
 */

/** Validate a continuity state record bound to a project + shot. */
function validateContinuityState(record, { mode } = {}) {
  const errors = [];
  if (!record) { errors.push('continuity required'); return { ok: false, errors }; }
  if (!record.project_id) errors.push('project_id required');
  if (!record.shot_id) errors.push('shot_id required');
  if (record.characterStates != null && !Array.isArray(record.characterStates)) errors.push('characterStates must be an array');
  if (record.environmentStates != null && !Array.isArray(record.environmentStates)) errors.push('environmentStates must be an array');
  return { ok: errors.length === 0, errors };
}

/** W4-12: derive a continuity state snapshot from characters + environment (canonical appearance/wardrobe/voice). */
function deriveContinuityState({ characters = [], environment = null, projectId, shotId, mode }) {
  const characterStates = characters.map((c) => {
    const cur = c.currentWardrobe || c.current_wardrobe || {};
    return { characterId: c.id, name: c.name, appearance: c.canonical_appearance || c.appearance || {}, wardrobe: cur, voice: c.voice || {} };
  });
  const environmentState = environment
    ? { environmentId: environment.id, name: environment.name, lighting: environment.lighting || {}, props: environment.props || {}, timeOfDay: environment.time_of_day || null, palette: environment.palette || {} }
    : null;
  return {
    project_id: projectId, shot_id: shotId, mode: mode || 'narrative',
    characterStates, environmentStates: environmentState ? [environmentState] : [],
    derivedAt: new Date().toISOString(),
  };
}

/** W4-12: apply a continuity snapshot to a Shot IR (inject placeholders/state into context). */
function applyContinuityToIr(ir, continuity) {
  if (!ir || !ir.continuity) return ir;
  const placeholders = (continuity && continuity.characterStates || []).map((cs) => ({
    key: cs.characterId,
    desc: cs.name ? `${cs.name} (${cs.wardrobe ? 'wardrobe set' : 'canonical'})` : 'character',
  }));
  ir.continuity.placeholders = [...(ir.continuity.placeholders || []), ...placeholders].slice(0, 30);
  ir.continuity.characterStates = [...(ir.continuity.characterStates || []), ...(continuity && continuity.characterStates || [])].slice(0, 30);
  return ir;
}

module.exports = { validateContinuityState, deriveContinuityState, applyContinuityToIr };
