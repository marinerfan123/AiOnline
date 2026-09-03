'use strict';
/**
 * W1-03 — DeliverySpec schema + validation
 *
 * The DeliverySpec is the locked set of OUTPUT requirements for a project (persisted before
 * generation). Stored as `projects.delivery_spec` JSONB (0019 migration) and validated here.
 * Pure module (no I/O) for unit-testability; the project routes persist/return it.
 *
 * Fields (W1-03 acceptance): aspect_ratio, resolution, duration, fps, platform, subtitles,
 *   audio, safe_area, variants. Explicit defaults + versioning.
 */

const DELIVERY_SPEC_FIELDS = Object.freeze([
  'aspect_ratio', 'resolution', 'duration', 'fps', 'platform', 'subtitles',
  'audio', 'safe_area', 'variants',
]);

// Explicit defaults (W1-03: "persist with explicit defaults").
const DEFAULT_DELIVERY_SPEC = Object.freeze({
  aspect_ratio: '9:16',
  resolution: { width: 1080, height: 1920 },
  duration: 30,
  fps: 30,
  platform: 'douyin',
  subtitles: true,
  audio: 'stereo',
  safe_area: 0.1,
  variants: [],
  version: 1,
});

const PLATFORMS = new Set(['douyin', 'kuaishou', 'video', 'xhs', 'tiktok']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isNonNegativeNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function validateDeliverySpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['delivery_spec must be an object'] };
  for (const k of Object.keys(spec)) if (!DELIVERY_SPEC_FIELDS.includes(k)) errors.push(`unknown field: ${k}`);
  if (spec.aspect_ratio !== undefined && !/^\d+\s*:\s*\d+$/.test(String(spec.aspect_ratio))) errors.push('aspect_ratio must match "9:16" (W:H)');
  if (spec.resolution !== undefined) {
    const r = spec.resolution;
    if (!r || typeof r !== 'object' || !Number.isInteger(r.width) || r.width <= 0 || !Number.isInteger(r.height) || r.height <= 0) errors.push('resolution must be {width,height} positive ints');
  }
  if (spec.duration !== undefined && !isNonNegativeNumber(spec.duration)) errors.push('duration must be a non-negative number');
  if (spec.fps !== undefined && !isPositiveNumber(spec.fps)) errors.push('fps must be a positive number');
  if (spec.platform !== undefined && !PLATFORMS.has(String(spec.platform).toLowerCase())) errors.push('platform must be in ' + [...PLATFORMS].join(', '));
  if (spec.subtitles !== undefined && typeof spec.subtitles !== 'boolean') errors.push('subtitles must be a boolean');
  if (spec.audio !== undefined && !isNonEmptyString(spec.audio)) errors.push('audio must be a non-empty string');
  if (spec.safe_area !== undefined && !(typeof spec.safe_area === 'number' && Number.isFinite(spec.safe_area) && spec.safe_area >= 0 && spec.safe_area <= 1)) errors.push('safe_area must be a number in [0,1]');
  if (spec.variants !== undefined && (!Array.isArray(spec.variants) || spec.variants.some((v) => !v || typeof v !== 'object' || Array.isArray(v)))) errors.push('variants must be an array of objects');
  return { ok: errors.length === 0, errors };
}

function sanitizeDeliverySpec(input, { version } = {}) {
  // Merge explicit defaults, keep only known fields, bump version.
  const out = { ...DEFAULT_DELIVERY_SPEC };
  for (const k of DELIVERY_SPEC_FIELDS) if (input?.[k] !== undefined) out[k] = input[k];
  out.version = Number.isInteger(Number(version)) ? Number(version) + 1 : 1;
  return out;
}

module.exports = { DELIVERY_SPEC_FIELDS, DEFAULT_DELIVERY_SPEC, PLATFORMS, validateDeliverySpec, sanitizeDeliverySpec };
