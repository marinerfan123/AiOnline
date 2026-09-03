'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateDeliverySpec, sanitizeDeliverySpec, DEFAULT_DELIVERY_SPEC, DELIVERY_SPEC_FIELDS } = require('./deliverySpec.cjs');

test('valid delivery spec passes', () => {
  const s = { aspect_ratio: '9:16', resolution: { width: 1080, height: 1920 }, duration: 30, fps: 30, platform: 'douyin', subtitles: true, audio: 'stereo', safe_area: 0.1, variants: [{ name: 'v1' }] };
  assert.equal(validateDeliverySpec(s).ok, true);
});

test('defaults are explicit and versioned', () => {
  assert.equal(DEFAULT_DELIVERY_SPEC.aspect_ratio, '9:16');
  assert.ok(Number.isInteger(DEFAULT_DELIVERY_SPEC.version));
  const s = sanitizeDeliverySpec({});
  assert.equal(s.version, 1);
  assert.equal(s.aspect_ratio, '9:16');
  // update bumps version
  const s2 = sanitizeDeliverySpec({ duration: 60 }, { version: 1 });
  assert.equal(s2.version, 2);
  assert.equal(s2.duration, 60);
});

test('bad aspect_ratio / resolution / fps / safe_area rejected', () => {
  const r = validateDeliverySpec({ aspect_ratio: 'bad', resolution: { width: -1, height: 0 }, fps: 0, safe_area: 2 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('aspect_ratio')));
  assert.ok(r.errors.some((e) => e.includes('resolution')));
  assert.ok(r.errors.some((e) => e.includes('fps')));
  assert.ok(r.errors.some((e) => e.includes('safe_area')));
});

test('bad platform & unknown field rejected', () => {
  assert.equal(validateDeliverySpec({ platform: 'nope' }).ok, false);
  const r = validateDeliverySpec({ platform: 'tiktok', extra: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('extra')));
});

test('sanitize drops unknown keys', () => {
  const out = sanitizeDeliverySpec({ duration: 30, secret: 'leak' });
  assert.equal(out.secret, undefined);
  assert.equal(out.duration, 30);
});

test('all W1-03 fields are enumerated', () => {
  for (const f of ['aspect_ratio', 'resolution', 'duration', 'fps', 'platform', 'subtitles', 'audio', 'safe_area', 'variants']) {
    assert.ok(DELIVERY_SPEC_FIELDS.includes(f), `missing field ${f}`);
  }
});
