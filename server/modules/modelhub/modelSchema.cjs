'use strict';
/**
 * G07 — Model Schema / Capability projection (Blueprint 04 §1-2, 03 §20).
 * Pure mapper: raw model row (legacy `models`: capabilities/param_template/
 * modes JSONB + provider row) → blueprint-canonical public shape:
 *   { bindingId, name, capabilities (video.* / text2image booleans + limits),
 *     schema: { version, properties, modes, validationRules } }
 * Provider-native field names live ONLY in this adapter mapping layer —
 * business/UI code never switches on model names (00 §3.5).
 *
 * Capability aliases: the runtime registry uses generation vocabulary
 * (text_to_image / image_to_video / text_to_video); the blueprint canonical
 * vocabulary is capability-tree style (image.text2image / video.image2video /
 * video.text2video). The public projection exposes BOTH (blueprint-canonical
 * for parity surfaces, legacy aliases for existing registry/planner code).
 */

const LEGACY_TO_CANONICAL = {
  text_to_image: 'image.text2image',
  image_to_video: 'video.image2video',
  text_to_video: 'video.text2video',
};

const CANONICAL_KEYS = [
  'image.text2image', 'image.image2image', 'image.multiReference', 'image.relight',
  'image.inpaint', 'image.erase', 'image.backgroundRemove', 'image.gridSplit',
  'image.annotate', 'image.crop', 'image.enhance', 'image.outpaint', 'image.focusEdit',
  'video.text2video', 'video.image2video', 'video.frames2video', 'video.video2video',
  'video.audioDriven', 'video.mixedReference', 'video.nativeAudio', 'video.segmentReshoot',
  'video.rewrite', 'video.trim', 'video.frameAnalysis',
  'video.maxDurationMs', 'reference.image.max', 'reference.video.max', 'reference.audio.max',
  'camera.structuredControl', 'audio.tts', 'text.generate', 'text.rewrite', 'text.translate',
];

const NUMERIC_KEYS = new Set([
  'video.maxDurationMs', 'reference.image.max', 'reference.video.max', 'reference.audio.max',
]);

/** Normalize a raw capabilities object to canonical booleans (both dialects). */
function normalizeCapabilities(rawCapabilities = {}, raw = {}) {
  const cap = { ...(rawCapabilities || {}) };
  const out = {};
  for (const k of Object.keys(cap)) {
    const canonical = LEGACY_TO_CANONICAL[k] || k;
    if (NUMERIC_KEYS.has(canonical)) out[canonical] = Number(cap[k]);
    else out[canonical] = Boolean(cap[k]);
  }
  for (const k of CANONICAL_KEYS) {
    if (k in out) continue;
    if (NUMERIC_KEYS.has(k)) out[k] = Number(raw[k] ?? 0);
  }
  return out;
}

/** Project one raw model row → blueprint public binding shape. */
function projectModelBinding(row, providerRow = {}) {
  const caps = normalizeCapabilities(row.capabilities, row);
  const template = row.param_template && typeof row.param_template === 'object'
    ? row.param_template
    : (typeof row.parameters === 'object' ? row.parameters : {});
  const modes = (row.modes && typeof row.modes === 'object')
    ? row.modes
    : (template.modes && typeof template.modes === 'object' ? template.modes : {});

  const properties = {};
  if (template && typeof template === 'object') {
    for (const [k, v] of Object.entries(template)) {
      if (k === 'modes' || k === 'validationRules') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const t = String(v.type || 'string');
        properties[k] = {
          displayName: String(v.label || k),
          type: ['string', 'number', 'boolean', 'enum'].includes(t) ? t : 'string',
          ...(v.default !== undefined ? { default: v.default } : {}),
          ...(Array.isArray(v.enum) ? { enum: v.enum } : {}),
          ...(v.min !== undefined ? { min: Number(v.min) } : {}),
          ...(v.max !== undefined ? { max: Number(v.max) } : {}),
          ...(v.step !== undefined ? { step: Number(v.step) } : {}),
          ...(v.component ? { component: String(v.component) } : {}),
          originalField: k,
        };
      } else {
        properties[k] = { displayName: String(k), type: 'string', default: v, originalField: k };
      }
    }
  }

  return {
    bindingId: row.model_id || row.id,
    name: String(row.name || row.model_id || row.id),
    provider: String(providerRow.name || providerRow.id || row.provider_id || ''),
    capabilities: caps,
    schema: {
      version: String(row.schema_version || row.param_schema_version || '1'),
      properties,
      modes,
      validationRules: Array.isArray(template.validationRules) ? template.validationRules : [],
    },
    // legacy aliases for the existing registry/planner vocabulary
    legacyCapabilities: Object.fromEntries(
      Object.entries(LEGACY_TO_CANONICAL).map(([legacy, canonical]) =>
        [legacy, Boolean(caps[canonical])]),
    ),
  };
}

module.exports = { projectModelBinding, normalizeCapabilities, LEGACY_TO_CANONICAL, CANONICAL_KEYS };
