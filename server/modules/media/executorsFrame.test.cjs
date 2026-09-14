'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildFrameCommand,
  runFrame,
  msToSeconds,
  defaultOutKey,
} = require('./executorsFrame.cjs');

/** Fake spawn matching executorsAv/executorsStitch test files (EventEmitter child + streams). */
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

// ─── msToSeconds ─────────────────────────────────────────────────────────────

test('frame msToSeconds: integer ms → ffmpeg seconds with exactly 3 decimals', () => {
  assert.equal(msToSeconds(500), '0.500');
  assert.equal(msToSeconds(0), '0.000');
  assert.equal(msToSeconds(1234), '1.234');
  assert.equal(msToSeconds(15000), '15.000');
  assert.equal(msToSeconds(1), '0.001');
});

// ─── buildFrameCommand: happy path ───────────────────────────────────────────

test('buildFrameCommand: 500ms → -ss 0.500 before -i, -frames:v 1, -q:v 2, outKey last', () => {
  const cmd = buildFrameCommand({ source: '/videos/clip.mp4', timeMs: 500, outKey: '/tmp/clip.frame.png' });
  assert.deepEqual(cmd.args, [
    '-y', '-ss', '0.500',
    '-i', '/videos/clip.mp4',
    '-frames:v', '1',
    '-q:v', '2',
    '/tmp/clip.frame.png',
  ]);
  assert.equal(cmd.output, '/tmp/clip.frame.png');
  assert.equal(cmd.timeMs, 500);
  assert.equal(cmd.seconds, '0.500');
});

test('buildFrameCommand: seeks with 3-decimal seconds across magnitudes; -ss precedes -i (fast seek)', () => {
  for (const [ms, sec] of [[0, '0.000'], [1, '0.001'], [999, '0.999'], [2500, '2.500'], [65999, '65.999']]) {
    const cmd = buildFrameCommand({ source: 'a.mp4', timeMs: ms, outKey: 'o.png' });
    assert.equal(cmd.seconds, sec, `${ms}ms must become ${sec}s`);
    const iSs = cmd.args.indexOf('-ss');
    const iI = cmd.args.indexOf('-i');
    assert.ok(iSs !== -1 && iSs + 1 < iI, '-ss <seconds> must sit before -i for container seek');
    assert.equal(cmd.args[iSs + 1], sec);
    assert.equal(cmd.args[cmd.args.length - 1], 'o.png');
    assert.equal(cmd.output, 'o.png');
  }
});

// ─── buildFrameCommand: validation failures ──────────────────────────────────

test('buildFrameCommand: throws when timeMs is missing, negative, non-integer, or non-numeric', () => {
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', outKey: 'o.png' }), /timeMs/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: undefined, outKey: 'o.png' }), /timeMs/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: null, outKey: 'o.png' }), /timeMs/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: -1, outKey: 'o.png' }), /timeMs/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: -500, outKey: 'o.png' }), /timeMs/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: 1.5, outKey: 'o.png' }), /timeMs/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: NaN, outKey: 'o.png' }), /timeMs/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: '500', outKey: 'o.png' }), /timeMs/);
});

test('buildFrameCommand: accepts timeMs = 0 (start of the clip) and large integer ms', () => {
  const a = buildFrameCommand({ source: 'a.mp4', timeMs: 0, outKey: 'o.png' });
  assert.equal(a.seconds, '0.000');
  const b = buildFrameCommand({ source: 'a.mp4', timeMs: 86400000, outKey: 'o.png' }); // 24h
  assert.equal(b.seconds, '86400.000');
});

test('buildFrameCommand: throws when source is missing or empty', () => {
  assert.throws(() => buildFrameCommand({ timeMs: 500, outKey: 'o.png' }), /source/);
  assert.throws(() => buildFrameCommand({ source: '', timeMs: 500, outKey: 'o.png' }), /source/);
  assert.throws(() => buildFrameCommand({ source: '   ', timeMs: 500, outKey: 'o.png' }), /source/);
  assert.throws(() => buildFrameCommand({}), /source/);
});

test('buildFrameCommand: default output lands in jobDir (or /tmp/media-jobs/<jobId>) with ms embedded in name', () => {
  const viaDir = buildFrameCommand({ source: 'https://oss.example.com/v/raw.mp4?x=1', timeMs: 500, jobDir: '/tmp/media-jobs/job_7' });
  assert.equal(viaDir.output, '/tmp/media-jobs/job_7/raw.frame.500ms.png');
  assert.equal(viaDir.args[viaDir.args.length - 1], viaDir.output);
  const viaId = buildFrameCommand({ source: 'clip.mp4', timeMs: 500, jobId: 'job-9' });
  assert.equal(viaId.output, '/tmp/media-jobs/job-9/clip.frame.500ms.png');
  // ms embedded ⇒ two timestamps of the same source never collide
  assert.notEqual(defaultOutKey('clip.mp4', 500, '/d'), defaultOutKey('clip.mp4', 900, '/d'));
  // explicit outKey always wins over job-scoped defaults
  const explicit = buildFrameCommand({ source: 'clip.mp4', timeMs: 500, outKey: '/elsewhere/x.png', jobDir: '/d' });
  assert.equal(explicit.output, '/elsewhere/x.png');
});

// ─── runFrame: success paths ─────────────────────────────────────────────────

test('runFrame: exit 0 → ok with result.output; ffmpeg gets -ss <seconds> -i -frames:v 1 -q:v 2', async () => {
  const spawn = makeFakeSpawn();
  const r = await runFrame({ source: '/videos/clip.mp4', timeMs: 500, outKey: '/tmp/f.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.result.output, '/tmp/f.png');
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  assert.equal(args[0], '-y');
  assert.ok(args.includes('-ss'));
  assert.equal(args[args.indexOf('-ss') + 1], '0.500');
  assert.equal(args[args.indexOf('-i') + 1], '/videos/clip.mp4');
  assert.ok(args.includes('-frames:v'));
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  assert.ok(args.includes('-q:v'));
  assert.equal(args[args.indexOf('-q:v') + 1], '2');
  assert.equal(args[args.length - 1], '/tmp/f.png');
});

test('runFrame: without outKey, output defaults into jobDir which is created on disk', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-job-'));
  const spawn = makeFakeSpawn();
  try {
    const r = await runFrame({ source: 'raw.mp4', timeMs: 500, jobDir, spawn, timeoutMs: 2000 });
    assert.equal(r.ok, true);
    assert.equal(r.result.output, path.join(jobDir, 'raw.frame.500ms.png'));
    assert.ok(fs.existsSync(jobDir), 'jobDir must be created before ffmpeg runs');
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

// ─── runFrame: failure paths ─────────────────────────────────────────────────

test('runFrame: spawn ENOENT → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const spawn = makeFakeSpawn({ enoent: true });
  const r = await runFrame({ source: 'a.mp4', timeMs: 500, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
  assert.ok(r.message.length > 0);
});

test('runFrame: ENOENT error emitted after spawn → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const e = new Error('spawn ffmpeg ENOENT');
  e.code = 'ENOENT';
  const spawn = makeFakeSpawn({ errorAfterSpawn: e });
  const r = await runFrame({ source: 'a.mp4', timeMs: 500, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
});

test('runFrame: non-zero exit → MEDIA_FRAME_FAILED with stderr message', async () => {
  const spawn = makeFakeSpawn({ exitCode: 1, stderrData: [Buffer.from('Invalid data found when processing input')] });
  const r = await runFrame({ source: 'a.mp4', timeMs: 500, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FRAME_FAILED');
  assert.ok(r.message.includes('Invalid data found when processing input'));
});

test('runFrame: no close within timeoutMs → kill() + MEDIA_FRAME_TIMEOUT', async () => {
  const spawn = makeFakeSpawn({ emitClose: false });
  const r = await runFrame({ source: 'a.mp4', timeMs: 500, outKey: 'o.png', spawn, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FRAME_TIMEOUT');
  assert.equal(spawn.calls.length, 1);
  assert.ok(spawn.calls[0].child.killed, 'child.kill() must have been called on timeout');
});

test('runFrame: missing or empty source → MEDIA_SOURCE_MISSING (no spawn)', async () => {
  const spawn = makeFakeSpawn();
  const r1 = await runFrame({ spawn, timeoutMs: 2000 });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'MEDIA_SOURCE_MISSING');
  const r2 = await runFrame({ source: '', timeMs: 500, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'MEDIA_SOURCE_MISSING');
  const r3 = await runFrame({ source: '  ', timeMs: 500, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'MEDIA_SOURCE_MISSING');
  assert.equal(spawn.calls.length, 0, 'no ffmpeg spawn may happen when the source is missing');
});

test('runFrame: structural validation violation (bad timeMs) → MEDIA_FRAME_FAILED, no spawn', async () => {
  const spawn = makeFakeSpawn();
  const r1 = await runFrame({ source: 'a.mp4', timeMs: -1, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'MEDIA_FRAME_FAILED');
  assert.ok(/timeMs/.test(r1.message));
  const r2 = await runFrame({ source: 'a.mp4', timeMs: 1.5, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'MEDIA_FRAME_FAILED');
  assert.equal(spawn.calls.length, 0);
});

// ─── runFrame: real ffmpeg smoke test ────────────────────────────────────────

test('frame real-ffmpeg smoke: extract 500ms frame from generated testsrc video → PNG on disk', { timeout: 60000 }, async (t) => {
  const hasFfmpeg = await new Promise((resolve) => {
    try {
      const p = require('node:child_process').spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (c) => resolve(c === 0));
    } catch { resolve(false); }
  });
  if (!hasFfmpeg) {
    t.skip('ffmpeg not installed on this host — real smoke test not run');
    return;
  }
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-smoke-'));
  const src = path.join(jobDir, 'input.mp4');
  const out = path.join(jobDir, 'frame.png');
  try {
    // Build a 2 s 320x240 testsrc clip to extract from.
    const gen = await new Promise((resolve) => {
      const p = require('node:child_process').spawn(
        'ffmpeg',
        ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=25', '-pix_fmt', 'yuv420p', src],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      p.stderr.resume();
      p.on('close', resolve);
    });
    assert.equal(gen, 0, 'ffmpeg must generate the testsrc input clip');
    assert.ok(fs.existsSync(src));

    const r = await runFrame({ source: src, timeMs: 500, outKey: out, timeoutMs: 30000 });
    assert.equal(r.ok, true, `real frame extraction must succeed (${JSON.stringify(r)})`);
    assert.equal(r.result.output, out);
    assert.ok(fs.existsSync(out), 'frame output file must exist');
    const stat = fs.statSync(out);
    assert.ok(stat.size > 0, 'frame output must not be empty');
    const magic = fs.readFileSync(out).subarray(0, 4);
    assert.deepEqual([...magic], [0x89, 0x50, 0x4e, 0x47], 'output must be a real PNG');

    // Failure mapping against the real binary: nonexistent input file → non-zero → MEDIA_FRAME_FAILED
    const bad = await runFrame({ source: path.join(jobDir, 'nope.mp4'), timeMs: 500, outKey: path.join(jobDir, 'x.png'), timeoutMs: 30000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'MEDIA_FRAME_FAILED');
    assert.ok(bad.message.length > 0);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

// ─── security: output path traversal + ffmpeg option injection ───────────────

test('buildFrameCommand: rejects outKey with .. traversal and - prefix (no ffmpeg option injection)', () => {
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: 500, outKey: '../escape.png' }), /'\.\.'/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: 500, outKey: '/tmp/../../etc/evil.png' }), /'\.\.'/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: 500, outKey: '-vf' }), /'-'/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: 500, outKey: '-metadata' }), /'-'/);
  assert.throws(() => buildFrameCommand({ source: 'a.mp4', timeMs: 500, outKey: 'ok\0.png' }), /NUL/);
});

test('buildFrameCommand: neutralizes jobDir traversal so output cannot escape its scope', () => {
  const cmd = buildFrameCommand({ source: 'a.mp4', timeMs: 500, jobDir: '/tmp/../../etc' });
  assert.ok(!cmd.output.includes('..'), 'jobDir traversal must be neutralized, not passed through');
  assert.equal(cmd.output, '/tmp/_/_/etc/a.frame.500ms.png');
});

test('defaultOutKey: neutralizes .. in jobId/jobDir so the scoped dir cannot escape', () => {
  assert.equal(defaultOutKey('a.mp4', 500, null, '..'), '/tmp/media-jobs/_/a.frame.500ms.png');
  assert.equal(defaultOutKey('a.mp4', 500, '/tmp/../x', null), '/tmp/_/x/a.frame.500ms.png');
});

test('runFrame: traversal outKey → MEDIA_FRAME_FAILED with no ffmpeg spawn', async () => {
  const spawn = makeFakeSpawn();
  const r = await runFrame({ source: 'a.mp4', timeMs: 500, outKey: '../escape.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FRAME_FAILED');
  assert.ok(/\.\./.test(r.message));
  assert.equal(spawn.calls.length, 0, 'no spawn for a traversal output path');
});

test('frame real-ffmpeg: traversal outKey is rejected before spawn — nothing written outside jobDir', { timeout: 60000 }, async (t) => {
  const hasFfmpeg = await new Promise((resolve) => {
    try {
      const p = require('node:child_process').spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (c) => resolve(c === 0));
    } catch { resolve(false); }
  });
  if (!hasFfmpeg) {
    t.skip('ffmpeg not installed on this host — real smoke test not run');
    return;
  }
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-escape-'));
  const src = path.join(jobDir, 'input.mp4');
  const escapeTarget = path.resolve(jobDir, '..', '..', 'frame-escape.png');
  try {
    const gen = await new Promise((resolve) => {
      const p = require('node:child_process').spawn(
        'ffmpeg',
        ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10', '-pix_fmt', 'yuv420p', src],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      p.stderr.resume();
      p.on('close', resolve);
    });
    assert.equal(gen, 0, 'ffmpeg must generate the input clip');
    const r = await runFrame({ source: src, timeMs: 0, outKey: path.join(jobDir, '..', '..', 'frame-escape.png'), timeoutMs: 30000 });
    assert.equal(r.ok, false, 'traversal outKey must fail before ffmpeg runs');
    assert.equal(r.code, 'MEDIA_FRAME_FAILED');
    assert.ok(!fs.existsSync(escapeTarget), 'no file may be written outside jobDir via traversal');
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
