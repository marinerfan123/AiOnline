'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildStoryboardPlan,
  sceneRowsToPlan,
} = require('./storyboardPlan.cjs');
const { buildSceneRows } = require('./scriptModel.cjs');

// ---------------------------------------------------------------- helpers
let SEQ = 0;
/** Build one script row; id auto-unique unless overridden. */
function R(kind, text, over = {}) {
  const row = {
    id: `row-${(SEQ += 1)}`,
    scene_index: 0,
    row_index: 0,
    kind,
    text,
    ...over,
  };
  if (kind === 'dialogue') {
    row.speaker = over.speaker !== undefined ? over.speaker : 'MAYA';
  }
  return row;
}
/** Full dialogue row shorthand. */
const D = (speaker, text, over = {}) => R('dialogue', text, { speaker, ...over });
const A = (text, over = {}) => R('action', text, over);
const SD = (text, over = {}) => R('shot_direction', text, over);

const MAYA_CHAR = { id: 'char-maya', name: 'MAYA' };
const LEO_CHAR = { id: 'char-leo', name: 'LEO' };
const OFFICE_LOC = { id: 'loc-office', name: 'OFFICE' };

// ---------------------------------------------------------- scene grouping
test('scene groups are planned in ascending scene_index order; beatIndex is scene-local', () => {
  const rows = [
    A('z1', { scene_index: 2 }),                          // input deliberately out of order
    D('MAYA', 'a1', { scene_index: 0, row_index: 0 }),
    D('LEO', 'a2', { scene_index: 0, row_index: 1 }),
    A('b1', { scene_index: 1 }),
    A('z2', { scene_index: 2 }),
  ];
  const plan = buildStoryboardPlan({ rows });
  assert.equal(plan.ok, undefined); // success path carries no ok flag
  assert.deepEqual(plan.beats.map((b) => b.sceneIndex), [0, 1, 2]);
  assert.deepEqual(plan.beats.map((b) => b.beatIndex), [0, 0, 0]); // reset per scene
  assert.deepEqual(plan.beats.map((b) => b.beatId), ['s0:b0', 's1:b0', 's2:b0']);
});

test('scriptRowIds cover every input row, in per-scene source order (scene grouping reorders scenes ascending)', () => {
  const rows = [
    A('one', { scene_index: 1 }),
    D('MAYA', 'two', { scene_index: 0 }),
    A('three', { scene_index: 0 }),
    A('four', { scene_index: 1 }),
  ];
  const plan = buildStoryboardPlan({ rows });
  const covered = plan.beats.flatMap((b) => b.scriptRowIds);
  // grouping is per scene; within each scene rows keep source order
  const expected = rows
    .filter((r) => r.scene_index === 0)
    .concat(rows.filter((r) => r.scene_index === 1))
    .map((r) => r.id);
  assert.deepEqual(covered, expected);
  assert.equal(new Set(covered).size, rows.length); // no duplicates
});

// ------------------------------------------------------ beat chunking rules
test('shot_direction row forms its own single-row beat and splits content beats', () => {
  const rows = [
    D('MAYA', 'Hello.'),
    A('She waits.'),
    SD('CLOSE ON: the letter'),
    A('She opens it.'),
  ];
  const plan = buildStoryboardPlan({ rows });
  assert.equal(plan.beats.length, 3);
  assert.equal(plan.beats[0].scriptRowIds.length, 2); // dialogue + action 合流
  assert.deepEqual(plan.beats[1].scriptRowIds, [rows[2].id]);
  assert.equal(plan.beats[2].scriptRowIds.length, 1);
  // every shot_direction row is alone in its beat (R2)
  for (const b of plan.beats) {
    if (b.scriptRowIds.includes(rows[2].id)) {
      assert.equal(b.scriptRowIds.length, 1);
    }
  }
});

test('content beats hold up to 4 rows mixing dialogue and action; a 5th wraps a new beat', () => {
  const rows = [
    D('MAYA', 'd1'), D('LEO', 'd2'), A('a1'), A('a2'),
    A('a3'), // would be the 5th row of one beat
  ];
  const plan = buildStoryboardPlan({ rows });
  assert.equal(plan.beats.length, 2);
  assert.equal(plan.beats[0].scriptRowIds.length, 4);
  assert.equal(plan.beats[1].scriptRowIds.length, 1);
  assert.deepEqual(plan.beats[0].scriptRowIds, rows.slice(0, 4).map((r) => r.id));
});

test('rows without an id get a deterministic fallback scriptRowId', () => {
  const rows = [D('MAYA', 'no id here'), A('neither do I')];
  rows.forEach((r) => delete r.id);
  const plan = buildStoryboardPlan({ rows });
  const ids = plan.beats[0].scriptRowIds;
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(plan.beats[0].beatId, 's0:b0');
});

// ------------------------------------------------------------ shots per beat
test('a dialogue beat yields exactly 2 shots: 主语 dialogue shot + 反打 reaction shot', () => {
  const plan = buildStoryboardPlan({ rows: [D('MAYA', 'I never sent it.'), A('She lowers the page.')] });
  const beat = plan.beats[0];
  assert.equal(beat.shots.length, 2);
  assert.deepEqual(beat.shots.map((s) => s.intent), ['dialogue', 'reaction']);
  assert.deepEqual(beat.shots.map((s) => s.shotIndex), [0, 1]);
  assert.ok(beat.shots.every((s) => s.beatId === beat.beatId));
});

test('default of 2 shots per beat holds for non-dialogue beats too; totalShots counts all', () => {
  const rows = [A('Rain falls on the roof.'), SD('TILT DOWN to the street')];
  const plan = buildStoryboardPlan({ rows });
  assert.equal(plan.beats.length, 2);
  for (const b of plan.beats) assert.equal(b.shots.length, 2);
  assert.equal(plan.totalShots, 4);
});

test('beat and shot ids are unique and position-derived', () => {
  const rows = [
    D('MAYA', 'x', { scene_index: 0 }), D('LEO', 'y', { scene_index: 0 }),
    D('LEO', 'z', { scene_index: 1 }), A('w', { scene_index: 1 }),
  ];
  const plan = buildStoryboardPlan({ rows });
  const beatIds = plan.beats.map((b) => b.beatId);
  const shotIds = plan.beats.flatMap((b) => b.shots.map((s) => s.shotId));
  assert.equal(new Set(beatIds).size, plan.beats.length);
  assert.equal(new Set(shotIds).size, shotIds.length);
  assert.equal(shotIds.length, plan.totalShots);
});

// -------------------------------------------------------------- subjectRefs
test('subjectRefs resolve the dialogue speaker against characters by name', () => {
  const plan = buildStoryboardPlan({
    rows: [D('MAYA', 'Where is it?')],
    characters: [MAYA_CHAR],
  });
  const shot0 = plan.beats[0].shots[0]; // 主语 shot
  assert.deepEqual(shot0.subjectRefs, [
    { entityType: 'character', entityId: 'char-maya', label: 'MAYA' },
  ]);
  // unknown speaker -> [] (never invented)
  const plan2 = buildStoryboardPlan({
    rows: [D('STRANGER', 'Boo.')],
    characters: [MAYA_CHAR],
  });
  assert.deepEqual(plan2.beats[0].shots[0].subjectRefs, []);
});

test('characters matched by id (not only name); speaker may resolve to a location', () => {
  const plan = buildStoryboardPlan({
    rows: [D('MAYA', 'This is my office.')],
    characters: [MAYA_CHAR, LEO_CHAR],
    locations: [OFFICE_LOC],
  });
  const shot0 = plan.beats[0].shots[0];
  assert.equal(shot0.subjectRefs[0].entityType, 'character');
  assert.equal(shot0.subjectRefs[0].entityId, 'char-maya');

  // speaker string equals a character id rather than the display name
  const byId = buildStoryboardPlan({
    rows: [D('char-maya', 'Speaking as id.')],
    characters: [{ id: 'char-maya', name: 'Maya Lin' }],
  });
  assert.deepEqual(byId.beats[0].shots[0].subjectRefs, [
    { entityType: 'character', entityId: 'char-maya', label: 'Maya Lin' },
  ]);

  // speaker that is not a character but matches a location name
  const locPlan = buildStoryboardPlan({
    rows: [D('OFFICE', 'The walls hum.')],
    characters: [MAYA_CHAR],
    locations: [OFFICE_LOC],
  });
  assert.deepEqual(locPlan.beats[0].shots[0].subjectRefs, [
    { entityType: 'location', entityId: 'loc-office', label: 'OFFICE' },
  ]);
});

test('second distinct speaker becomes the 反打 shot subject', () => {
  const plan = buildStoryboardPlan({
    rows: [D('MAYA', 'Go.'), D('LEO', 'Where?'), D('MAYA', 'Away.')],
    characters: [MAYA_CHAR, LEO_CHAR],
  });
  const [s0, s1] = plan.beats[0].shots;
  assert.equal(s0.subjectRefs[0].entityId, 'char-maya'); // 主语 = first speaker
  assert.equal(s1.subjectRefs[0].entityId, 'char-leo');  // 反打 = 2nd distinct speaker
  // single-speaker beat: reverse has no identified listener -> []
  const solo = buildStoryboardPlan({
    rows: [D('MAYA', 'Alone.')],
    characters: [MAYA_CHAR],
  });
  assert.deepEqual(solo.beats[0].shots[1].subjectRefs, []);
});

// --------------------------------------------------------------- timing/camera
test('every shot carries integer durationMs defaulting to 3000 and the explicit camera default', () => {
  const plan = buildStoryboardPlan({
    rows: [D('MAYA', 'Talk.'), A('Boom.')], // one content beat -> 2 default shots
    characters: [MAYA_CHAR],
  });
  assert.equal(plan.beats.length, 1);
  const shots = plan.beats.flatMap((b) => b.shots);
  assert.equal(shots.length, 2);
  for (const s of shots) {
    assert.ok(Number.isInteger(s.durationMs), 'durationMs must be an integer');
    assert.equal(s.durationMs, 3000);
    assert.deepEqual(s.camera, { shotSize: 'medium', movement: 'static', angle: 'eye-level' });
  }
});

test('non-integer or negative timing_ms on a row rejects the whole plan', () => {
  const badFloat = buildStoryboardPlan({ rows: [A('x', { timing_ms: 1200.5 })] });
  assert.equal(badFloat.ok, false);
  assert.ok(badFloat.errors.some((e) => e.includes('timing_ms')));

  const badNeg = buildStoryboardPlan({ rows: [A('x', { timing_ms: -4 })] });
  assert.equal(badNeg.ok, false);

  const badStr = buildStoryboardPlan({ rows: [A('x', { timing_ms: 'not-a-time' })] });
  assert.equal(badStr.ok, false);

  // integer ms input is accepted
  const ok = buildStoryboardPlan({ rows: [A('x', { timing_ms: 2000 })] });
  assert.equal(ok.ok, undefined);
  assert.equal(ok.beats.length, 1);
});

// ------------------------------------------------------------- empty/rejects
test('empty or non-array rows -> { ok: false }', () => {
  assert.deepEqual(buildStoryboardPlan({ rows: [] }), { ok: false, errors: ['rows must be a non-empty array of script rows'] });
  assert.equal(buildStoryboardPlan({ rows: null }).ok, false);
  assert.equal(buildStoryboardPlan({ rows: 'nope' }).ok, false);
  assert.equal(buildStoryboardPlan(null).ok, false);
  assert.equal(buildStoryboardPlan({}).ok, false);
});

test('invalid rows (non-object, missing text, dialogue without speaker) -> { ok: false }', () => {
  assert.equal(buildStoryboardPlan({ rows: [42] }).ok, false);
  assert.equal(buildStoryboardPlan({ rows: [A('')] }).ok, false);
  assert.equal(buildStoryboardPlan({ rows: [D('', 'no speaker')] }).ok, false);
  assert.equal(buildStoryboardPlan({ rows: [A('ok'), D('MAYA', 'ok'), A('bad', { kind: 'singing' })] }).ok, false);
});

test('error messages are index-prefixed so the offending row is traceable', () => {
  const res = buildStoryboardPlan({ rows: [A('fine'), A('broken', { timing_ms: 1.5 })] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.startsWith('rows[1]:')));
});

// ------------------------------------------------------------------ alias
test('sceneRowsToPlan is an alias of buildStoryboardPlan with identical output', () => {
  assert.equal(sceneRowsToPlan, buildStoryboardPlan);
  const rows = [D('MAYA', 'Hi.'), A('Door opens.')];
  assert.deepEqual(sceneRowsToPlan({ rows, characters: [MAYA_CHAR] }), buildStoryboardPlan({ rows, characters: [MAYA_CHAR] }));
});

// ------------------------------------------- 不变量边界（真实脚本混合 kind）
test('consecutive shot_direction rows each form their own single-row beat (no merge, no loss)', () => {
  const rows = [
    A('she turns'),
    SD('CLOSE ON: the letter'),
    SD('PUSH IN: the stamp'),
    SD('TILT DOWN: the floor'),
    A('she reads'),
  ];
  const plan = buildStoryboardPlan({ rows });
  // [A] | [SD1] | [SD2] | [SD3] | [A] → 5 beats
  assert.equal(plan.beats.length, 5);
  assert.deepEqual(plan.beats.map((b) => b.scriptRowIds), [
    [rows[0].id], [rows[1].id], [rows[2].id], [rows[3].id], [rows[4].id],
  ]);
  // every shot_direction row is alone in its beat
  for (const b of plan.beats) {
    const id = b.scriptRowIds[0];
    if (rows.some((r) => r.kind === 'shot_direction' && r.id === id)) {
      assert.equal(b.scriptRowIds.length, 1);
    }
  }
});

test('long dialogue runs chunk stably at 4 rows (9 dialogue rows → 4/4/1 beats, order preserved)', () => {
  const speakers = ['MAYA', 'LEO', 'MAYA', 'LEO', 'MAYA', 'LEO', 'MAYA', 'LEO', 'MAYA'];
  const rows = speakers.map((sp, i) => D(sp, `line ${i}`));
  const plan = buildStoryboardPlan({ rows });
  assert.equal(plan.beats.length, 3);
  assert.deepEqual(plan.beats.map((b) => b.scriptRowIds.length), [4, 4, 1]);
  // 保序：拍平 = 源顺序
  assert.deepEqual(plan.beats.flatMap((b) => b.scriptRowIds), rows.map((r) => r.id));
});

test('R4 invariant on a real mixed-kind script: no row lost, duplicated, or reordered (per-scene contiguous partition)', () => {
  const rows = [
    R('header', 'INT. OFFICE - DAY', { scene_index: 0 }),
    D('MAYA', 'You never called.', { scene_index: 0 }),
    D('LEO', 'I was busy.', { scene_index: 0 }),
    A('Maya turns away.', { scene_index: 0 }),
    SD('CLOSE ON: the phone', { scene_index: 0 }),
    A('It buzzes.', { scene_index: 0 }),
    R('parenthetical', '(beat)', { scene_index: 0 }),
    D('MAYA', 'Now what?', { scene_index: 0 }),
    R('transition', 'CUT TO:', { scene_index: 1 }),
    D('LEO', 'We go.', { scene_index: 1 }),
    A('They leave.', { scene_index: 2 }),
  ];
  const plan = buildStoryboardPlan({ rows });

  // 拍平所有 beat 的 scriptRowIds，必须与按场景分组后的源顺序完全一致
  const expected = buildSceneRows(rows).flatMap((g) => g.rows.map((r) => r.id));
  const covered = plan.beats.flatMap((b) => b.scriptRowIds);
  assert.deepEqual(covered, expected);
  assert.equal(new Set(covered).size, rows.length);   // 不重复
  assert.equal(covered.length, rows.length);          // 不丢失

  // 每个 beat 内行数 ≤ 4，且 shot_direction 行独占 beat
  for (const b of plan.beats) {
    assert.ok(b.scriptRowIds.length >= 1 && b.scriptRowIds.length <= 4);
  }
  // durationMs 恒为整数（S5 默认 3000）
  for (const b of plan.beats) {
    for (const s of b.shots) assert.ok(Number.isInteger(s.durationMs));
  }
});
