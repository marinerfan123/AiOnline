'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildSceneDetectCommand,
  parseSceneDetectOutput,
  buildSegments,
  runSceneDetect,
} = require('./executorsScene.cjs');

/** Fake spawn matching executorsFrame/executorsStitch test files (EventEmitter child + streams). */
function makeFakeSpawn(opts = {}) {
  const {
    enoent = false,
    exitCode = 0,
    stdoutData = [],
    stderrData = [],
    errorAfterSpawn = null,
    emitClose = true,
    async: emitAsync = true,
  } = opts;
  const fn = (bin, args) => {
    if (enoent) {
      const e = new Error('spawn ffmpeg ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig) => { child.killed = { sig }; };
    fn.calls.push({ bin, args, child });
    const fire = () => {
      if (errorAfterSpawn) { child.emit('error', errorAfterSpawn); return; }
      for (const d of stdoutData) child.stdout.emit('data', d);
      for (const d of stderrData) child.stderr.emit('data', d);
      if (emitClose) child.emit('close', exitCode);
    };
    if (emitAsync) setImmediate(fire); else fire();
    return child;
  };
  fn.calls = [];
  return fn;
}

// ─── buildSceneDetectCommand ────────────────────────────────────────────────

test('scene buildSceneDetectCommand: select with default threshold 0.3 + showinfo, output discarded via -f null -', () => {
  const cmd = buildSceneDetectCommand({ source: '/videos/clip.mp4' });
  assert.equal(cmd.threshold, 0.3);
  assert.equal(cmd.filter, "select='gt(scene,0.3)',showinfo");
  assert.deepEqual(cmd.args, [
    '-y',
    '-i', '/videos/clip.mp4',
    '-vf', "select='gt(scene,0.3)',showinfo",
    '-f', 'null', '-',
  ]);
  assert.equal(cmd.output, null);
});

test('scene buildSceneDetectCommand: custom threshold flows into the select expression', () => {
  const cmd = buildSceneDetectCommand({ source: 'clip.mp4', threshold: 0.15 });
  assert.ok(cmd.args.includes("select='gt(scene,0.15)',showinfo"), 'threshold 0.15 must appear in -vf select');
  const t1 = buildSceneDetectCommand({ source: 'clip.mp4', threshold: 1 });
  assert.ok(t1.args.includes("select='gt(scene,1)',showinfo"));
});

test('scene buildSceneDetectCommand: throws on missing/empty source', () => {
  assert.throws(() => buildSceneDetectCommand({}), /source/);
  assert.throws(() => buildSceneDetectCommand({ source: '' }), /source/);
  assert.throws(() => buildSceneDetectCommand({ source: '   ' }), /source/);
});

test('scene buildSceneDetectCommand: throws on invalid thresholds (0, negative, >1, NaN, non-numeric, null)', () => {
  for (const bad of [0, -0.1, 1.5, NaN, 'abc', null]) {
    assert.throws(() => buildSceneDetectCommand({ source: 'clip.mp4', threshold: bad }), /threshold/);
  }
  // undefined hits the 0.3 default and is valid
  assert.equal(buildSceneDetectCommand({ source: 'clip.mp4' }).threshold, 0.3);
});

// ─── parseSceneDetectOutput ─────────────────────────────────────────────────

const SHOWINFO_LINE = (pts) =>
  `[Parsed_showinfo_1 @ 0x55f1c23d5700] n:   0 pts:  12800 pts_time:${pts}       pos: 7289 fmt:yuv420p sar:1/1 s:320x240 i:P iskey:0 type:B checksum:7E13C573 plane_checksum:[35B2C10E 8C14821B C233823B] mean:[16 128 128] stdev:[0.0 0.0 0.0]\n`;

test('scene parseSceneDetectOutput: extracts pts_time values from showinfo lines mixed with ffmpeg noise', () => {
  const stderr = [
    'ffmpeg version 4.4.2 Copyright (c) 2000-2021 the FFmpeg developers',
    '  built with gcc 11 (Ubuntu 11.4.0-1ubuntu1~22.04)',
    'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'/videos/clip.mp4\':',
    '  Duration: 00:00:03.00, start: 0.000000, bitrate: 115 kb/s',
    SHOWINFO_LINE('0.6'),
    'frame=   24 fps=0.0 q=0.0 size=N/A time=00:00:00.96 bitrate=N/A speed= 331x',
    SHOWINFO_LINE('2.5'),
    SHOWINFO_LINE('2.04'),
    'frame=   75 fps= 25 q=-0.0 Lsize=N/A time=00:00:03.00 bitrate=N/A speed=  25x',
    'video:0kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: unknown',
  ].join('\n');
  assert.deepEqual(parseSceneDetectOutput(stderr), [600, 2040, 2500]);
});

test('scene parseSceneDetectOutput: integer seconds and duplicate/out-of-order pts are handled (dedupe + sort)', () => {
  const stderr = SHOWINFO_LINE('1') + SHOWINFO_LINE('0.6') + SHOWINFO_LINE('1') + SHOWINFO_LINE('2.04') + SHOWINFO_LINE('0.6');
  assert.deepEqual(parseSceneDetectOutput(stderr), [600, 1000, 2040]);
});

test('scene parseSceneDetectOutput: pts_time at 0, negative, or malformed values are not cuts; empty input → []', () => {
  const stderr = SHOWINFO_LINE('0') + SHOWINFO_LINE('-1') + 'progress=continue\nout_time_us=2500000\n';
  assert.deepEqual(parseSceneDetectOutput(stderr), []);
  assert.deepEqual(parseSceneDetectOutput(''), []);
  assert.deepEqual(parseSceneDetectOutput(null), []);
  // Noise that merely contains the word pts_time (no value) must not match.
  assert.deepEqual(parseSceneDetectOutput('pts_time:???\n'), []);
});

// ─── buildSegments ──────────────────────────────────────────────────────────

test('scene buildSegments: no cuts → single full-length segment (open tail when duration unknown)', () => {
  assert.deepEqual(buildSegments([], null), [{ startMs: 0, endMs: null }]);
  assert.deepEqual(buildSegments([], undefined), [{ startMs: 0, endMs: null }]);
  assert.deepEqual(buildSegments([], 5000), [{ startMs: 0, endMs: 5000 }]);
  assert.deepEqual(buildSegments([], '5000'), [{ startMs: 0, endMs: 5000 }]); // numeric string accepted
});

test('scene buildSegments: cuts expand into contiguous integer-ms segments; tail capped by duration or open', () => {
  assert.deepEqual(buildSegments([600, 2500], null), [
    { startMs: 0, endMs: 600 },
    { startMs: 600, endMs: 2500 },
    { startMs: 2500, endMs: null },
  ]);
  assert.deepEqual(buildSegments([600, 2500], 4000), [
    { startMs: 0, endMs: 600 },
    { startMs: 600, endMs: 2500 },
    { startMs: 2500, endMs: 4000 },
  ]);
  // 2500 cut lands exactly on the end → covered segment ends there, no empty tail
  assert.deepEqual(buildSegments([600, 2500], 2500), [
    { startMs: 0, endMs: 600 },
    { startMs: 600, endMs: 2500 },
  ]);
});

test('scene buildSegments: out-of-order/duplicate/string cuts are normalized; out-of-range cuts clamp and never produce empty segments', () => {
  assert.deepEqual(buildSegments(['2500', 600, 600, 2500], 3000), [
    { startMs: 0, endMs: 600 },
    { startMs: 600, endMs: 2500 },
    { startMs: 2500, endMs: 3000 },
  ]);
  // cut at/beyond EOF is clamped into the previous segment and the empty tail dropped
  assert.deepEqual(buildSegments([3000], 2000), [{ startMs: 0, endMs: 2000 }]);
});

// ─── runSceneDetect: success paths ─────────────────────────────────────────

test('scene runSceneDetect: exit 0 + showinfo stderr → ok with integer-ms segments (open tail when no durationMs)', async () => {
  const spawn = makeFakeSpawn({
    stderrData: [
      Buffer.from('ffmpeg version 4.4.2 Copyright (c) 2000-2021 the FFmpeg developers\n'),
      Buffer.from(SHOWINFO_LINE('0.6')),
      Buffer.from('frame=   24 fps=0.0 q=0.0 size=N/A time=00:00:00.96 bitrate=N/A speed= 331x\n'),
      Buffer.from(SHOWINFO_LINE('2.5')),
    ],
  });
  const r = await runSceneDetect({ source: '/videos/clip.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.segments, [
    { startMs: 0, endMs: 600 },
    { startMs: 600, endMs: 2500 },
    { startMs: 2500, endMs: null },
  ]);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  assert.ok(args.includes("select='gt(scene,0.3)',showinfo"), 'args must carry the select expression with default threshold');
  assert.ok(args.indexOf('-vf') !== -1);
  const fIdx = args.indexOf('-f');
  assert.deepEqual([args[fIdx + 1], args[fIdx + 2]], ['null', '-']);
});

test('scene runSceneDetect: threshold passes through to the command; durationMs caps the tail segment', async () => {
  const spawn = makeFakeSpawn({ stderrData: [Buffer.from(SHOWINFO_LINE('1'))] });
  const r = await runSceneDetect({ source: 'clip.mp4', threshold: 0.2, durationMs: 3000, spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.ok(spawn.calls[0].args.includes("select='gt(scene,0.2)',showinfo"));
  assert.deepEqual(r.result.segments, [
    { startMs: 0, endMs: 1000 },
    { startMs: 1000, endMs: 3000 },
  ]);
});

test('scene runSceneDetect: empty stderr output (no cuts) → single full-length segment (durationMs 4000 → whole clip)', async () => {
  const withDur = await runSceneDetect({ source: 'clip.mp4', durationMs: 4000, spawn: makeFakeSpawn({ stderrData: [Buffer.from('frame=  100 fps=0.0 q=0.0 size=N/A time=00:00:04.00 bitrate=N/A speed= 100x\n')] }), timeoutMs: 2000 });
  assert.equal(withDur.ok, true);
  assert.deepEqual(withDur.result.segments, [{ startMs: 0, endMs: 4000 }]);

  const noDur = await runSceneDetect({ source: 'clip.mp4', spawn: makeFakeSpawn(), timeoutMs: 2000 });
  assert.equal(noDur.ok, true);
  assert.deepEqual(noDur.result.segments, [{ startMs: 0, endMs: null }]);
});

// ─── runSceneDetect: failure paths ─────────────────────────────────────────

test('scene runSceneDetect: spawn ENOENT → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const r = await runSceneDetect({ source: 'a.mp4', spawn: makeFakeSpawn({ enoent: true }), timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
  assert.ok(r.message.length > 0);
});

test('scene runSceneDetect: ENOENT error emitted after spawn → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const e = new Error('spawn ffmpeg ENOENT');
  e.code = 'ENOENT';
  const r = await runSceneDetect({ source: 'a.mp4', spawn: makeFakeSpawn({ errorAfterSpawn: e }), timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
});

test('scene runSceneDetect: non-zero exit → MEDIA_SCENE_FAILED with stderr message', async () => {
  const spawn = makeFakeSpawn({ exitCode: 1, stderrData: [Buffer.from('Invalid data found when processing input')] });
  const r = await runSceneDetect({ source: 'a.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_SCENE_FAILED');
  assert.ok(r.message.includes('Invalid data found when processing input'));
});

test('scene runSceneDetect: no close within timeoutMs → kill() + MEDIA_SCENE_TIMEOUT', async () => {
  const spawn = makeFakeSpawn({ emitClose: false });
  const r = await runSceneDetect({ source: 'a.mp4', spawn, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_SCENE_TIMEOUT');
  assert.equal(spawn.calls.length, 1);
  assert.ok(spawn.calls[0].child.killed, 'child.kill() must have been called on timeout');
});

test('scene runSceneDetect: missing/empty source → MEDIA_SOURCE_MISSING (no spawn)', async () => {
  const spawn = makeFakeSpawn();
  for (const ctx of [{}, { source: '' }, { source: '   ' }]) {
    const r = await runSceneDetect({ ...ctx, spawn, timeoutMs: 2000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDIA_SOURCE_MISSING');
  }
  assert.equal(spawn.calls.length, 0, 'no ffmpeg spawn may happen when the source is missing');
});

test('scene runSceneDetect: structural validation violation (bad threshold) → MEDIA_SCENE_FAILED, no spawn', async () => {
  const spawn = makeFakeSpawn();
  const r = await runSceneDetect({ source: 'a.mp4', threshold: 2, spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_SCENE_FAILED');
  assert.ok(/threshold/.test(r.message));
  assert.equal(spawn.calls.length, 0);
});

// ─── runSceneDetect: real ffmpeg smoke test ────────────────────────────────

function ffmpegAvailable() {
  return new Promise((resolve) => {
    try {
      const p = require('node:child_process').spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (c) => resolve(c === 0));
    } catch { resolve(false); }
  });
}

function runFfmpegGen(args) {
  return new Promise((resolve) => {
    const p = require('node:child_process').spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.resume();
    p.on('error', resolve);
    p.on('close', resolve);
  });
}

test('scene real-ffmpeg smoke: hard cut at 1s detected as 2 segments; smooth clip → single segment', { timeout: 90000 }, async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg not installed on this host — real smoke test not run');
    return;
  }
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-smoke-'));
  const cutClip = path.join(jobDir, 'cut.mp4');
  const smoothClip = path.join(jobDir, 'smooth.mp4');
  try {
    // 1 s testsrc + 1 s black concat → exactly one hard cut at 1.000 s.
    const gen = await runFfmpegGen([
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'color=c=black:d=1:size=320x240:rate=25',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-pix_fmt', 'yuv420p', cutClip,
    ]);
    assert.equal(gen, 0, 'ffmpeg must generate the cut input clip');
    assert.ok(fs.existsSync(cutClip));

    const r = await runSceneDetect({ source: cutClip, durationMs: 2000, timeoutMs: 30000 });
    assert.equal(r.ok, true, `real scene detect must succeed (${JSON.stringify(r)})`);
    assert.equal(r.result.segments.length, 2, `1s hard cut must split the 2s clip into 2 segments (${JSON.stringify(r.result.segments)})`);
    const [a, b] = r.result.segments;
    assert.equal(a.startMs, 0);
    assert.equal(b.startMs, a.endMs, 'segments must be contiguous');
    assert.ok(a.endMs >= 900 && a.endMs <= 1100, `cut must land at ~1000ms (got ${a.endMs})`);
    assert.equal(b.endMs, 2000, 'durationMs must cap the tail segment');

    // Smooth content has no scene change above 0.3 → one full-length segment.
    const gen2 = await runFfmpegGen([
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=25',
      '-pix_fmt', 'yuv420p', smoothClip,
    ]);
    assert.equal(gen2, 0);
    const r2 = await runSceneDetect({ source: smoothClip, timeoutMs: 30000 });
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.result.segments, [{ startMs: 0, endMs: null }], 'no cuts → single open-ended segment');

    // Nonexistent input → non-zero exit → MEDIA_SCENE_FAILED against the real binary.
    const bad = await runSceneDetect({ source: path.join(jobDir, 'nope.mp4'), timeoutMs: 30000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'MEDIA_SCENE_FAILED');
    assert.ok(bad.message.length > 0);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
