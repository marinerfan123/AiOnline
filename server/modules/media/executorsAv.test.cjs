'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  buildThumbnailCommand,
  buildProxyCommand,
  buildWaveformCommand,
  runThumbnail,
  runProxy,
  runWaveform,
} = require('./executorsAv.cjs');

/**
 * Fake spawn: EventEmitter child with EventEmitter stdout/stderr streams.
 * Injected behavior:
 *   enoent            → spawn throws an ENOENT error
 *   exitCode          → close(code) emitted after stdout data (default 0)
 *   stdoutData        → Buffers emitted on child.stdout before close
 *   stderrData        → Buffers emitted on child.stderr before close
 *   errorAfterSpawn   → emit('error', err) instead of data/close
 *   emitClose:false   → never emit close (for timeout tests)
 * kill() is recorded on the child; captured spawn calls are on fn.calls.
 */
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

/** Deterministic PRNG → random f32 samples in [-1, 1]. */
function randomF32Samples(count, seed = 12345) {
  let s = seed >>> 0;
  const rand = () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const buf = Buffer.allocUnsafe(count * 4);
  for (let i = 0; i < count; i++) buf.writeFloatLE(rand() * 2 - 1, i * 4);
  return buf;
}

// ─── command builders ───────────────────────────────────────────────────────

test('AV thumbnail command: image source carries -vf scale=-2:512, no -frames:v', () => {
  const cmd = buildThumbnailCommand({ source: 'https://oss.example.com/photos/cover.png?x=1&y=2', outKey: '/tmp/cover.thumb.png' });
  assert.equal(cmd.inputKind, 'image');
  assert.ok(cmd.args.includes('-vf'));
  assert.ok(cmd.args.includes('scale=-2:512'), 'args should contain scale=-2:512');
  assert.ok(!cmd.args.includes('-frames:v'), 'still image must not request frame extraction');
  assert.equal(cmd.args[cmd.args.length - 1], '/tmp/cover.thumb.png');
  assert.equal(cmd.output, '/tmp/cover.thumb.png');
});

test('AV thumbnail command: video source adds -frames:v 1, defaults to .thumb.jpg', () => {
  const cmd = buildThumbnailCommand({ source: '/videos/clip.mp4' });
  assert.equal(cmd.inputKind, 'video');
  assert.ok(cmd.args.includes('scale=-2:512'));
  assert.ok(cmd.args.includes('-frames:v'));
  assert.ok(cmd.args.includes('1'));
  assert.ok(cmd.output.endsWith('clip.thumb.jpg'));
  assert.equal(cmd.args[cmd.args.length - 1], cmd.output);
});

test('AV proxy command: scale=1280:-2 + -r 24 + libx264 veryfast crf 23, mp4 output', () => {
  const cmd = buildProxyCommand({ source: 'https://oss.example.com/videos/raw.mp4', outKey: '/tmp/raw.proxy.mp4' });
  assert.ok(cmd.args.includes('-vf'));
  assert.ok(cmd.args.includes('scale=1280:-2'));
  assert.ok(cmd.args.includes('-r'));
  assert.ok(cmd.args.includes('24'));
  assert.ok(cmd.args.includes('libx264'));
  assert.ok(cmd.args.includes('veryfast'));
  assert.ok(cmd.args.includes('23'));
  assert.equal(cmd.output, '/tmp/raw.proxy.mp4');
  assert.equal(cmd.width, 1280);
  assert.equal(cmd.fps, 24);
});

test('AV proxy command: width/fps overrides flow into -vf/-r; odd width is even-ified', () => {
  const cmd = buildProxyCommand({ source: 'x.mp4', width: 641, fps: 15 });
  assert.ok(cmd.args.includes('scale=640:-2'));
  assert.ok(cmd.args.includes('-r'));
  assert.ok(cmd.args.includes('15'));
  assert.equal(cmd.output, 'x.proxy.mp4');
});

test('AV waveform command: decodes to mono f32le 1000 Hz on pipe stdout', () => {
  const cmd = buildWaveformCommand({ source: '/audio/song.m4a' });
  const iFmt = cmd.args.indexOf('-f');
  assert.ok(iFmt !== -1);
  assert.equal(cmd.args[iFmt + 1], 'f32le');
  assert.ok(cmd.args.includes('-ac'));
  assert.ok(cmd.args.includes('1'));
  assert.ok(cmd.args.includes('-ar'));
  assert.ok(cmd.args.includes('1000'));
  assert.equal(cmd.args[cmd.args.length - 1], 'pipe:1');
  assert.equal(cmd.output, null);
});

// ─── runners: success paths ─────────────────────────────────────────────────

test('AV runThumbnail: exit 0 → ok with output/inputKind; ffmpeg invoked with scale', async () => {
  const spawn = makeFakeSpawn();
  const r = await runThumbnail({ source: '/videos/clip.mp4', outKey: '/tmp/t.jpg', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.result.output, '/tmp/t.jpg');
  assert.equal(r.result.inputKind, 'video');
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  assert.ok(spawn.calls[0].args.includes('scale=-2:512'));
  assert.ok(spawn.calls[0].args.includes('-frames:v'));
});

test('AV runProxy: exit 0 → ok with resolved width/fps/output', async () => {
  const spawn = makeFakeSpawn();
  const r = await runProxy({ source: 'https://oss.example.com/v.mp4', width: 1920, fps: 30, spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.result.width, 1920);
  assert.equal(r.result.fps, 30);
  assert.ok(r.result.output.endsWith('.proxy.mp4'));
});

test('AV runWaveform: exit 0 → 400 peak buckets parsed from 160000 f32le bytes, values within -1..1', async () => {
  const pcm = randomF32Samples(40000); // 40000 samples × 4 bytes = 160000 bytes
  assert.equal(pcm.length, 160000);
  const spawn = makeFakeSpawn({ stdoutData: [pcm] });
  const r = await runWaveform({ source: '/audio/song.m4a', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.result.sampleCount, 40000);
  assert.equal(r.result.sampleRate, 1000);
  assert.equal(r.result.channels, 1);
  assert.equal(r.result.buckets, 400);
  assert.ok(Array.isArray(r.result.peaks));
  assert.equal(r.result.peaks.length, 400);
  for (let i = 0; i < 400; i++) {
    const p = r.result.peaks[i];
    assert.equal(p.i, i);
    assert.ok(Number.isFinite(p.min) && Number.isFinite(p.max), `bucket ${i} must be finite`);
    assert.ok(p.min >= -1 && p.max <= 1, `bucket ${i} values must stay within [-1,1] (got ${p.min}..${p.max})`);
    assert.ok(p.min <= p.max, `bucket ${i} min<=max`);
  }
});

// ─── runners: failure paths ─────────────────────────────────────────────────

test('AV runners: spawn ENOENT → MEDIA_FFMPEG_UNAVAILABLE (thumbnail/proxy/waveform)', async () => {
  for (const [run, kind] of [[runThumbnail, 'thumbnail'], [runProxy, 'proxy'], [runWaveform, 'waveform']]) {
    const spawn = makeFakeSpawn({ enoent: true });
    const r = await run({ source: 'x.mp4', spawn, timeoutMs: 2000 });
    assert.equal(r.ok, false, `${kind}: ok must be false`);
    assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE', `${kind}: unexpected code ${r.code}`);
    assert.ok(r.message && r.message.length > 0);
  }
});

test('AV runners: ENOENT error emitted after spawn → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const e = new Error('spawn ffmpeg ENOENT');
  e.code = 'ENOENT';
  const spawn = makeFakeSpawn({ errorAfterSpawn: e });
  const r = await runThumbnail({ source: 'x.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
});

test('AV runThumbnail: non-zero exit → MEDIA_THUMBNAIL_FAILED with stderr message', async () => {
  const spawn = makeFakeSpawn({ exitCode: 1, stderrData: [Buffer.from('Invalid pixel format')] });
  const r = await runThumbnail({ source: 'x.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_THUMBNAIL_FAILED');
  assert.ok(r.message.includes('Invalid pixel format'));
});

test('AV runProxy: non-zero exit → MEDIA_PROXY_FAILED', async () => {
  const spawn = makeFakeSpawn({ exitCode: 2 });
  const r = await runProxy({ source: 'x.mp4', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_PROXY_FAILED');
  assert.ok(r.message.length > 0);
});

test('AV runWaveform: non-zero exit → MEDIA_WAVEFORM_FAILED', async () => {
  const spawn = makeFakeSpawn({ exitCode: 1, stderrData: [Buffer.from('Invalid data found')] });
  const r = await runWaveform({ source: 'bad.audio', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_WAVEFORM_FAILED');
  assert.ok(r.message.includes('Invalid data found'));
});

test('AV runners: no close within timeoutMs → kill() + MEDIA_<KIND>_TIMEOUT', async () => {
  for (const [run, expected] of [
    [runThumbnail, 'MEDIA_THUMBNAIL_TIMEOUT'],
    [runProxy, 'MEDIA_PROXY_TIMEOUT'],
    [runWaveform, 'MEDIA_WAVEFORM_TIMEOUT'],
  ]) {
    const spawn = makeFakeSpawn({ emitClose: false });
    const r = await run({ source: 'x.mp4', spawn, timeoutMs: 20 });
    assert.equal(r.ok, false, `${expected}: ok must be false`);
    assert.equal(r.code, expected, `unexpected code ${r.code}`);
    assert.equal(spawn.calls.length, 1);
    const child = spawn.calls[0].child;
    assert.ok(child.killed, `${expected}: child.kill() must have been called`);
  }
});
