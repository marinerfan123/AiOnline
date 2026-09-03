'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { IR_VERSION, buildPromptIr, validatePromptIr } = require('./promptIr.cjs');

const SHOT = { id: 's1', seq: 3, title: 'Opening', storyIntent: { synopsis: 'intro' }, cinematography: { lens: '35mm' }, context: { scene: 1, continuityPlaceholders: [{ key: 'hero', desc: 'Neo' }], characterStates: [{ id: 'c1', state: 'calm' }] } };
const SPEC = { aspect_ratio: '9:16', resolution: '1080x1920', duration: 30, fps: 30, platform: 'douyin', subtitles: true, safe_area: { x: 0.1 }, variants: [] };

test('buildPromptIr carries shot intent/camera/references/spec/policy + version', () => {
  const ir = buildPromptIr({ shot: SHOT, deliverySpec: SPEC, references: [{ type: 'character', name: 'Neo', id: 'c1', role: 'hero' }], camera: { lens: '35mm', angle: 'low' } });
  assert.equal(ir.ir_version, IR_VERSION);
  assert.equal(ir.shot.shotId, 's1');
  assert.equal(ir.deliverySpec.aspectRatio, '9:16');
  assert.equal(ir.references[0].name, 'Neo');
  assert.equal(ir.continuity.placeholders[0].key, 'hero');
  assert.equal(ir.policy.commercialApproved, false);
});

test('roundtrip: build -> JSON -> parse -> validate OK', () => {
  const ir = buildPromptIr({ shot: SHOT, deliverySpec: SPEC, references: [{ type: 'style', name: 'neo-noir' }] });
  const parsed = JSON.parse(JSON.stringify(ir));
  const r = validatePromptIr(parsed);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('validatePromptIr rejects missing shotId / aspectRatio', () => {
  const ir = buildPromptIr({ shot: SHOT, deliverySpec: SPEC });
  ir.shot.shotId = null;
  assert.equal(validatePromptIr(ir).ok, false);
  const ir2 = buildPromptIr({ shot: SHOT, deliverySpec: SPEC });
  ir2.deliverySpec.aspectRatio = null;
  assert.equal(validatePromptIr(ir2).ok, false);
});

test('references bounded + references array enforced', () => {
  const many = references(20);
  const ir = buildPromptIr({ shot: SHOT, deliverySpec: SPEC, references: many });
  assert.ok(ir.references.length <= 20);
  const bad = buildPromptIr({ shot: SHOT, deliverySpec: SPEC });
  assert.equal(validatePromptIr({ ...bad, references: 'x' }).ok, false);
});
function references(n) { return Array.from({ length: n }, (_, i) => ({ type: 'camera', name: `r${i}` })); }

test('keyVisuals bounded to 12', () => {
  const ir = buildPromptIr({ shot: SHOT, deliverySpec: SPEC, intent: { keyVisuals: Array.from({ length: 30 }, (_, i) => `v${i}`) } });
  assert.ok(ir.intent.keyVisuals.length <= 12);
});
