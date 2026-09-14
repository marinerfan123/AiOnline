'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REWRITE_INTENTS,
  validateRewriteRequest,
  validateReshootRange,
  buildEditOutput,
} = require('./videoEdit.cjs');

// A fully valid §9 reshoot request — every required field present.
function validReshoot(overrides = {}) {
  return {
    sourceAssetId: 'm-1',
    startMs: 5000,
    endMs: 9000,
    anchorBeforeMs: 3000,
    anchorAfterMs: 12000,
    prompt: 'new shot',
    preserveAudio: true,
    preserveIdentity: true,
    preserveCamera: false,
    referenceBindings: [],
    modelBindingId: 'video-model-x',
    params: {},
    ...overrides,
  };
}

test('G11: eight rewrite intents registered incl segment_reshoot', () => {
  assert.deepEqual(REWRITE_INTENTS, [
    'visual_restyle', 'environment_replace', 'character_replace', 'object_replace',
    'plot_rewrite', 'camera_rewrite', 'motion_rewrite', 'segment_reshoot',
  ]);
});

test('G11: rewrite request valid for non-reshoot intents', () => {
  const v = validateRewriteRequest({ intent: 'visual_restyle', prompt: 'anime style' });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('G11: unknown intent rejected; prompt required', () => {
  assert.equal(validateRewriteRequest({ intent: 'magic', prompt: 'x' }).ok, false);
  assert.equal(validateRewriteRequest({ intent: 'plot_rewrite', prompt: '  ' }).ok, false);
});

test('G11: reshoot range must be positive integer ms and within semantics', () => {
  const ok = validateReshootRange(validReshoot());
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  // float seconds rejected
  const badFloat = validateReshootRange(validReshoot({ startMs: 5.5, endMs: 9 }));
  assert.equal(badFloat.ok, false);
  // zero/negative duration rejected
  const badDur = validateReshootRange(validReshoot({ startMs: 9000, endMs: 5000 }));
  assert.equal(badDur.ok, false);
  // anchors overlapping range rejected
  const badAnchor = validateReshootRange(validReshoot({ anchorBeforeMs: 8000 }));
  assert.equal(badAnchor.ok, false);
});

test('G11: anchor boundary — half-open [startMs, endMs)', () => {
  // anchorBeforeMs < startMs is legal; == startMs falls inside → rejected.
  assert.equal(validateReshootRange(validReshoot({ anchorBeforeMs: 4999 })).ok, true);
  assert.equal(validateReshootRange(validReshoot({ anchorBeforeMs: 5000 })).ok, false);
  // anchorAfterMs >= endMs is legal (== endMs is excluded from the interval).
  assert.equal(validateReshootRange(validReshoot({ anchorAfterMs: 9000 })).ok, true);
  assert.equal(validateReshootRange(validReshoot({ anchorAfterMs: 9001 })).ok, true);
  assert.equal(validateReshootRange(validReshoot({ anchorAfterMs: 8999 })).ok, false);
});

test('G11: §9 required fields missing → rejected', () => {
  for (const missing of ['preserveAudio', 'preserveIdentity', 'preserveCamera', 'referenceBindings', 'modelBindingId', 'params']) {
    const req = validReshoot();
    delete req[missing];
    const v = validateReshootRange(req);
    assert.equal(v.ok, false, `${missing} missing should fail`);
    assert.ok(v.errors.some((e) => e.includes(missing)), `${missing} error expected, got ${JSON.stringify(v.errors)}`);
  }
});

test('G11: preserve* must be boolean when present', () => {
  assert.equal(validateReshootRange(validReshoot({ preserveAudio: 'yes' })).ok, false);
  assert.equal(validateReshootRange(validReshoot({ preserveIdentity: 1 })).ok, false);
  assert.equal(validateReshootRange(validReshoot({ preserveCamera: null })).ok, false);
});

test('G11: params must be a plain object', () => {
  assert.equal(validateReshootRange(validReshoot({ params: null })).ok, false);
  assert.equal(validateReshootRange(validReshoot({ params: [] })).ok, false);
  assert.equal(validateReshootRange(validReshoot({ params: 'x' })).ok, false);
  assert.equal(validateReshootRange(validReshoot({ params: { durationMs: 1000 } })).ok, true);
});

test('G11: referenceBindings must be an array of valid ReferenceBinding items', () => {
  assert.equal(validateReshootRange(validReshoot({ referenceBindings: 'not-array' })).ok, false);
  // item must be an object
  assert.equal(validateReshootRange(validReshoot({ referenceBindings: [null] })).ok, false);
  assert.equal(validateReshootRange(validReshoot({ referenceBindings: ['x'] })).ok, false);
  // item missing required fields / bad enum
  assert.equal(validateReshootRange(validReshoot({ referenceBindings: [{}] })).ok, false);
  assert.equal(validateReshootRange(validReshoot({
    referenceBindings: [{ id: 'r1', token: 'tok', entityType: 'planet', entityId: 'e1', source: 'manual' }],
  })).ok, false);
  assert.equal(validateReshootRange(validReshoot({
    referenceBindings: [{ id: 'r1', token: 'tok', entityType: 'character', entityId: 'e1', source: 'magic' }],
  })).ok, false);
  // valid item accepted
  assert.equal(validateReshootRange(validReshoot({
    referenceBindings: [{ id: 'r1', token: 'tok', entityType: 'character', entityId: 'e1', source: 'manual' }],
  })).ok, true);
});

test('G11: reshoot without sourceAssetId rejected', () => {
  const v = validateRewriteRequest({ intent: 'segment_reshoot', prompt: 'new shot', startMs: 0, endMs: 3000 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('sourceAssetId')));
});

test('G11: immutable output descriptor — never writes to source', () => {
  const out = buildEditOutput({ sourceAssetId: 'm-9', editType: 'reshoot', intent: 'segment_reshoot' });
  assert.equal(out.sourceAssetId, 'm-9');
  assert.equal(out.outputAssetId, null);
  assert.equal(out.immutability, 'new-asset-version-per-edit');
});
