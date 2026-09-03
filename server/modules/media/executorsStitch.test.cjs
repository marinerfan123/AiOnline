'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  buildStitchCommand,
  runStitch,
  msToSeconds,
  MAX_SEGMENTS,
} = require('./executorsStitch.cjs');

/** Fake spawn matching executorsAv.test.cjs (EventEmitter child + streams). */
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

test('msToSeconds: integer ms → seconds with 3 decimals', () => {
  assert.equal(msToSeconds(2000), '2.000');
  assert.equal(msToSeconds(1500), '1.500');
  assert.equal(msToSeconds(0), '0.000');
  assert.equal(msToSeconds(1234), '1.234');
  assert.equal(msToSeconds(5000), '5.000');
});

// ─── buildStitchCommand: happy path ──────────────────────────────────────────

test('buildStitchCommand: 2 segments → filter_complex with correct trim seconds and concat n=2', () => {
  const cmd = buildStitchCommand({
    segments: [
      { source: '/media/a.mp4', inMs: 2000, outMs: 5000 },
      { source: '/media/b.mp4', inMs: 1500, outMs: 3000 },
    ],
    outKey: '/tmp/stitch.mp4',
  });
  assert.equal(cmd.output, '/tmp/stitch.mp4');
  assert.equal(cmd.segments, 2);

  const fi = cmd.args.indexOf('-filter_complex');
  assert.ok(fi !== -1, 'args must contain -filter_complex');
  assert.ok(cmd.args.includes('-map'), 'args must contain -map');
  assert.equal(cmd.args[cmd.args.length - 1], '/tmp/stitch.mp4');

  const filter = cmd.args[fi + 1];
  assert.equal(filter, cmd.filter);
  // per-segment trim (2000→2.000, 1500→1.500) with PTS reset
  assert.ok(filter.includes('[0:v]trim=start=2.000:end=5.000,setpts=PTS-STARTPTS[v0]'), 'seg0 trim seconds must be ms/1000 with 3 decimals');
  assert.ok(filter.includes('[1:v]trim=start=1.500:end=3.000,setpts=PTS-STARTPTS[v1]'), 'seg1 trim seconds must be ms/1000 with 3 decimals');
  // concat of the two labelled streams, video only
  assert.ok(filter.endsWith('[v0][v1]concat=n=2:v=1:a=0[v]'), `filter must end with concat n=2 (got "${filter}")`);
  // both sources are -i inputs, each appearing before -filter_complex
  assert.equal(cmd.args.filter((a) => a === '-i').length, 2);
  assert.ok(cmd.args.includes('/media/a.mp4'));
  assert.ok(cmd.args.includes('/media/b.mp4'));
  assert.ok(cmd.args[cmd.args.length - 1], '/tmp/stitch.mp4');
});

test('buildStitchCommand: leading -y, each segment source bound to its input index', () => {
  const cmd = buildStitchCommand({
    segments: [
      { source: 's1.mp4', inMs: 0, outMs: 1000 },
      { source: 's2.mp4', inMs: 1000, outMs: 2000 },
      { source: 's3.mp4', inMs: 0, outMs: 500 },
    ],
    outKey: 'o.mp4',
  });
  assert.equal(cmd.args[0], '-y');
  assert.ok(cmd.filter.includes('[0:v]trim=start=0.000:end=1.000,setpts=PTS-STARTPTS[v0]'));
  assert.ok(cmd.filter.includes('[1:v]trim=start=1.000:end=2.000,setpts=PTS-STARTPTS[v1]'));
  assert.ok(cmd.filter.endsWith('[v0][v1][v2]concat=n=3:v=1:a=0[v]'));
  assert.equal(cmd.segments, 3);
});

// ─── buildStitchCommand: validation failures ─────────────────────────────────

test('buildStitchCommand: throws when segments is missing/not an array', () => {
  assert.throws(() => buildStitchCommand({ outKey: 'o.mp4' }), /segments array/);
  assert.throws(() => buildStitchCommand({ segments: 'nope', outKey: 'o.mp4' }), /segments array/);
});

test('buildStitchCommand: throws when fewer than 1 segment', () => {
  assert.throws(() => buildStitchCommand({ segments: [], outKey: 'o.mp4' }), /at least one segment/);
});

test('buildStitchCommand: throws when a segment lacks a source', () => {
  assert.throws(
    () => buildStitchCommand({ segments: [{ inMs: 0, outMs: 1000 }, { source: '', inMs: 0, outMs: 1000 }], outKey: 'o.mp4' }),
    /source/
  );
});

test('buildStitchCommand: throws on non-integer or negative inMs', () => {
  assert.throws(() => buildStitchCommand({ segments: [{ source: 'a.mp4', inMs: 1.5, outMs: 2000 }], outKey: 'o.mp4' }), /inMs/);
  assert.throws(() => buildStitchCommand({ segments: [{ source: 'a.mp4', inMs: -100, outMs: 2000 }], outKey: 'o.mp4' }), /inMs/);
});

test('buildStitchCommand: throws when outMs ≤ inMs or outMs not an integer', () => {
  assert.throws(() => buildStitchCommand({ segments: [{ source: 'a.mp4', inMs: 2000, outMs: 2000 }], outKey: 'o.mp4' }), /outMs/);
  assert.throws(() => buildStitchCommand({ segments: [{ source: 'a.mp4', inMs: 3000, outMs: 1000 }], outKey: 'o.mp4' }), /outMs/);
  assert.throws(() => buildStitchCommand({ segments: [{ source: 'a.mp4', inMs: 0, outMs: 1000.5 }], outKey: 'o.mp4' }), /outMs/);
});

test('buildStitchCommand: accepts inMs = 0 with outMs > 0', () => {
  const cmd = buildStitchCommand({ segments: [{ source: 'a.mp4', inMs: 0, outMs: 500 }], outKey: 'o.mp4' });
  assert.ok(cmd.filter.includes('trim=start=0.000:end=0.500'));
});

test('buildStitchCommand: throws above 20 segments and without outKey', () => {
  const seg = () => ({ source: 'a.mp4', inMs: 0, outMs: 100 });
  const many = Array.from({ length: MAX_SEGMENTS + 1 }, seg);
  assert.throws(() => buildStitchCommand({ segments: many, outKey: 'o.mp4' }), /at most 20 segments/);
  const ok = Array.from({ length: MAX_SEGMENTS }, seg);
  const cmd = buildStitchCommand({ segments: ok, outKey: 'o.mp4' });
  assert.ok(cmd.filter.includes(`concat=n=${MAX_SEGMENTS}:v=1:a=0[v]`));
  assert.throws(() => buildStitchCommand({ segments: [{ source: 'a.mp4', inMs: 0, outMs: 100 }] }), /outKey/);
});

// ─── runStitch: success ──────────────────────────────────────────────────────

test('runStitch: exit 0 → ok with output/segments; ffmpeg receives filter_complex + trim', async () => {
  const spawn = makeFakeSpawn();
  const r = await runStitch({
    segments: [
      { source: '/media/a.mp4', inMs: 2000, outMs: 4000 },
      { source: '/media/b.mp4', inMs: 1500, outMs: 3000 },
    ],
    outKey: '/tmp/stitch.mp4',
    spawn,
    timeoutMs: 2000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.output, '/tmp/stitch.mp4');
  assert.equal(r.result.segments, 2);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  const fi = args.indexOf('-filter_complex');
  assert.ok(fi !== -1);
  assert.ok(args[fi + 1].includes('[0:v]trim=start=2.000:end=4.000,setpts=PTS-STARTPTS[v0]'));
  assert.ok(args[fi + 1].endsWith('[v0][v1]concat=n=2:v=1:a=0[v]'));
  assert.ok(args.includes('-map'));
  assert.ok(args.includes('[v]'));
  assert.equal(args[args.length - 1], '/tmp/stitch.mp4');
});

// ─── runStitch: failure paths ────────────────────────────────────────────────

test('runStitch: spawn ENOENT → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const spawn = makeFakeSpawn({ enoent: true });
  const r = await runStitch({ segments: [{ source: 'a.mp4', inMs: 0, outMs: 1000 }], outKey: 'o.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
  assert.ok(r.message.length > 0);
});

test('runStitch: ENOENT error emitted after spawn → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const e = new Error('spawn ffmpeg ENOENT');
  e.code = 'ENOENT';
  const spawn = makeFakeSpawn({ errorAfterSpawn: e });
  const r = await runStitch({ segments: [{ source: 'a.mp4', inMs: 0, outMs: 1000 }], outKey: 'o.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
});

test('runStitch: non-zero exit → MEDIA_STITCH_FAILED with stderr message', async () => {
  const spawn = makeFakeSpawn({ exitCode: 1, stderrData: [Buffer.from('Stream map [v] matches no streams')] });
  const r = await runStitch({ segments: [{ source: 'a.mp4', inMs: 0, outMs: 1000 }], outKey: 'o.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_STITCH_FAILED');
  assert.ok(r.message.includes('Stream map [v] matches no streams'));
});

test('runStitch: no close within timeoutMs → kill() + MEDIA_STITCH_TIMEOUT', async () => {
  const spawn = makeFakeSpawn({ emitClose: false });
  const r = await runStitch({ segments: [{ source: 'a.mp4', inMs: 0, outMs: 1000 }], outKey: 'o.mp4', spawn, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_STITCH_TIMEOUT');
  assert.equal(spawn.calls.length, 1);
  assert.ok(spawn.calls[0].child.killed, 'child.kill() must have been called on timeout');
});

test('runStitch: missing/empty segments or a segment without source → MEDIA_SOURCE_MISSING (no spawn)', async () => {
  const spawn = makeFakeSpawn();
  const r1 = await runStitch({ segments: [], outKey: 'o.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'MEDIA_SOURCE_MISSING');
  const r2 = await runStitch({ spawn, timeoutMs: 2000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'MEDIA_SOURCE_MISSING');
  const r3 = await runStitch({ segments: [{ source: 'a.mp4', inMs: 0, outMs: 1000 }, { inMs: 0, outMs: 1000 }], outKey: 'o.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'MEDIA_SOURCE_MISSING');
  assert.equal(spawn.calls.length, 0, 'no ffmpeg spawn may happen when a source is missing');
});

test('runStitch: structural validation violation (outMs ≤ inMs) → MEDIA_STITCH_FAILED, no spawn', async () => {
  const spawn = makeFakeSpawn();
  const r = await runStitch({ segments: [{ source: 'a.mp4', inMs: 2000, outMs: 1000 }], outKey: 'o.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_STITCH_FAILED');
  assert.ok(/outMs/.test(r.message));
  assert.equal(spawn.calls.length, 0);
});
