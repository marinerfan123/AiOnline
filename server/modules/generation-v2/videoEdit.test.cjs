'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REWRITE_INTENTS,
  validateRewriteRequest,
  validateReshootRange,
  buildEditOutput,
} = require('./videoEdit.cjs');

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
  const ok = validateReshootRange({ sourceAssetId: 'm-1', startMs: 5000, endMs: 9000, anchorBeforeMs: 3000, anchorAfterMs: 12000, preserveAudio: true });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  // float seconds rejected
  const badFloat = validateReshootRange({ sourceAssetId: 'm-1', startMs: 5.5, endMs: 9 });
  assert.equal(badFloat.ok, false);
  // zero/negative duration rejected
  const badDur = validateReshootRange({ sourceAssetId: 'm-1', startMs: 9000, endMs: 5000 });
  assert.equal(badDur.ok, false);
  // anchors overlapping range rejected
  const badAnchor = validateReshootRange({ sourceAssetId: 'm-1', startMs: 5000, endMs: 9000, anchorBeforeMs: 8000 });
  assert.equal(badAnchor.ok, false);
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
