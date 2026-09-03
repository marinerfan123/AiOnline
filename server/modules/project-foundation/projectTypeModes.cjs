'use strict';
/**
 * W1-05 — Project Type configuration (explicit + extensible).
 *
 * The project_type drives which structure template a project uses. The modern modes are
 * Narrative / Advertising-Promo / E-commerce / Other; legacy values (general, studio, short_drama)
 * are kept valid for backwards compatibility and map deterministically to a modern mode.
 * Pure module (no I/O) for unit-testability.
 */

// Modern project modes (W1-05 acceptance: explicit + extensible).
const PROJECT_MODES = Object.freeze([
  { mode: 'narrative', legacy: ['short_drama', 'studio'] },
  { mode: 'advertising', legacy: [] },
  { mode: 'ecommerce', legacy: [] },
  { mode: 'other', legacy: ['general'] },
]);

const MODE_SET = Object.freeze(PROJECT_MODES.map((m) => m.mode));
const LEGACY_TO_MODE = (() => {
  const map = {};
  for (const { mode, legacy } of PROJECT_MODES) for (const l of legacy) map[l] = mode;
  return Object.freeze(map);
})();

// Legacy values remain valid (kept for compatibility).
const LEGACY_TYPES = Object.freeze(['general', 'studio', 'short_drama']);
const ALLOWED_PROJECT_TYPES = Object.freeze([...MODE_SET, ...LEGACY_TYPES]);

/** Deterministic mapping legacy/modern -> modern mode (default 'other'). */
function resolveProjectMode(projectType) {
  const t = String(projectType || '').toLowerCase();
  if (MODE_SET.includes(t)) return t;
  return LEGACY_TO_MODE[t] || 'other';
}

module.exports = { PROJECT_MODES, MODE_SET, LEGACY_TO_MODE, LEGACY_TYPES, ALLOWED_PROJECT_TYPES, resolveProjectMode };
