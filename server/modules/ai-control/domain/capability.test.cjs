'use strict';
/**
 * M02-A — Capability Registry domain tests.
 * Run: node --test server/modules/ai-control/domain/capability.test.cjs
 * No PG, no network — pure domain validation.
 * NOTE: type is a CLOSED enum of specific capabilities (text_to_image,
 * text_to_video, ...). A bare 'image' is NOT a valid capability type.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const cap = require('./capability.cjs');

test('capability: valid docs pass', () => {
  assert.equal(cap.validateCapability({ type: 'text_to_video' }).ok, true);
  assert.equal(cap.validateCapability({
    type: 'text_to_image',
    capabilities: { text_to_image: true, image_to_image: true },
    input_modalities: ['text', 'image'],
    output_modalities: ['image'],
    parameter_schema: {
      prompt: { type: 'string', required: true },
      aspect_ratio: { type: 'enum', enum: ['1:1', '16:9'] },
      seed: { type: 'integer', min: 0, max: 1_000_000 },
    },
    pricing_dimensions: ['per_asset'],
    version: 1,
  }).ok, true);
});

test('capability: unknown type rejected', () => {
  const r = cap.validateCapability({ type: 'teleport' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('type')));
});

test('capability: capabilities keys must be valid types + booleans', () => {
  assert.equal(cap.validateCapability({ type: 'text_to_image', capabilities: { nope: true } }).ok, false);
  assert.equal(cap.validateCapability({ type: 'text_to_image', capabilities: { text_to_image: 'yes' } }).ok, false);
  assert.equal(cap.validateCapability({ type: 'text_to_image', capabilities: { text_to_image: true } }).ok, true);
});

test('capability: modalities validated', () => {
  assert.equal(cap.validateCapability({ type: 'text_to_image', input_modalities: ['hologram'] }).ok, false);
  assert.equal(cap.validateCapability({ type: 'text_to_image', output_modalities: ['video'] }).ok, true);
});

test('capability: parameter_schema atom types + enum + ranges', () => {
  assert.equal(cap.validateCapability({ type: 'text_to_image', parameter_schema: { x: { type: 'wat' } } }).ok, false);
  assert.equal(cap.validateCapability({ type: 'text_to_image', parameter_schema: { r: { type: 'enum' } } }).ok, false); // enum needs values
  assert.equal(cap.validateCapability({ type: 'text_to_image', parameter_schema: { r: { type: 'enum', enum: ['a'] } } }).ok, true);
  assert.equal(cap.validateCapability({ type: 'text_to_image', parameter_schema: { n: { type: 'number', min: 'x' } } }).ok, false);
});

test('capability: pricing dimensions validated', () => {
  assert.equal(cap.validateCapability({ type: 'text_to_image', pricing_dimensions: ['per_bogus'] }).ok, false);
  assert.equal(cap.validateCapability({ type: 'text_to_image', pricing_dimensions: ['per_1k_input_token', 'per_asset'] }).ok, true);
});

test('capability: version must be int >=1', () => {
  assert.equal(cap.validateCapability({ type: 'text_to_image', version: 0 }).ok, false);
  assert.equal(cap.validateCapability({ type: 'text_to_image', version: 1.5 }).ok, false);
  assert.equal(cap.validateCapability({ type: 'text_to_image', version: 2 }).ok, true);
});

test('capability: binding overrides can NARROW but never EXTEND', () => {
  const base = { type: 'text_to_video', capabilities: { text_to_video: true, image_to_video: true } };
  // narrow: disable image_to_video on a specific binding
  const narrowed = cap.mergeCapabilityOverrides(base, { capabilities: { image_to_video: false } });
  assert.equal(narrowed.capabilities.image_to_video, false);
  assert.equal(narrowed.capabilities.text_to_video, true);
  // extend: try to add text_to_image (not on base) — must be IGNORED
  const extended = cap.mergeCapabilityOverrides(base, { capabilities: { text_to_image: true } });
  assert.ok(!('text_to_image' in extended.capabilities), 'binding cannot add a capability the logical model lacks');
});

test('capability: request satisfaction (type + required params)', () => {
  const doc = { type: 'text_to_video', capabilities: { text_to_video: true }, parameter_schema: { prompt: { type: 'string' }, duration: { type: 'integer' } } };
  assert.equal(cap.capabilitySatisfiesRequest(doc, { contentType: 'video', requires: ['prompt', 'duration'] }).ok, true);
  assert.equal(cap.capabilitySatisfiesRequest(doc, { contentType: 'audio' }).ok, false);
  assert.equal(cap.capabilitySatisfiesRequest(doc, { requires: ['seed'] }).ok, false);
  const missing = cap.capabilitySatisfiesRequest(doc, { requires: ['seed', 'prompt'] });
  assert.deepEqual(missing.missing, ['param:seed']);
});

test('capability: optional zod schema present when zod available', () => {
  const z = cap.zodCapabilitySchema();
  if (z) {
    assert.equal(z.safeParse({ type: 'text' }).success, true);
    assert.equal(z.safeParse({ type: 'nope' }).success, false);
  }
});
