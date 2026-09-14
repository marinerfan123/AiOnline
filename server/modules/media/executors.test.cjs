'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runProbe, execute } = require('./executors.cjs');
const { EventEmitter } = require('node:events');

function fakeSpawn(json, { exitCode = 0, enoent = false, errorAfterSpawn } = {}) {
  return () => {
    if (enoent) {
      const e = new Error('spawn ffprobe ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (errorAfterSpawn) { child.emit('error', errorAfterSpawn); return; }
      child.stdout.emit('data', Buffer.from(JSON.stringify(json)));
      child.emit('close', exitCode);
    });
    child.kill = () => {};
    return child;
  };
}

test('G06 probe: parses ffprobe JSON to canonical integer-ms meta', async () => {
  const spawn = fakeSpawn({
    format: { duration: 5.5 },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', rotation: 90 },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ],
  });
  const r = await runProbe({ source: '/tmp/x.mp4', spawn });
  assert.equal(r.ok, true);
  assert.equal(r.result.meta.durationMs, 5500);
  assert.equal(r.result.meta.width, 1280);
  assert.equal(r.result.meta.fpsNum, 30);
  assert.equal(r.result.meta.rotation, 90);
  assert.equal(r.result.meta.audioCodec, 'aac');
});

test('G06 probe: missing ffprobe binary → MEDIA_PROBE_UNAVAILABLE (never fake success)', async () => {
  const r = await runProbe({ source: '/tmp/x.mp4', spawn: fakeSpawn(null, { enoent: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_PROBE_UNAVAILABLE');
});

test('G06 probe: non-zero exit → MEDIA_PROBE_FAILED', async () => {
  const spawn = fakeSpawn(null, { exitCode: 1 });
  const r = await runProbe({ source: '/tmp/x.mp4', spawn });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_PROBE_FAILED');
});

test('G06 executors: unimplemented kinds return deterministic PENDING code', async () => {
  for (const kind of ['transcode', 'render']) {
    const r = await execute(kind, { source: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.code.endsWith('EXECUTOR_PENDING'), `${kind} → ${r.code}`);
  }
  const probe = await execute('probe', { source: 'x', spawn: fakeSpawn({ format: {}, streams: [] }) });
  assert.equal(probe.ok, true);
});

test('G06 executors: wired AV kinds require a source (MEDIA_SOURCE_MISSING guard)', async () => {
  for (const kind of ['thumbnail', 'proxy', 'waveform', 'frame_extract']) {
    const r = await execute(kind, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDIA_SOURCE_MISSING', `${kind} → ${r.code}`);
  }
});

// ─── stitch dispatch (G11) ───────────────────────────────────────────────────

/**
 * Recording fake spawn for ffmpeg runners (same shape as executorsAv.test.cjs):
 * EventEmitter child + stdout/stderr; captures (bin, args) on fn.calls so tests
 * can assert the exact command line ffmpeg received.
 */
function makeFfmpegSpawn(opts = {}) {
  const {
    enoent = false,
    exitCode = 0,
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
    child.kill = () => {};
    fn.calls.push({ bin, args, child });
    const fire = () => {
      if (errorAfterSpawn) { child.emit('error', errorAfterSpawn); return; }
      for (const d of stderrData) child.stderr.emit('data', d);
      if (emitClose) child.emit('close', exitCode);
    };
    if (emitAsync) setImmediate(fire); else fire();
    return child;
  };
  fn.calls = [];
  return fn;
}

const STITCH_SEGMENTS = [
  { source: '/media/a.mp4', inMs: 2000, outMs: 5000 },
  { source: '/media/b.mp4', inMs: 1500, outMs: 3000 },
];

test('G06 executors: stitch dispatches to runStitch without a top-level source; ffmpeg gets filter_complex with trim seconds', async () => {
  const spawn = makeFfmpegSpawn();
  // No top-level ctx.source: the segment-based gate must route straight to
  // runStitch (a plain single-source guard would have short-circuited here).
  const r = await execute('stitch', { segments: STITCH_SEGMENTS, outKey: '/tmp/stitch.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.result.output, '/tmp/stitch.mp4');
  assert.equal(r.result.segments, 2);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  const fi = args.indexOf('-filter_complex');
  assert.ok(fi !== -1, 'args must contain -filter_complex');
  const filter = args[fi + 1];
  assert.ok(filter.includes('[0:v]trim=start=2.000:end=5.000,setpts=PTS-STARTPTS[v0]'), 'seg0 trim must be 2000/5000 ms → 2.000/5.000 s');
  assert.ok(filter.includes('[1:v]trim=start=1.500:end=3.000,setpts=PTS-STARTPTS[v1]'), 'seg1 trim must be 1500/3000 ms → 1.500/3.000 s');
  assert.ok(filter.endsWith('[v0][v1]concat=n=2:v=1:a=0[v]'), 'filter must concat both labelled streams');
  assert.ok(args.includes('-map'));
  assert.ok(args.includes('[v]'));
  assert.equal(args[args.length - 1], '/tmp/stitch.mp4');
});

test('G06 executors: stitch dispatch failure codes (ENOENT → MEDIA_FFMPEG_UNAVAILABLE, non-zero → MEDIA_STITCH_FAILED)', async () => {
  const enoent = await execute('stitch', { segments: STITCH_SEGMENTS, outKey: 'o.mp4', spawn: makeFfmpegSpawn({ enoent: true }), timeoutMs: 2000 });
  assert.equal(enoent.ok, false);
  assert.equal(enoent.code, 'MEDIA_FFMPEG_UNAVAILABLE');

  const stderr = makeFfmpegSpawn({ exitCode: 1, stderrData: [Buffer.from('Stream map [v] matches no streams')] });
  const failed = await execute('stitch', { segments: STITCH_SEGMENTS, outKey: 'o.mp4', spawn: stderr, timeoutMs: 2000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'MEDIA_STITCH_FAILED');
  assert.ok(failed.message.includes('Stream map [v] matches no streams'));
});

test('G06 executors: stitch without segments/segment source → MEDIA_SOURCE_MISSING (no spawn)', async () => {
  const spawn = makeFfmpegSpawn();
  const none = await execute('stitch', { spawn, timeoutMs: 2000 });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'MEDIA_SOURCE_MISSING');
  const partial = await execute('stitch', { segments: [{ source: 'a.mp4', inMs: 0, outMs: 1000 }, { inMs: 0, outMs: 1000 }], outKey: 'o.mp4', spawn, timeoutMs: 2000 });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, 'MEDIA_SOURCE_MISSING');
  assert.equal(spawn.calls.length, 0, 'no ffmpeg spawn may happen when a segment source is missing');
});

// ─── frame_extract dispatch (G12) ───────────────────────────────────────────

test('G12 executors: frame_extract dispatches to runFrame with a top-level source; ffmpeg gets fast-seek -ss before -i', async () => {
  const spawn = makeFfmpegSpawn();
  const r = await execute('frame_extract', { source: '/videos/clip.mp4', timeMs: 500, outKey: '/tmp/clip.frame.500ms.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.result.output, '/tmp/clip.frame.500ms.png');
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  const iSs = args.indexOf('-ss');
  const iI = args.indexOf('-i');
  assert.ok(iSs !== -1 && iSs + 1 < iI, '-ss <seconds> must precede -i (fast container seek)');
  assert.equal(args[iSs + 1], '0.500');
  assert.equal(args[iI + 1], '/videos/clip.mp4');
  assert.ok(args.includes('-frames:v'));
  assert.equal(args[args.length - 1], '/tmp/clip.frame.500ms.png');
});

test('G12 executors: frame_extract dispatch failure codes (ENOENT → MEDIA_FFMPEG_UNAVAILABLE, non-zero → MEDIA_FRAME_FAILED)', async () => {
  const enoent = await execute('frame_extract', { source: 'a.mp4', timeMs: 500, outKey: 'o.png', spawn: makeFfmpegSpawn({ enoent: true }), timeoutMs: 2000 });
  assert.equal(enoent.ok, false);
  assert.equal(enoent.code, 'MEDIA_FFMPEG_UNAVAILABLE');

  const spawn = makeFfmpegSpawn({ exitCode: 1, stderrData: [Buffer.from('Invalid data found when processing input')] });
  const failed = await execute('frame_extract', { source: 'a.mp4', timeMs: 500, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'MEDIA_FRAME_FAILED');
  assert.ok(failed.message.includes('Invalid data found when processing input'));
});

test('G12 executors: frame_extract without timeMs → MEDIA_FRAME_FAILED (structural violation, no spawn)', async () => {
  const spawn = makeFfmpegSpawn();
  const r = await execute('frame_extract', { source: 'a.mp4', outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FRAME_FAILED');
  assert.ok(/timeMs/.test(r.message));
  assert.equal(spawn.calls.length, 0, 'no ffmpeg spawn may happen for a structurally invalid frame job');
});
