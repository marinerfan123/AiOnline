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
  for (const kind of ['transcode', 'frame_extract', 'render']) {
    const r = await execute(kind, { source: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.code.endsWith('EXECUTOR_PENDING'), `${kind} → ${r.code}`);
  }
  const probe = await execute('probe', { source: 'x', spawn: fakeSpawn({ format: {}, streams: [] }) });
  assert.equal(probe.ok, true);
});

test('G06 executors: wired AV kinds require a source (MEDIA_SOURCE_MISSING guard)', async () => {
  for (const kind of ['thumbnail', 'proxy', 'waveform']) {
    const r = await execute(kind, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDIA_SOURCE_MISSING', `${kind} → ${r.code}`);
  }
});
