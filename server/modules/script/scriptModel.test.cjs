'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  SCRIPT_ROW_KINDS,
  validateScriptRow,
  splitScriptToRows,
  buildSceneRows,
} = require('./scriptModel.cjs');

// ---------------------------------------------------------------- validation
test('validateScriptRow: every declared kind is accepted on a minimal valid row', () => {
  for (const kind of SCRIPT_ROW_KINDS) {
    const row = { kind, text: 'some content', speaker: kind === 'dialogue' ? 'MAYA' : undefined };
    assert.equal(validateScriptRow(row).ok, true, `kind=${kind} should pass`);
  }
});

test('validateScriptRow: kind outside the enum is rejected', () => {
  const r = validateScriptRow({ kind: 'singing', text: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('kind must be one of')));
});

test('validateScriptRow: kind defaults to dialogue (matches DB default)', () => {
  const r = validateScriptRow({ speaker: 'MAYA', text: 'Hi.' });
  assert.equal(r.ok, true);
});

test('validateScriptRow: dialogue without speaker is rejected', () => {
  const r = validateScriptRow({ kind: 'dialogue', text: 'Where is the letter?' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('speaker is required')));
});

test('validateScriptRow: dialogue with blank speaker is rejected', () => {
  const r = validateScriptRow({ kind: 'dialogue', speaker: '   ', text: 'x' });
  assert.equal(r.ok, false);
});

test('validateScriptRow: text missing or empty is rejected for every kind', () => {
  assert.equal(validateScriptRow({ kind: 'action' }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: '   ' }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: 42 }).ok, false);
});

test('validateScriptRow: timing_ms float / negative / NaN rejected, integers ok', () => {
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', timing_ms: 1200.5 }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', timing_ms: -5 }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', timing_ms: '12.9' }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', timing_ms: 'not-a-time' }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', timing_ms: 1200 }).ok, true);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', timing_ms: 0 }).ok, true);
  // absent / null timing_ms is fine (column nullable)
  assert.equal(validateScriptRow({ kind: 'action', text: 'x' }).ok, true);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', timing_ms: null }).ok, true);
});

test('validateScriptRow: scene_index / row_index must be non-negative integers', () => {
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', scene_index: -1 }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', row_index: 1.5 }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', scene_index: 'abc' }).ok, false);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', scene_index: 2, row_index: 3 }).ok, true);
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', scene_index: '2' }).ok, true); // integer string ok
  // defaults when absent
  assert.equal(validateScriptRow({ kind: 'action', text: 'x', scene_index: 0, row_index: 0 }).ok, true);
});

test('validateScriptRow: non-object input rejected', () => {
  assert.equal(validateScriptRow(null).ok, false);
  assert.equal(validateScriptRow(undefined).ok, false);
  assert.equal(validateScriptRow('x').ok, false);
});

// ---------------------------------------------------------------- splitter
const SAMPLE_SCRIPT = [
  'INT. OFFICE - NIGHT',                       // 0 header
  '',                                          //    blank -> skipped
  'MAYA sits at her desk, staring at a sealed letter.', // 1 action
  '(beat)',                                    // 2 parenthetical
  '>CLOSE ON: the letter in her hands',        // 3 shot_direction
  'MAYA: I never sent it.',                    // 4 dialogue
  '',                                          //    blank -> skipped
  'She slides it into the drawer.',            // 5 action
].join('\n');

test('splitScriptToRows: per-line kind assertion on a mixed sample', () => {
  const rows = splitScriptToRows(SAMPLE_SCRIPT);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['header', 'action', 'parenthetical', 'shot_direction', 'dialogue', 'action']
  );
});

test('splitScriptToRows: dialogue captures speaker and text; blanks dropped', () => {
  const rows = splitScriptToRows(SAMPLE_SCRIPT);
  const d = rows[4];
  assert.equal(d.kind, 'dialogue');
  assert.equal(d.speaker, 'MAYA');
  assert.equal(d.text, 'I never sent it.');
  assert.equal(rows.length, 6); // 2 blank lines skipped out of 8 raw lines
});

test('splitScriptToRows: shot_direction marker stripped, parenthetical kept whole', () => {
  const rows = splitScriptToRows(SAMPLE_SCRIPT);
  assert.equal(rows[2].text, '(beat)');
  assert.equal(rows[3].text, 'CLOSE ON: the letter in her hands');
});

test('splitScriptToRows: ALL-CAPS short line w/o terminal punctuation -> header', () => {
  const rows = splitScriptToRows('EXT. ROOFTOP - DAY\nTITLE CARD');
  assert.deepEqual(rows.map((r) => r.kind), ['header', 'header']);
});

test('splitScriptToRows: all-caps line ending in punctuation -> action, not header', () => {
  const rows = splitScriptToRows('HE SMASHES THE CUP.');
  assert.equal(rows[0].kind, 'action');
});

test('splitScriptToRows: transition token line -> transition', () => {
  const rows = splitScriptToRows('CUT TO:\nFADE OUT.');
  assert.deepEqual(rows.map((r) => r.kind), ['transition', 'transition']);
});

test('splitScriptToRows: empty / null / whitespace-only input -> []', () => {
  assert.deepEqual(splitScriptToRows(''), []);
  assert.deepEqual(splitScriptToRows(null), []);
  assert.deepEqual(splitScriptToRows('   \n\n  '), []);
});

// ---------------------------------------------------------------- grouping
test('buildSceneRows: groups by scene_index, sorted ascending, order preserved', () => {
  const a0 = { scene_index: 0, row_index: 0, kind: 'header', text: 'INT. A - DAY' };
  const a1 = { scene_index: 0, row_index: 1, kind: 'action', text: 'x' };
  const b0 = { scene_index: 1, row_index: 0, kind: 'action', text: 'y' };
  const c0 = { scene_index: 2, row_index: 0, kind: 'action', text: 'z' };
  // input deliberately interleaved out of scene order
  const groups = buildSceneRows([c0, a0, b0, a1]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.sceneIndex), [0, 1, 2]);
  assert.deepEqual(groups[0].rows, [a0, a1]); // within-group source order kept
  assert.deepEqual(groups[1].rows, [b0]);
  assert.deepEqual(groups[2].rows, [c0]);
});

test('buildSceneRows: rows without scene_index default to scene 0', () => {
  const r1 = { kind: 'action', text: 'a' };
  const r2 = { kind: 'action', text: 'b' };
  const r3 = { scene_index: 5, kind: 'action', text: 'c' };
  const groups = buildSceneRows([r1, r3, r2]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].sceneIndex, 0);
  assert.deepEqual(groups[0].rows, [r1, r2]);
  assert.equal(groups[1].sceneIndex, 5);
});

test('buildSceneRows: empty / non-array input -> []', () => {
  assert.deepEqual(buildSceneRows([]), []);
  assert.deepEqual(buildSceneRows(null), []);
});
