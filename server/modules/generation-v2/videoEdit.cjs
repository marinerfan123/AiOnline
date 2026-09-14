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

// §13 ReferenceBinding shape: entityType / source enums.
const REFERENCE_ENTITY_TYPES = Object.freeze(['character', 'location', 'prop', 'style', 'asset']);
const REFERENCE_SOURCES = Object.freeze(['manual', 'autolink', 'agent']);

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
 * Reshoot range semantics (04 §9): the edited range is the half-open interval
 * [startMs, endMs) on the source timeline; anchorBeforeMs/anchorAfterMs are
 * optional single-point context windows a provider may use to preserve identity
 * across the splice. An anchor must not fall INSIDE the edited range:
 *   anchorBeforeMs < startMs   (== startMs is inside → rejected)
 *   anchorAfterMs  >= endMs    (== endMs is legal → endMs is excluded)
 * The range must be strictly positive. Required fields per §9:
 * preserveAudio / preserveIdentity / preserveCamera (boolean),
 * referenceBindings (ReferenceBinding[] per §13), modelBindingId (string),
 * params (object).
 */
function validateReshootRange(req = {}) {
  const errors = [];
  if (!req.sourceAssetId || typeof req.sourceAssetId !== 'string') errors.push('sourceAssetId 必填');
  assertMs(req.startMs, 'startMs', errors);
  assertMs(req.endMs, 'endMs', errors);
  if (req.endMs <= req.startMs) errors.push('endMs 必须大于 startMs');
  for (const k of ['anchorBeforeMs', 'anchorAfterMs']) {
    if (req[k] !== undefined && req[k] !== null) assertMs(req[k], k, errors);
  }
  // Anchor boundary (half-open [startMs, endMs)): reject anchors inside the range.
  if (Number.isInteger(req.anchorBeforeMs) && Number.isInteger(req.startMs)) {
    if (req.anchorBeforeMs >= req.startMs) errors.push('anchorBeforeMs 不得进入编辑区间');
  }
  if (Number.isInteger(req.anchorAfterMs) && Number.isInteger(req.endMs)) {
    if (req.anchorAfterMs < req.endMs) errors.push('anchorAfterMs 不得进入编辑区间');
  }
  // §9 required fields (presence + type).
  if (req.preserveAudio === undefined) errors.push('preserveAudio 必填');
  else if (typeof req.preserveAudio !== 'boolean') errors.push('preserveAudio 必须为 boolean');
  if (req.preserveIdentity === undefined) errors.push('preserveIdentity 必填');
  else if (typeof req.preserveIdentity !== 'boolean') errors.push('preserveIdentity 必须为 boolean');
  if (req.preserveCamera === undefined) errors.push('preserveCamera 必填');
  else if (typeof req.preserveCamera !== 'boolean') errors.push('preserveCamera 必须为 boolean');
  if (typeof req.modelBindingId !== 'string' || req.modelBindingId.trim().length === 0) {
    errors.push('modelBindingId 必填');
  }
  if (typeof req.params !== 'object' || req.params === null || Array.isArray(req.params)) {
    errors.push('params 必须为对象');
  }
  if (!Array.isArray(req.referenceBindings)) {
    errors.push('referenceBindings 必填且为数组');
  } else {
    req.referenceBindings.forEach((b, i) => {
      if (b === null || typeof b !== 'object' || Array.isArray(b)) {
        errors.push(`referenceBindings[${i}] 必须为对象`);
        return;
      }
      if (typeof b.id !== 'string' || b.id.trim().length === 0) errors.push(`referenceBindings[${i}].id 必填`);
      if (typeof b.token !== 'string' || b.token.trim().length === 0) errors.push(`referenceBindings[${i}].token 必填`);
      if (!REFERENCE_ENTITY_TYPES.includes(b.entityType)) errors.push(`referenceBindings[${i}].entityType 必须为 ${REFERENCE_ENTITY_TYPES.join('|')}`);
      if (typeof b.entityId !== 'string' || b.entityId.trim().length === 0) errors.push(`referenceBindings[${i}].entityId 必填`);
      if (!REFERENCE_SOURCES.includes(b.source)) errors.push(`referenceBindings[${i}].source 必须为 ${REFERENCE_SOURCES.join('|')}`);
    });
  }
  return { ok: errors.length === 0, errors };
}

/** Immutable edit output contract: an edit maps to a NEW version descriptor. */
function buildEditOutput({ sourceAssetId, kind = 'video', editType, intent }) {
  return {
    sourceAssetId,
    kind,
    editType,
    intent,
    outputAssetId: null, // 恒 null 直到资产管线接线（见 G08 versions 整改）；永不覆盖 source
    immutability: 'new-asset-version-per-edit',
  };
}

module.exports = { REWRITE_INTENTS, validateRewriteRequest, validateReshootRange, buildEditOutput };
