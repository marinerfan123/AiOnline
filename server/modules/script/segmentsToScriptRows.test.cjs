'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  segmentsToScriptRows,
  DEFAULT_TAIL_DURATION_MS,
  TRANSITION_TEXT,
} = require('./segmentsToScriptRows.cjs');

const SD = (row) => row.kind === 'shot_direction';
const TR = (row) => row.kind === 'transition';

// ─── 2 段: timing/文本/scene_index 正确 + 段间前置 transition ─────────────
test('2 segments → one shot_direction per segment with correct frozen CUT text, timing_ms, duration_ms, scene_index', () => {
  const r = segmentsToScriptRows({ segments: [
    { startMs: 0, endMs: 600 },
    { startMs: 600, endMs: 2500 },
  ], sceneIndex: 3 });

  assert.equal(r.ok, true);
  const shots = r.rows.filter(SD);
  assert.equal(shots.length, 2); // every segment → exactly one shot_direction
  assert.equal(r.rows.length, 3); // 2 shots + 1 inter-segment transition

  assert.deepEqual(shots[0], {
    kind: 'shot_direction',
    scene_index: 3,
    text: 'CUT: 0-600 ms',
    timing_ms: 0,
    duration_ms: 600,
  });
  assert.deepEqual(shots[1], {
    kind: 'shot_direction',
    scene_index: 3,
    text: 'CUT: 600-2500 ms',
    timing_ms: 600,
    duration_ms: 1900,
  });

  // 可选前置 transition 行: between the two segments, before the 2nd shot.
  assert.deepEqual(r.rows, [
    shots[0],
    { kind: 'transition', scene_index: 3, text: TRANSITION_TEXT, timing_ms: 600 },
    shots[1],
  ]);
  assert.equal(TR(r.rows[1]), true);
});

// ─── sceneIndex 缺省 0; 单段无前置 transition ─────────────────────────────
test('single segment, default sceneIndex 0 → exactly one shot_direction, no transition row', () => {
  const r = segmentsToScriptRows({ segments: [{ startMs: 0, endMs: 1200 }] });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0], {
    kind: 'shot_direction',
    scene_index: 0,
    text: 'CUT: 0-1200 ms',
    timing_ms: 0,
    duration_ms: 1200,
  });
});

// ─── open 尾段: endMs null → 文本 open 标记 + duration 默认 3000 ──────────
test('open tail segment (endMs null) → text ends with "open", duration_ms defaults to 3000', () => {
  const r = segmentsToScriptRows({ segments: [
    { startMs: 0, endMs: 600 },
    { startMs: 600, endMs: 2500 },
    { startMs: 2500, endMs: null },
  ], sceneIndex: 1 });

  assert.equal(r.ok, true);
  const shots = r.rows.filter(SD);
  assert.equal(shots.length, 3);
  assert.deepEqual(shots[2], {
    kind: 'shot_direction',
    scene_index: 1,
    text: 'CUT: 2500-open ms',
    timing_ms: 2500,
    duration_ms: DEFAULT_TAIL_DURATION_MS,
  });
  assert.equal(shots[2].duration_ms, 3000);
  // middle closed shot unaffected
  assert.equal(shots[1].text, 'CUT: 600-2500 ms');
  assert.equal(shots[1].duration_ms, 1900);
});

// ─── 空拒 ─────────────────────────────────────────────────────────────────
test('empty segments array → { ok:false, errors }', () => {
  const r = segmentsToScriptRows({ segments: [] });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
  assert.match(r.errors[0], /not be empty/);
  assert.equal(r.rows, undefined);
});

test('segments not an array → { ok:false, errors }, no partial rows', () => {
  for (const bad of [undefined, null, 'cuts', { startMs: 0, endMs: 100 }, 42]) {
    const r = segmentsToScriptRows({ segments: bad });
    assert.equal(r.ok, false, `segments=${JSON.stringify(bad)}`);
    assert.ok(r.errors.some((e) => /must be an array/.test(e)));
  }
});

// ─── 非法 ms 拒 ───────────────────────────────────────────────────────────
test('rejects bad startMs (negative, float, NaN, string, boolean, missing)', () => {
  const bads = [
    { startMs: -5, endMs: 600 },    // negative
    { startMs: 1.5, endMs: 600 },   // float
    { startMs: NaN, endMs: 600 },   // NaN
    { startMs: Infinity, endMs: 600 },
    { startMs: '0', endMs: 600 },   // numeric string
    { startMs: true, endMs: 600 },  // boolean
    { endMs: 600 },                 // missing
    { startMs: null, endMs: 600 },
  ];
  for (const seg of bads) {
    const r = segmentsToScriptRows({ segments: [seg] });
    assert.equal(r.ok, false, `seg=${JSON.stringify(seg)}`);
    assert.ok(r.errors.some((e) => /startMs must be a non-negative integer/.test(e)),
      `expected startMs error for ${JSON.stringify(seg)}, got ${JSON.stringify(r.errors)}`);
    assert.equal(r.rows, undefined);
  }
});

test('rejects bad endMs (<= startMs, float, string, undefined, NaN)', () => {
  const bads = [
    [{ startMs: 600, endMs: 600 }],      // equal → not > startMs
    [{ startMs: 900, endMs: 600 }],      // less than startMs
    [{ startMs: 600, endMs: 0 }],
    [{ startMs: 0, endMs: 1.5 }],        // float ms
    [{ startMs: 0, endMs: '2500' }],     // numeric string
    [{ startMs: 0, endMs: NaN }],
    [{ startMs: 0 }],                    // missing endMs
    [{ startMs: 0, endMs: true }],
  ];
  for (const segments of bads) {
    const r = segmentsToScriptRows({ segments });
    assert.equal(r.ok, false, `segments=${JSON.stringify(segments)}`);
    assert.ok(r.errors.some((e) => /endMs must be null/.test(e) || /endMs \(\d+\) must be greater than startMs/.test(e)),
      `expected endMs error for ${JSON.stringify(segments)}, got ${JSON.stringify(r.errors)}`);
  }
});

test('collects per-segment errors across the whole array in one pass (no partial rows)', () => {
  const r = segmentsToScriptRows({ segments: [
    { startMs: 0, endMs: 600 },           // valid
    { startMs: -1, endMs: 500 },          // bad startMs
    { startMs: 700, endMs: 700 },         // endMs not > startMs
    { startMs: 2.5, endMs: null },        // bad startMs (float)
  ], sceneIndex: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3); // segment 0 valid → no error for it
  assert.ok(r.errors.some((e) => e.startsWith('segments[1]:') && /startMs/.test(e)));
  assert.ok(r.errors.some((e) => e.startsWith('segments[2]:') && /greater than/.test(e)));
  assert.ok(r.errors.some((e) => e.startsWith('segments[3]:') && /startMs/.test(e)));
  assert.equal(r.rows, undefined);
});

test('rejects bad sceneIndex (negative / float / string) while segments are valid', () => {
  for (const sceneIndex of [-1, 1.5, '2', null, NaN]) {
    const r = segmentsToScriptRows({ segments: [{ startMs: 0, endMs: 600 }], sceneIndex });
    assert.equal(r.ok, false, `sceneIndex=${String(sceneIndex)}`);
    assert.ok(r.errors.some((e) => /sceneIndex must be a non-negative integer/.test(e)));
  }
});
