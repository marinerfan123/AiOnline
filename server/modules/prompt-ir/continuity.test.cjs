'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateContinuityState, deriveContinuityState, applyContinuityToIr } = require('./continuity.cjs');
const { buildPromptIr } = require('./promptIr.cjs');

const CHAR = { id: 'c1', name: 'Neo', canonical_appearance: { eyes: 'green' }, current_wardrobe: { top: 'coat' }, voice: { pitch: 'low' } };
const ENV = { id: 'e1', name: 'Office', lighting: { key: 'soft' }, props: { desk: true }, time_of_day: 'night', palette: ['#111'] };

test('validateContinuityState requires project/shot scope + array fields', () => {
  assert.equal(validateContinuityState({ project_id: 'p1' }).ok, false); // no shot_id
  const ok = validateContinuityState({ project_id: 'p1', shot_id: 's1', characterStates: [] });
  assert.equal(ok.ok, true);
  assert.equal(validateContinuityState({ project_id: 'p1', shot_id: 's1', characterStates: 'x' }).ok, false);
});

test('deriveContinuityState bundles canonical appearance/wardrobe/voice + environment', () => {
  const st = deriveContinuityState({ characters: [CHAR], environment: ENV, projectId: 'p1', shotId: 's1' });
  assert.equal(st.project_id, 'p1');
  assert.equal(st.characterStates[0].name, 'Neo');
  assert.deepEqual(st.characterStates[0].wardrobe, { top: 'coat' });
  assert.equal(st.environmentStates[0].name, 'Office');
});

test('applyContinuityToIr injects placeholders/characterStates into IR', () => {
  const ir = buildPromptIr({ shot: { id: 's1' }, deliverySpec: { aspect_ratio: '9:16' } });
  const st = deriveContinuityState({ characters: [CHAR], projectId: 'p1', shotId: 's1' });
  const out = applyContinuityToIr(ir, st);
  assert.ok(out.continuity.placeholders.some((p) => p.key === 'c1'));
  assert.equal(out.continuity.characterStates.length, 1);
});
