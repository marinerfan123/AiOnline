'use strict';
/**
 * G11 — Video Rewrite / Segment Reshoot contract core (Blueprint 04 §8-9).
 * Pure logic (no I/O): VideoEditIntent vocabulary + validation, reshoot range/
 * anchor semantics (range in integer ms, anchors optional context windows),
 * immutable-output rules (every edit produces a NEW asset version; the source
 * asset never mutates). Real provider rewrite execution is a Final-Gate-7 E2E
 * item; this module is the deterministic contract every surface must satisfy.
 */

const REWRITE_INTENTS = Object.freeze([
  'visual_restyle',
  'environment_replace',
  'character_replace',
  'object_replace',
  'plot_rewrite',
  'camera_rewrite',
  'motion_rewrite',
  'segment_reshoot',
]);

function validateRewriteRequest(req = {}) {
  const errors = [];
  const intent = String(req.intent || '').trim();
  if (!REWRITE_INTENTS.includes(intent)) {
    errors.push(`intent must be one of: ${REWRITE_INTENTS.join(', ')}`);
  }
  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) errors.push('prompt 必填');
  if (intent === 'segment_reshoot') {
    const v = validateReshootRange(req);
    errors.push(...v.errors);
  }
  return { ok: errors.length === 0, errors };
}

function assertMs(v, name, errors) {
  if (!Number.isInteger(v) || v < 0) errors.push(`${name} 必须为非负整数毫秒`);
}

/**
 * Reshoot range semantics (04 §9): [startMs, endMs) on the source timeline;
 * anchorBeforeMs/anchorAfterMs are optional context windows that the provider
 * may need to preserve identity across the splice. Anchor windows must not
 * overlap the edited range; range must be strictly positive.
 */
function validateReshootRange(req = {}) {
  const errors = [];
  if (!req.sourceAssetId || typeof req.sourceAssetId !== 'string') errors.push('sourceAssetId 必填');
  assertMs(req.startMs, 'startMs', errors);
  assertMs(req.endMs, 'endMs', errors);
  if (!errors.length) {
    if (req.endMs <= req.startMs) errors.push('endMs 必须大于 startMs');
  }
  for (const k of ['anchorBeforeMs', 'anchorAfterMs']) {
    if (req[k] !== undefined && req[k] !== null) assertMs(req[k], k, errors);
  }
  if (req.anchorBeforeMs !== undefined && req.anchorBeforeMs !== null && req.startMs !== undefined) {
    if (req.anchorBeforeMs > req.startMs) errors.push('anchorBeforeMs 不得进入编辑区间');
  }
  if (req.anchorAfterMs !== undefined && req.anchorAfterMs !== null && req.endMs !== undefined) {
    if (req.anchorAfterMs < req.endMs) errors.push('anchorAfterMs 不得进入编辑区间');
  }
  if (req.preserveAudio !== undefined && typeof req.preserveAudio !== 'boolean') errors.push('preserveAudio 必须为 boolean');
  if (req.preserveIdentity !== undefined && typeof req.preserveIdentity !== 'boolean') errors.push('preserveIdentity 必须为 boolean');
  if (req.preserveCamera !== undefined && typeof req.preserveCamera !== 'boolean') errors.push('preserveCamera 必须为 boolean');
  return { ok: errors.length === 0, errors };
}

/** Immutable edit output contract: an edit maps to a NEW version descriptor. */
function buildEditOutput({ sourceAssetId, kind = 'video', editType, intent }) {
  return {
    sourceAssetId,
    kind,
    editType,
    intent,
    outputAssetId: null, // assigned by the asset pipeline; NEVER overwrites source
    immutability: 'new-asset-version-per-edit',
  };
}

module.exports = { REWRITE_INTENTS, validateRewriteRequest, validateReshootRange, buildEditOutput };
