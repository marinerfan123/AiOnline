'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  storyboardBatchPlan,
  validateBeatsShape,
  deriveImageTaskId,
  composeImagePrompt,
  IMAGE_GEN_KIND,
} = require('./storyboardBatchPlan.cjs');
const { buildStoryboardPlan } = require('./storyboardPlan.cjs');

// ---------------------------------------------------------------- helpers
/** Hand-built shot fixture (storyboardPlan shot shape). */
function SHOT(shotId, over = {}) {
  return {
    shotId,
    intent: 'dialogue',
    subjectRefs: [],
    camera: { shotSize: 'medium', movement: 'static', angle: 'eye-level' },
    ...over,
  };
}
/** One beat holding the given shots. */
function BEAT(shots, over = {}) {
  return { beatId: 'b0', sceneIndex: 0, beatIndex: 0, scriptRowIds: ['r1'], shots, ...over };
}
const CHARS = {
  maya: { entityType: 'character', entityId: 'char-maya', label: 'MAYA' },
  leo: { entityType: 'character', entityId: 'char-leo', label: 'LEO' },
  office: { entityType: 'location', entityId: 'loc-office', label: 'OFFICE' },
};

// ------------------------------------------------------------ N shots → N tasks
test('N shots without produced images → exactly N image_gen tasks, in beats×shots order', () => {
  const beats = [
    BEAT([SHOT('s0:b0:k0', { subjectRefs: [CHARS.maya] }), SHOT('s0:b0:k1', { subjectRefs: [CHARS.leo], intent: 'reaction' })]),
    BEAT([SHOT('s0:b1:k0', { intent: 'action', subjectRefs: [CHARS.office] }), SHOT('s0:b1:k1', { intent: 'action' })], { beatId: 'b1' }),
  ];
  const res = storyboardBatchPlan({ beats });
  assert.equal(res.ok, true);
  assert.equal(res.tasks.length, 4);
  assert.deepEqual(res.tasks.map((t) => t.shotId), ['s0:b0:k0', 's0:b0:k1', 's0:b1:k0', 's0:b1:k1']);
  assert.deepEqual(res.counts, { total: 4, planned: 4, skipped: 0 });
});

test('every task carries exactly { taskId, shotId, kind, params{ prompt, model:null } }', () => {
  const beats = [BEAT([SHOT('s0:b0:k0', { subjectRefs: [CHARS.maya] })])];
  const res = storyboardBatchPlan({ beats });
  const task = res.tasks[0];
  assert.deepEqual(Object.keys(task).sort(), ['kind', 'params', 'shotId', 'taskId']);
  assert.equal(task.kind, 'image_gen');
  assert.equal(task.shotId, 's0:b0:k0');
  assert.deepEqual(Object.keys(task.params).sort(), ['model', 'prompt']);
  assert.equal(task.params.model, null); // routing decides, not the planner
});

// ------------------------------------------------------------- produced skip
test('shots whose image exists (shotImagesByShotId hit) are skipped and counted in counts.skipped', () => {
  const beats = [BEAT([
    SHOT('s0:b0:k0', { subjectRefs: [CHARS.maya] }),
    SHOT('s0:b0:k1', { subjectRefs: [CHARS.leo] }),
    SHOT('s0:b0:k2', { intent: 'action' }),
  ])];
  const res = storyboardBatchPlan({
    beats,
    shotImagesByShotId: { 's0:b0:k1': { assetId: 'img-9', url: 'https://cdn/x.png' } },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.tasks.map((t) => t.shotId), ['s0:b0:k0', 's0:b0:k2']);
  assert.deepEqual(res.counts, { total: 3, planned: 2, skipped: 1 });
});

test('shotImagesByShotId also accepts a Map; all-produced plan yields zero tasks', () => {
  const beats = [BEAT([SHOT('s0:b0:k0'), SHOT('s0:b0:k1')])];
  const lookup = new Map([['s0:b0:k0', 'img-1'], ['s0:b0:k1', 'img-2']]);
  const res = storyboardBatchPlan({ beats, shotImagesByShotId: lookup });
  assert.equal(res.ok, true);
  assert.equal(res.tasks.length, 0);
  assert.deepEqual(res.counts, { total: 2, planned: 0, skipped: 2 });
});

test('only usable records count as produced: absent key or null/""/false value is still planned', () => {
  const beats = [BEAT([
    SHOT('s0:b0:k0'), // absent key
    SHOT('s0:b0:k1'),
    SHOT('s0:b0:k2'),
    SHOT('s0:b0:k3'),
    SHOT('s0:b0:k4'),
  ])];
  const res = storyboardBatchPlan({
    beats,
    shotImagesByShotId: {
      's0:b0:k1': null,    // reserved-but-unfinished row → NOT produced
      's0:b0:k2': '',      // empty placeholder → NOT produced
      's0:b0:k3': false,   // explicit false → NOT produced
      's0:b0:k4': { assetId: 'img-ok' }, // usable → produced
    },
  });
  assert.deepEqual(res.tasks.map((t) => t.shotId), ['s0:b0:k0', 's0:b0:k1', 's0:b0:k2', 's0:b0:k3']);
  assert.deepEqual(res.counts, { total: 5, planned: 4, skipped: 1 });
});

test('absent/undefined shotImagesByShotId → nothing is skipped', () => {
  const beats = [BEAT([SHOT('s0:b0:k0'), SHOT('s0:b0:k1')])];
  const omitted = storyboardBatchPlan({ beats });
  const explicitUndef = storyboardBatchPlan({ beats, shotImagesByShotId: undefined });
  const explicitNull = storyboardBatchPlan({ beats, shotImagesByShotId: null });
  for (const res of [omitted, explicitUndef, explicitNull]) {
    assert.equal(res.ok, true);
    assert.equal(res.counts.planned, 2);
    assert.equal(res.counts.skipped, 0);
  }
});

// ------------------------------------------------------------------- prompt
test('prompt follows the stable template [shotSize] intent, subject labels in ref order', () => {
  const beat = BEAT([SHOT('s0:b0:k0', {
    intent: 'dialogue',
    camera: { shotSize: 'close-up', movement: 'static', angle: 'eye-level' },
    subjectRefs: [CHARS.maya, CHARS.leo],
  })]);
  const { tasks } = storyboardBatchPlan({ beats: [beat] });
  assert.equal(tasks[0].params.prompt, '[close-up] dialogue, MAYA, LEO');
});

test('prompt omits the subject clause when subjectRefs are empty; action/reaction intents pass through', () => {
  const beats = [BEAT([
    SHOT('s0:b0:k0', { intent: 'action' }),
    SHOT('s0:b0:k1', { intent: 'reaction', subjectRefs: [CHARS.leo] }),
  ])];
  const { tasks } = storyboardBatchPlan({ beats });
  assert.equal(tasks[0].params.prompt, '[medium] action');
  assert.equal(tasks[1].params.prompt, '[medium] reaction, LEO');
});

test('prompt contains shotSize + intent + every subject label (string refs and name-fallback refs supported)', () => {
  const beat = BEAT([SHOT('s0:b0:k0', {
    intent: 'dialogue',
    camera: { shotSize: 'wide', movement: 'pan', angle: 'low' },
    subjectRefs: ['MAYA', { entityId: 'char-leo', name: 'LEO' }, CHARS.office],
  })]);
  const { tasks } = storyboardBatchPlan({ beats: [beat] });
  const p = tasks[0].params.prompt;
  assert.ok(p.startsWith('[wide]'), 'prompt starts with [shotSize]');
  assert.ok(p.includes('dialogue'), 'prompt carries the shot intent');
  for (const label of ['MAYA', 'LEO', 'OFFICE']) {
    assert.ok(p.includes(label), `prompt must include subject ${label}`);
  }
  assert.equal(p, '[wide] dialogue, MAYA, LEO, OFFICE'); // order preserved
});

// ------------------------------------------------------- deterministic taskId
test('taskId is deterministic: same input → byte-identical output; unique across shots', () => {
  const beats = [BEAT([SHOT('s0:b0:k0'), SHOT('s0:b0:k1')])];
  const a = storyboardBatchPlan({ beats });
  const b = storyboardBatchPlan({ beats });
  assert.deepEqual(a, b);
  assert.deepEqual(b.tasks, a.tasks);
  const ids = a.tasks.map((t) => t.taskId);
  assert.equal(new Set(ids).size, ids.length);
});

test('taskId is derived from shotId + kind in a fixed way (deriveImageTaskId)', () => {
  const beats = [BEAT([SHOT('s0:b0:k0')])];
  const { tasks } = storyboardBatchPlan({ beats });
  assert.equal(tasks[0].taskId, deriveImageTaskId('s0:b0:k0'));
  assert.equal(tasks[0].taskId, 's0:b0:k0::image_gen');
  assert.ok(tasks[0].taskId.endsWith(`::${IMAGE_GEN_KIND}`));
  assert.equal(tasks[0].kind, IMAGE_GEN_KIND);
});

// --------------------------------------------------- shape validation (R5)
test('beats shape validation rejects shots missing shotId / bad intent / bad camera', () => {
  const cases = [
    SHOT('s0:b0:k0', { shotId: '' }),
    SHOT('s0:b0:k0', { shotId: null }),
    SHOT('s0:b0:k0', { intent: 'singing' }),
    SHOT('s0:b0:k0', { intent: undefined }),
    SHOT('s0:b0:k0', { camera: null }),
    SHOT('s0:b0:k0', { camera: { shotSize: '' } }),
    SHOT('s0:b0:k0', { camera: 'medium' }),
  ];
  cases.forEach((bad, i) => {
    const res = storyboardBatchPlan({ beats: [BEAT([bad])] });
    assert.equal(res.ok, false, `case ${i} must be rejected`);
    assert.ok(res.errors.length > 0, `case ${i} must carry errors`);
  });
  // errors are shot-prefixed so the offending shot is traceable
  const res = storyboardBatchPlan({ beats: [BEAT([SHOT('x', { intent: 'bogus' })])] });
  assert.ok(res.errors[0].startsWith('beats[0].shots[0]:'));
  assert.equal(res.tasks, undefined);
});

test('beats shape validation rejects malformed subjectRefs entries', () => {
  const badEntries = [42, null, {}, { entityId: '' }, { name: '  ' }, []]; // {} has no usable label
  badEntries.forEach((entry, i) => {
    const res = storyboardBatchPlan({
      beats: [BEAT([SHOT('s0:b0:k0', { subjectRefs: [entry] })])],
    });
    assert.equal(res.ok, false, `entry case ${i} must be rejected`);
    assert.ok(res.errors.some((e) => e.includes('subjectRefs[0]')), `case ${i}: ${JSON.stringify(res.errors)}`);
  });
  const notArray = storyboardBatchPlan({ beats: [BEAT([SHOT('s0:b0:k0', { subjectRefs: 'MAYA' })])] });
  assert.equal(notArray.ok, false);
  assert.ok(notArray.errors.some((e) => e.includes('subjectRefs must be an array')));
});

test('duplicate shotId across beats is rejected (would collide taskIds)', () => {
  const res = storyboardBatchPlan({
    beats: [
      BEAT([SHOT('s0:b0:k0')]),
      BEAT([SHOT('s0:b0:k0')]),
    ],
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('duplicate shotId') && e.includes('s0:b0:k0')));
});

test('container shape errors: beat non-object / shots not an array are rejected', () => {
  const nonObjectBeat = storyboardBatchPlan({ beats: [null, 'nope'] });
  assert.equal(nonObjectBeat.ok, false);
  assert.ok(nonObjectBeat.errors.some((e) => e.startsWith('beats[0]:')));
  const noShots = storyboardBatchPlan({ beats: [{ beatId: 'b0', shots: 'missing' }] });
  assert.equal(noShots.ok, false);
  assert.ok(noShots.errors.some((e) => e.includes('shots must be an array')));
  const res = validateBeatsShape([BEAT([SHOT('s0:b0:k0')])]);
  assert.deepEqual(res, []);
});

// -------------------------------------------------------------- empty input
test('empty input: missing/non-array beats → ok:false; empty beats array → valid no-op plan', () => {
  const noArg = storyboardBatchPlan();
  assert.equal(noArg.ok, false);
  assert.ok(noArg.errors.some((e) => e.includes('options object')));

  const noBeats = storyboardBatchPlan({});
  assert.equal(noBeats.ok, false);
  assert.ok(noBeats.errors.some((e) => e.includes('beats must be an array')));

  const beatsNotArray = storyboardBatchPlan({ beats: 'nope' });
  assert.equal(beatsNotArray.ok, false);

  const empty = storyboardBatchPlan({ beats: [] });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(empty.counts, { total: 0, planned: 0, skipped: 0 });
});

test('invalid shotImagesByShotId type is rejected; empty object skips nothing', () => {
  const beats = [BEAT([SHOT('s0:b0:k0')])];
  for (const bad of [42, 'map', ['img-1']]) {
    const res = storyboardBatchPlan({ beats, shotImagesByShotId: bad });
    assert.equal(res.ok, false, `type ${typeof bad} must be rejected`);
  }
  const emptyMap = storyboardBatchPlan({ beats, shotImagesByShotId: {} });
  assert.equal(emptyMap.ok, true);
  assert.equal(emptyMap.counts.planned, 1);
});

// -------------------------------------------- integration via storyboardPlan
test('integration: real buildStoryboardPlan output plans 1 image_gen task per shot with dialogue subjects', () => {
  const plan = buildStoryboardPlan({
    rows: [
      { kind: 'dialogue', speaker: 'MAYA', text: 'Where is the letter?', scene_index: 0 },
      { kind: 'dialogue', speaker: 'LEO', text: 'I burned it.', scene_index: 0 },
      { kind: 'action', text: 'Rain against the window.', scene_index: 0 },
    ],
    characters: [{ id: 'char-maya', name: 'MAYA' }, { id: 'char-leo', name: 'LEO' }],
  });
  assert.equal(plan.beats.length, 1);
  assert.equal(plan.totalShots, 2);

  const res = storyboardBatchPlan({ beats: plan.beats });
  assert.equal(res.ok, true);
  assert.equal(res.counts.total, 2);
  assert.equal(res.counts.planned, 2);
  const [shot0, shot1] = plan.beats[0].shots;
  // shot0 = 主语 dialogue shot of MAYA; shot1 = 反打 reaction shot of LEO
  assert.equal(res.tasks[0].shotId, shot0.shotId);
  assert.equal(res.tasks[0].params.prompt, '[medium] dialogue, MAYA');
  assert.equal(res.tasks[1].params.prompt, '[medium] reaction, LEO');
  // one already-produced shot collapses to a single planned task
  const partial = storyboardBatchPlan({ beats: plan.beats, shotImagesByShotId: { [shot0.shotId]: 'img-1' } });
  assert.deepEqual(partial.tasks.map((t) => t.shotId), [shot1.shotId]);
  assert.deepEqual(partial.counts, { total: 2, planned: 1, skipped: 1 });
});

// ------------------------------------------------------------- composability
test('composeImagePrompt is a pure exported helper usable standalone', () => {
  const p = composeImagePrompt({ intent: 'action', camera: { shotSize: 'medium' }, subjectRefs: [CHARS.office] });
  assert.equal(p, '[medium] action, OFFICE');
});
