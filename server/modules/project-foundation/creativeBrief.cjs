'use strict';
/**
 * W1-01 — Creative Brief schema + validation
 *
 * The Creative Brief is the locked input contract for a project (Shot-centric product
 * generation). Stored as `projects.creative_brief` JSONB (0018 migration) and validated
 * here. This module is pure (no I/O) so it is unit-testable in isolation; the project
 * routes persist/return it via `projects.creative_brief`.
 *
 * Fields (W1-01 acceptance): goal, audience, platform, duration, aspect_ratio, language,
 *   key_message, cta, brand, tone, style, references, budget, deadline, deliverables, restrictions.
 */

const CREATIVE_BRIEF_FIELDS = Object.freeze([
  'goal', 'audience', 'platform', 'duration', 'aspect_ratio', 'language', 'key_message',
  'cta', 'brand', 'tone', 'style', 'references', 'budget', 'deadline', 'deliverables', 'restrictions',
]);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isNonNegativeNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isIsoDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isStringOrObject = (v) => isNonEmptyString(v) || (v && typeof v === 'object' && !Array.isArray(v));
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// platform allowlist (verified products); empty string means "not set yet".
const PLATFORMS = new Set(['douyin', 'kuaishou', 'video', 'xhs', 'tiktok', '']);

function validateCreativeBrief(brief) {
  const errors = [];
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return { ok: false, errors: ['creative_brief must be an object'] };
  for (const k of Object.keys(brief)) {
    if (!CREATIVE_BRIEF_FIELDS.includes(k)) errors.push(`unknown field: ${k}`);
  }
  // required + typed
  if (!isNonEmptyString(brief.goal)) errors.push('goal is required (non-empty string)');
  if (!isNonEmptyString(brief.audience)) errors.push('audience is required (non-empty string)');
  if (brief.platform !== undefined) {
    const p = Array.isArray(brief.platform) ? brief.platform : [brief.platform];
    if (!p.length || p.some((x) => !PLATFORMS.has(String(x).toLowerCase()))) errors.push('platform must be in ' + [...PLATFORMS].filter(Boolean).join(', '));
  }
  if (brief.duration !== undefined && !isNonNegativeNumber(brief.duration)) errors.push('duration must be a non-negative number (seconds)');
  if (brief.aspect_ratio !== undefined && !/^\d+\s*:\s*\d+$/.test(String(brief.aspect_ratio))) errors.push('aspect_ratio must match "9:16" (W:H)');
  if (brief.language !== undefined && !isNonEmptyString(brief.language)) errors.push('language must be a non-empty string');
  if (brief.key_message !== undefined && !isNonEmptyString(brief.key_message)) errors.push('key_message must be a non-empty string');
  if (brief.cta !== undefined && !isNonEmptyString(brief.cta)) errors.push('cta must be a non-empty string');
  if (brief.brand !== undefined && !isStringOrObject(brief.brand)) errors.push('brand must be a string or object');
  if (brief.tone !== undefined && !(isNonEmptyString(brief.tone) || isStringArray(brief.tone))) errors.push('tone must be a string or array of strings');
  if (brief.style !== undefined && !(isNonEmptyString(brief.style) || isStringArray(brief.style))) errors.push('style must be a string or array of strings');
  if (brief.references !== undefined && !(isStringArray(brief.references) || (Array.isArray(brief.references) && brief.references.every((x) => x && typeof x === 'object')))) errors.push('references must be an array of strings or objects');
  if (brief.budget !== undefined && !(isNonNegativeNumber(brief.budget) || (brief.budget && typeof brief.budget === 'object'))) errors.push('budget must be a non-negative number or object');
  if (brief.deadline !== undefined && !isIsoDate(brief.deadline)) errors.push('deadline must be an ISO date string');
  if (brief.deliverables !== undefined && !isStringArray(brief.deliverables)) errors.push('deliverables must be an array of strings');
  if (brief.restrictions !== undefined && !isStringArray(brief.restrictions)) errors.push('restrictions must be an array of strings');
  return { ok: errors.length === 0, errors };
}

function sanitizeCreativeBrief(input) {
  // Coerce only the known fields (app-layer); unknown keys dropped.
  const out = {};
  for (const k of CREATIVE_BRIEF_FIELDS) if (input?.[k] !== undefined) out[k] = input[k];
  return out;
}

module.exports = { CREATIVE_BRIEF_FIELDS, PLATFORMS, validateCreativeBrief, sanitizeCreativeBrief };
