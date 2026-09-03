'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { adaptImage, adaptVideo, SUPPORTED_PROVIDERS } = require('./providerAdapter.cjs');

const COMPILED = { prompt: 'A hero rises', version: 1, capability: 'internal' };

test('image adapter maps prompt + aspect/resolution to provider payload', () => {
  const r = adaptImage(COMPILED, { provider: 'amper', deliverySpec: { aspect_ratio: '9:16', resolution: '720x1280' } });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'image');
  assert.equal(r.payload.width, 720);
  assert.equal(r.payload.height, 1280);
  assert.equal(r.payload.prompt, 'A hero rises');
});

test('video adapter maps duration/fps/aspect', () => {
  const r = adaptVideo(COMPILED, { provider: 'kling', deliverySpec: { duration: 10, fps: 30, aspect_ratio: '16:9' } });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'video');
  assert.equal(r.payload.duration, 10);
  assert.equal(r.payload.fps, 30);
  assert.equal(r.payload.width, 1280);
});

test('unknown provider -> INVALID_PROVIDER', () => {
  const r = adaptImage(COMPILED, { provider: 'vibe-engine' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_PROVIDER');
});

test('SUPPORTED_PROVIDERS explicit', () => {
  assert.deepEqual([...SUPPORTED_PROVIDERS].sort(), ['amper', 'genmo', 'genny', 'kling', 'openai']);
});

test('video adapter rounds duration to integer', () => {
  const r = adaptVideo(COMPILED, { provider: 'kling', deliverySpec: { duration: 10.6, fps: 30 } });
  assert.equal(r.ok, true);
  assert.equal(r.payload.duration, 11);
});

test('video adapter clamps duration over maxDurationMs (ms)', () => {
  const r = adaptVideo(COMPILED, { provider: 'kling', deliverySpec: { duration: 120 }, options: { maxDurationMs: 60000 } });
  assert.equal(r.ok, true);
  assert.equal(r.payload.duration, 60);
});

test('video adapter clamps durationMs over maxDurationMs', () => {
  const r = adaptVideo(COMPILED, { provider: 'kling', deliverySpec: { durationMs: 90000 }, options: { maxDurationMs: 60000 } });
  assert.equal(r.ok, true);
  assert.equal(r.payload.duration, 60);
});

test('video adapter parses resolution WxH into width/height', () => {
  const r = adaptVideo(COMPILED, { provider: 'kling', deliverySpec: { resolution: '720x1280' } });
  assert.equal(r.ok, true);
  assert.equal(r.payload.width, 720);
  assert.equal(r.payload.height, 1280);
});

test('video adapter rejects invalid resolution', () => {
  const r = adaptVideo(COMPILED, { provider: 'kling', deliverySpec: { resolution: 'not-a-resolution' } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_RESOLUTION');
  const r2 = adaptVideo(COMPILED, { provider: 'kling', deliverySpec: { resolution: '0x0' } });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'INVALID_RESOLUTION');
});
