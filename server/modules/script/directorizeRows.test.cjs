'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  directorizeRows,
  deriveBeatKind,
  BEAT_KINDS,
  KIND_DURATIONS_MS,
} = require('./directorizeRows.cjs');
const { buildStoryboardPlan } = require('./storyboardPlan.cjs');

// ---------------------------------------------------------------- helpers
let SEQ = 0;
/** Build one script row with a stable id; dialogue rows get a speaker. */
function R(kind, text, over = {}) {
  const row = {
    id: `row-${(SEQ += 1)}`,
    scene_index: 0,
    row_index: 0,
    kind,
    text,
    ...over,
  };
  if (kind === 'dialogue') row.speaker = over.speaker !== undefined ? over.speaker : 'MAYA';
  return row;
}
const D = (speaker, text, over = {}) => R('dialogue', text, { speaker, ...over });
const A = (text, over = {}) => R('action', text, over);
const T = (text, over = {}) => R('transition', text, over);
const SD = (text, over = {}) => R('shot_direction', text, over);

/** One hand-built G13-shaped shot (fields mirror storyboardPlan.cjs shots). */
function SHOT(shotId, shotIndex, over = {}) {
  return {
    shotId,
    beatId: over.beatId || '',
    shotIndex,
    intent: 'action',
    subjectRefs: [],
    camera: { shotSize: 'medium', movement: 'static', angle: 'eye-level' },
    durationMs: 3000,
    ...over,
  };
}
/** One hand-built G13-shaped beat. shots may be a count or an array. */
function BEAT(beatId, sceneIndex, beatIndex, scriptRowIds, shotCount, over = {}) {
  const beat = {
    beatId,
    sceneIndex,
    beatIndex,
    scriptRowIds,
    summary: 'summary',
    shots: Array.from({ length: shotCount }, (_, k) => {
      const s = SHOT(`${beatId}:k${k}`, k, { beatId });
      return s;
    }),
    ...over,
  };
  if (Array.isArray(shotCount)) beat.shots = shotCount;
  return beat;
}

const dirs = (res) => {
  assert.equal(res.ok, true, res.errors ? JSON.stringify(res.errors) : 'ok expected');
  return res.shotDirectives;
};
/** rowsByKind from the test rows, for resolving scriptRowIds -> kinds. */
const rowsOf = (...rows) => rows;

// ------------------------------------------------------------ kind rules
test('deriveBeatKind: dialogue-only (incl parenthetical) -> dialogue; action/shot_direction/header-only -> action', () => {
  assert.equal(deriveBeatKind(['dialogue']), 'dialogue');
  assert.equal(deriveBeatKind(['dialogue', 'parenthetical']), 'dialogue');
  assert.equal(deriveBeatKind(['parenthetical', 'dialogue', 'parenthetical']), 'dialogue');
  assert.equal(deriveBeatKind(['action']), 'action');
  assert.equal(deriveBeatKind(['shot_direction']), 'action');
  assert.equal(deriveBeatKind(['header']), 'action');
  assert.equal(deriveBeatKind(['action', 'action']), 'action');
  assert.equal(deriveBeatKind([]), 'action'); // no dialogue signal -> action family
});

test('deriveBeatKind: dialogue + action/shot_direction -> hybrid; transition-only -> transition', () => {
  assert.equal(deriveBeatKind(['dialogue', 'action']), 'hybrid');
  assert.equal(deriveBeatKind(['dialogue', 'parenthetical', 'action']), 'hybrid');
  assert.equal(deriveBeatKind(['dialogue', 'shot_direction']), 'hybrid');
  assert.equal(deriveBeatKind(['action', 'dialogue']), 'hybrid');
  assert.equal(deriveBeatKind(['transition']), 'transition');
  assert.equal(deriveBeatKind(['transition', 'transition']), 'transition');
  // transition mixed with other kinds is not transition-only: action family wins
  assert.equal(deriveBeatKind(['transition', 'action']), 'action');
  assert.equal(deriveBeatKind(['dialogue', 'transition']), 'dialogue');
  // unknown/absent kinds default to 'dialogue' (effectiveKind semantics)
  assert.equal(deriveBeatKind([undefined, 'dialogue']), 'dialogue');
  assert.equal(deriveBeatKind(['mystery-kind']), 'dialogue');
});

// ------------------------------------------------- validation
test('rejects: beats missing or not an array (ok:false with errors)', () => {
  for (const bad of [undefined, null, {}, 'beats', 42, { beats: 'nope' }, { beats: { 0: {} } }]) {
    const res = directorizeRows(bad);
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.ok(Array.isArray(res.errors) && res.errors.length > 0);
  }
  // beats array present but a member malformed
  const res = directorizeRows({
    beats: [{ beatId: 's0:b0' }], // no shots / scriptRowIds
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes('beats[0]'));
});

test('accepts empty beats input -> ok:true with zero directives', () => {
  const res = directorizeRows({ beats: [] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.shotDirectives, []);
  // empty beats with rows / expandKinds flags also fine
  assert.deepEqual(directorizeRows({ beats: [], rows: [D('MAYA', 'hi')], expandKinds: true }).shotDirectives, []);
});

test('validates every shot durationMs is a positive integer; whole call rejected on any violation', () => {
  const badDurations = [2500.5, '3000', NaN, -1, 0, undefined, null];
  for (const bad of badDurations) {
    const beat = BEAT('s0:b0', 0, 0, ['row-1'], [
      SHOT('s0:b0:k0', 0, { durationMs: bad }),
      SHOT('s0:b0:k1', 1, { durationMs: 3000 }),
    ]);
    const res = directorizeRows({ beats: [beat] });
    assert.equal(res.ok, false, `durationMs=${String(bad)} must be rejected`);
    assert.ok(res.errors.length === 1 && /durationMs must be a positive integer/.test(res.errors[0]), res.errors.join('; '));
  }
  // a later-shot violation still fails the whole call (codebase all-or-nothing style)
  const two = [
    BEAT('s0:b0', 0, 0, ['row-1'], [SHOT('s0:b0:k0', 0, { durationMs: 3000 })]),
    BEAT('s0:b1', 0, 1, ['row-2'], [SHOT('s0:b1:k0', 0, { durationMs: 42.5 })]),
  ];
  const res2 = directorizeRows({ beats: two });
  assert.equal(res2.ok, false);
  assert.ok(res2.errors[0].includes('s0:b1:k0'));
});

// ------------------------------------------- flatten mapping (hand-built)
test('flattens N beats across scenes: every directive maps beat/shot fields exactly', () => {
  const beats = [
    BEAT('s0:b0', 0, 0, ['r0', 'r1'], 2),
    BEAT('s0:b1', 0, 1, ['r2'], 2),
    BEAT('s1:b0', 1, 0, ['r3'], 2),
    BEAT('s1:b1', 1, 1, ['r4', 'r5', 'r6'], 2),
  ];
  const out = dirs(directorizeRows({ beats }));
  assert.equal(out.length, 8);
  const expectations = [
    ['s0:b0:k0', 's0:b0', 0, 1, 0, 'd1'],
    ['s0:b0:k1', 's0:b0', 0, 1, 1, 'd2'],
    ['s0:b1:k0', 's0:b1', 0, 1, 0, 'd3'],
    ['s0:b1:k1', 's0:b1', 0, 1, 1, 'd4'],
    ['s1:b0:k0', 's1:b0', 1, 2, 0, 'd5'],
    ['s1:b0:k1', 's1:b0', 1, 2, 1, 'd6'],
    ['s1:b1:k0', 's1:b1', 1, 2, 0, 'd7'],
    ['s1:b1:k1', 's1:b1', 1, 2, 1, 'd8'],
  ];
  expectations.forEach(([shotId, beatId, sceneIndex, sceneOrdinal, shotIndex, directiveId], i) => {
    const d = out[i];
    assert.equal(d.directiveId, directiveId);
    assert.equal(d.shotId, shotId);
    assert.equal(d.beatId, beatId);
    assert.equal(d.sceneIndex, sceneIndex);
    assert.equal(d.sceneOrdinal, sceneOrdinal);
    assert.equal(d.shotIndex, shotIndex);
  });
});

test('no beat dropped, no shot dropped: shotId set, per-beat counts and totalShots all preserved', () => {
  const rows = [
    D('MAYA', 'one', { scene_index: 0 }),
    A('two', { scene_index: 0 }),
    SD('three', { scene_index: 0 }),
    D('LEO', 'four', { scene_index: 0 }),
    A('five', { scene_index: 1 }),
    D('MAYA', 'six', { scene_index: 1 }),
    D('LEO', 'seven', { scene_index: 1 }),
    A('eight', { scene_index: 1 }),
  ];
  const plan = buildStoryboardPlan({ rows });
  const out = dirs(directorizeRows({ beats: plan.beats }));
  // shot count identical (G13 2 shots per beat)
  assert.equal(out.length, plan.totalShots);
  assert.equal(out.length, plan.beats.length * 2);
  // no dropped shot: set equality with the source shots
  const srcShots = plan.beats.flatMap((b) => b.shots.map((s) => s.shotId));
  assert.deepEqual(out.map((d) => d.shotId), srcShots); // order identical too
  assert.equal(new Set(out.map((d) => d.shotId)).size, out.length); // unique
  // no dropped beat: every beat contributes all of its shots, contiguous
  const perBeat = new Map();
  for (const d of out) perBeat.set(d.beatId, (perBeat.get(d.beatId) || 0) + 1);
  assert.deepEqual([...perBeat.keys()], plan.beats.map((b) => b.beatId));
  for (const b of plan.beats) assert.equal(perBeat.get(b.beatId), b.shots.length);
  // directiveId is a dense 1-based flattened sequence
  assert.equal(out[0].directiveId, 'd1');
  assert.equal(out[out.length - 1].directiveId, `d${out.length}`);
  assert.deepEqual(out.map((d) => Number(d.directiveId.slice(1))), Array.from({ length: out.length }, (_, i) => i + 1));
});

test('sceneOrdinal is 1-based by scene appearance even when scene_index is not contiguous', () => {
  const beats = [
    BEAT('s0:b0', 0, 0, ['r0'], 2),
    BEAT('s5:b0', 5, 0, ['r1'], 2),
    BEAT('s5:b1', 5, 1, ['r2'], 2),
  ];
  const out = dirs(directorizeRows({ beats }));
  assert.deepEqual(out.map((d) => d.sceneOrdinal), [1, 1, 2, 2, 2, 2]);
  assert.deepEqual(out.map((d) => d.sceneIndex), [0, 0, 5, 5, 5, 5]);
});

test('passthrough of intent/subjectRefs/camera; camera falls back to the G13 explicit default when absent', () => {
  const refs = [{ entityType: 'character', entityId: 'char-maya', label: 'MAYA' }];
  const shot = SHOT('s0:b0:k0', 0, {
    intent: 'dialogue',
    subjectRefs: refs,
    camera: { shotSize: 'close-up', movement: 'static', angle: 'high-angle' },
  });
  const bareShot = SHOT('s0:b0:k1', 1);
  delete bareShot.camera;
  const beat = BEAT('s0:b0', 0, 0, ['r0'], [shot, bareShot]);
  const out = dirs(directorizeRows({ beats: [beat] }));
  assert.deepEqual(out[0].camera, { shotSize: 'close-up', movement: 'static', angle: 'high-angle' });
  assert.deepEqual(out[0].subjectRefs, refs);
  assert.equal(out[0].intent, 'dialogue');
  assert.deepEqual(out[1].camera, { shotSize: 'medium', movement: 'static', angle: 'eye-level' }); // S6 fallback, never nil
  assert.deepEqual(out[1].subjectRefs, []);
});

// -------------------------------------------- kind derivation end-to-end
test('directive kind is derived from the beat rows kinds (dialogue/action/hybrid/transition)', () => {
  // Scene grouping + shot_direction boundaries force the exact beat mixes:
  //   s0: [dialogue, dialogue] | SD | [dialogue, action, action] (R2/R3)
  //   s1: [header] alone (tail flush) — header-only beat
  const rows = [
    D('MAYA', 'd0', { scene_index: 0 }),
    D('LEO', 'd1', { scene_index: 0 }), //                    -> dialogue beat
    SD('CLOSE ON: the letter', { scene_index: 0 }), //        -> action beat (shot_direction feeds action family)
    D('MAYA', 'd2', { scene_index: 0 }),
    A('a0', { scene_index: 0 }),
    A('a1', { scene_index: 0 }), //                           -> hybrid beat
    R('header', 'INT. HALL - NIGHT', { scene_index: 1 }), //  -> action beat (header-only)
  ];
  const plan = buildStoryboardPlan({ rows });
  const out = dirs(directorizeRows({ beats: plan.beats, rows }));
  // expected beat kind keyed by the beat's first scriptRowId
  const expectedByFirstRow = new Map([
    [rows[0].id, 'dialogue'], // [d0, d1]
    [rows[2].id, 'action'], //   [SD]
    [rows[3].id, 'hybrid'], //   [d2, a0, a1]
    [rows[6].id, 'action'], //   [header]
  ]);
  assert.equal(plan.beats.length, expectedByFirstRow.size); // one beat per expectation
  for (const d of out) assert.ok(BEAT_KINDS.includes(d.kind));
  for (const beat of plan.beats) {
    const expected = expectedByFirstRow.get(beat.scriptRowIds[0]);
    assert.ok(expected !== undefined, `unexpected beat ${beat.beatId}`);
    const beatDirs = out.filter((x) => x.beatId === beat.beatId);
    assert.equal(beatDirs.length, beat.shots.length);
    assert.ok(beatDirs.every((x) => x.kind === expected), `${beat.beatId} -> ${beatDirs.map((x) => x.kind)}`);
  }
  // row-level spot checks
  const kindOf = (rowId) => out.find((d) => d.beatId === plan.beats.find((b) => b.scriptRowIds.includes(rowId)).beatId).kind;
  assert.equal(kindOf(rows[0].id), 'dialogue');
  assert.equal(kindOf(rows[4].id), 'hybrid');
  assert.equal(kindOf(rows[2].id), 'action'); // shot_direction-only beat
});

test('rows omitted: derivation is deterministic and non-fatal (unknown rows default to dialogue)', () => {
  const beat = BEAT('s0:b0', 0, 0, ['r0', 'r1'], 2);
  const a = dirs(directorizeRows({ beats: [beat] }));
  const b = dirs(directorizeRows({ beats: [beat] }));
  assert.deepEqual(a, b); // deterministic / idempotent
  assert.equal(a[0].kind, 'dialogue'); // documented effectiveKind default
  assert.deepEqual(a[0].sourceRows, [{ id: 'r0' }, { id: 'r1' }]); // ids only, no fabricated kind
});

test('sourceRows carries resolved row descriptors ({id, kind, speaker, text}) in scriptRowIds order', () => {
  const row1 = D('MAYA', 'Hello.', { id: 'row-a' });
  const row2 = A('She waits.', { id: 'row-b' });
  const beat = BEAT('s0:b0', 0, 0, ['row-a', 'row-b'], 2);
  const out = dirs(directorizeRows({ beats: [beat], rows: [row1, row2] }));
  for (const d of out) {
    assert.deepEqual(d.sourceRows, [
      { id: 'row-a', kind: 'dialogue', speaker: 'MAYA', text: 'Hello.' },
      { id: 'row-b', kind: 'action', text: 'She waits.' },
    ]);
  }
});

// ------------------------------------------------------------ durationMs
test('expandKinds off (default): durationMs is kept as the G13 value (3000) for every kind', () => {
  const rows = [
    D('MAYA', 'd'), A('a1'), A('a2'), // dialogue+action -> hybrid
    T('FADE OUT.'),
  ];
  const plan = buildStoryboardPlan({ rows });
  const out = dirs(directorizeRows({ beats: plan.beats, rows }));
  assert.ok(out.length > 0);
  for (const d of out) assert.equal(d.durationMs, 3000); // G13 S5 untouched
});

test('expandKinds true: durationMs is kind-化 dialogue/hybrid 3000, action 2500, transition 1000', () => {
  // s0: [dialogue, dialogue] | SD | [dialogue, action, action]; s1: [transition] tail
  const rows = [
    D('MAYA', 'd0', { scene_index: 0 }),
    D('LEO', 'd1', { scene_index: 0 }), //                      dialogue beat
    SD('CLOSE ON: hands', { scene_index: 0 }), //               action beat
    D('MAYA', 'd2', { scene_index: 0 }),
    A('a0', { scene_index: 0 }),
    A('a1', { scene_index: 0 }), //                             hybrid beat
    T('FADE TO BLACK.', { scene_index: 1 }), //                 transition beat
  ];
  const plan = buildStoryboardPlan({ rows });
  const out = dirs(directorizeRows({ beats: plan.beats, rows, expandKinds: true }));
  for (const d of out) {
    assert.equal(d.durationMs, KIND_DURATIONS_MS[d.kind], `${d.shotId} kind=${d.kind}`);
  }
  // spot-check per kind against the doc v3 table values
  const kindsSeen = new Set(out.map((d) => d.kind));
  assert.deepEqual([...kindsSeen].sort(), ['action', 'dialogue', 'hybrid', 'transition']);
  const byKind = (k) => {
    const found = out.filter((d) => d.kind === k);
    assert.ok(found.length > 0, `no directive of kind ${k}`);
    return found[0].durationMs;
  };
  assert.equal(byKind('dialogue'), 3000);
  assert.equal(byKind('hybrid'), 3000);
  assert.equal(byKind('action'), 2500);
  assert.equal(byKind('transition'), 1000);
  // custom non-default G13 durations survive when expandKinds is off only
  const hand = BEAT('s0:b0', 0, 0, ['r0'], 2, {
    shots: [SHOT('s0:b0:k0', 0, { durationMs: 1234 }), SHOT('s0:b0:k1', 1, { durationMs: 1234 })],
  });
  const off = dirs(directorizeRows({ beats: [hand], rows: [A('x', { id: 'r0' })] }));
  assert.ok(off.every((d) => d.durationMs === 1234));
  const on = dirs(directorizeRows({ beats: [hand], rows: [A('x', { id: 'r0' })], expandKinds: true }));
  assert.ok(on.every((d) => d.durationMs === 2500)); // action beat kind-化
});

// ---------------------------------------- end-to-end G13 single-source run
test('full pipeline: buildStoryboardPlan -> directorizeRows flattens everything with valid kinds (single source of truth)', () => {
  const rows = [
    R('header', 'INT. OFFICE - DAY', { scene_index: 0 }),
    D('MAYA', 'You never called.', { scene_index: 0 }),
    D('LEO', 'I was busy.', { scene_index: 0 }),
    A('Maya turns away.', { scene_index: 0 }),
    SD('CLOSE ON: the phone', { scene_index: 0 }),
    A('It buzzes.', { scene_index: 0 }),
    T('CUT TO:', { scene_index: 1 }),
    D('MAYA', 'Now what?', { scene_index: 1 }),
    D('LEO', 'We go.', { scene_index: 1 }),
    A('They leave.', { scene_index: 2 }),
    A('Door closes.', { scene_index: 2 }),
  ];
  const plan = buildStoryboardPlan({ rows });
  const res = directorizeRows({ beats: plan.beats, rows, expandKinds: true });
  assert.equal(res.ok, true);
  const out = res.shotDirectives;
  assert.equal(out.length, plan.totalShots);
  assert.equal(out.length, plan.beats.reduce((n, b) => n + b.shots.length, 0));
  assert.equal(new Set(out.map((d) => d.directiveId)).size, out.length);
  // ordering is (sceneIndex, beatIndex, shotIndex) lexicographic
  const key = (d) => `${d.sceneIndex}:${d.beatId.split(':b')[1]}:${d.shotIndex}`;
  const sortedKeys = out.map(key).slice().sort();
  assert.deepEqual(out.map(key), sortedKeys);
  // kinds restricted to the enum; dialogue shots keep G13 intents
  for (const d of out) {
    assert.ok(BEAT_KINDS.includes(d.kind));
    assert.ok(['dialogue', 'reaction', 'action'].includes(d.intent));
    assert.ok(d.durationMs === KIND_DURATIONS_MS[d.kind]);
    assert.ok(d.sourceRows.length > 0 && d.sourceRows.every((r) => r.id));
    assert.ok(d.camera && d.camera.shotSize === 'medium' && d.camera.movement === 'static' && d.camera.angle === 'eye-level');
  }
});
