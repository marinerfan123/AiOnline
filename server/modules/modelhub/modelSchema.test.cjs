'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectModelBinding, normalizeCapabilities, LEGACY_TO_CANONICAL, validateOperationInput } = require('./modelSchema.cjs');
const C = require('../studio-contracts/envelopes.cjs');

test('G07: legacy generation capability maps to blueprint-canonical key', () => {
  const caps = normalizeCapabilities({ text_to_image: 1, image_to_video: true });
  assert.equal(caps['image.text2image'], true);
  assert.equal(caps['video.image2video'], true);
  assert.equal(LEGACY_TO_CANONICAL.text_to_image, 'image.text2image');
});

test('G07: capability projection passes the G00 ModelCapability schema for video keys', () => {
  const caps = normalizeCapabilities({ 'video.text2video': true, 'video.maxDurationMs': 30000, 'reference.image.max': 9 });
  const r = C.validateModelCapability(caps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('G07: param_template maps to dynamic ModelSchema properties (originalField retained)', () => {
  const row = {
    model_id: 'seedance-2.5',
    name: 'Seedance 2.5',
    provider_id: 'prov-1',
    capabilities: { text_to_video: true, 'video.maxDurationMs': 30000 },
    param_template: {
      duration: { type: 'number', label: 'Duration', min: 1, max: 60, default: 5, component: 'slider' },
      resolution: { type: 'enum', label: 'Resolution', enum: ['1280x720', '720x1280'] },
      modes: { text2video: { enabled: true } },
    },
  };
  const provider = { id: 'prov-1', name: 'Seedance' };
  const p = projectModelBinding(row, provider);
  assert.equal(p.bindingId, 'seedance-2.5');
  assert.equal(p.name, 'Seedance 2.5');
  assert.equal(p.capabilities['video.text2video'], true);
  assert.equal(p.legacyCapabilities.text_to_video, true);
  assert.equal(p.schema.properties.duration.type, 'number');
  assert.equal(p.schema.properties.duration.min, 1);
  assert.equal(p.schema.properties.duration.component, 'slider');
  assert.equal(p.schema.properties.duration.originalField, 'duration');
  assert.deepEqual(p.schema.properties.resolution.enum, ['1280x720', '720x1280']);
  assert.equal(p.schema.modes.text2video.enabled, true);
  assert.equal(p.provider, 'Seedance');
});

test('G07: scalar template defaults projected as string defaults with originalField', () => {
  const row = { model_id: 'm1', name: 'M1', param_template: { quality: 'high', negativePrompt: '' } };
  const p = projectModelBinding(row, {});
  assert.equal(p.schema.properties.quality.default, 'high');
  assert.equal(p.schema.properties.quality.originalField, 'quality');
});

/* ══ L4 — validateOperationInput runtime (Blueprint 04 §8-9) ════════ */

test('L4: required — missing required property fails, present passes', () => {
  const schema = { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } };
  assert.equal(validateOperationInput(schema, {}).ok, false);
  assert.match(validateOperationInput(schema, {}).errors[0], /required property "prompt" missing/);
  assert.equal(validateOperationInput(schema, { prompt: 'x' }).ok, true);
});

test('L4: 长度 — minLength/maxLength and numeric min/max enforced', () => {
  const s = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 3, maxLength: 6 },
      duration: { type: 'number', min: 1, max: 60 },
      tags: { type: 'array', minItems: 1, maxItems: 3 },
    },
  };
  assert.equal(validateOperationInput(s, { title: 'ab' }).ok, false);           // too short
  assert.equal(validateOperationInput(s, { title: 'abcdefg' }).ok, false);      // too long
  assert.equal(validateOperationInput(s, { title: 'good' }).ok, true);
  assert.equal(validateOperationInput(s, { duration: 0 }).ok, false);           // < min
  assert.equal(validateOperationInput(s, { duration: 61 }).ok, false);          // > max
  assert.equal(validateOperationInput(s, { duration: 5 }).ok, true);
  assert.equal(validateOperationInput(s, { tags: [] }).ok, false);              // < minItems
  assert.equal(validateOperationInput(s, { tags: [1, 2, 3, 4] }).ok, false);    // > maxItems
  assert.equal(validateOperationInput(s, { tags: ['a'] }).ok, true);
});

test('L4: 枚举 — enum (deep equality) rejects values outside the set', () => {
  const s = { type: 'object', properties: { ratio: { enum: ['16:9', '9:16', '1:1'] } } };
  assert.equal(validateOperationInput(s, { ratio: '16:9' }).ok, true);
  assert.equal(validateOperationInput(s, { ratio: '4:3' }).ok, false);
  const deep = { enum: [{ w: 1920, h: 1080 }, { w: 1080, h: 1920 }] };
  assert.equal(validateOperationInput({ type: 'object', properties: { size: deep } }, { size: { w: 1920, h: 1080 } }).ok, true);
  assert.equal(validateOperationInput({ type: 'object', properties: { size: deep } }, { size: { w: 720, h: 1280 } }).ok, false);
});

test('L4: oneOf 排他 — exactly one branch must match', () => {
  const s = {
    type: 'object',
    oneOf: [
      { required: ['text'], properties: { text: { type: 'string' } } },
      { required: ['image'], properties: { image: { type: 'string' } } },
    ],
  };
  assert.equal(validateOperationInput(s, { text: 'hello' }).ok, true);
  assert.equal(validateOperationInput(s, { image: 'img.png' }).ok, true);
  assert.equal(validateOperationInput(s, { text: 'hello', image: 'img.png' }).ok, false); // matches both → not exclusive
  assert.equal(validateOperationInput(s, {}).ok, false);                                  // matches neither
  assert.match(validateOperationInput(s, {}).errors[0], /got 0/);
});

test('L4: 组合交叉字段不误判 — allOf + unevaluatedProperties:false keeps cross-branch fields', () => {
  const s = {
    type: 'object',
    allOf: [
      { required: ['prompt'], properties: { prompt: { type: 'string' } } },
      { required: ['duration'], properties: { duration: { type: 'number', min: 1 } } },
    ],
    unevaluatedProperties: false,
  };
  // prompt (branch 1) and duration (branch 2) are both evaluated → legal together.
  assert.equal(validateOperationInput(s, { prompt: 'x', duration: 5 }).ok, true);
  // a field declared in NEITHER branch is unevaluated → rejected.
  assert.equal(validateOperationInput(s, { prompt: 'x', duration: 5, extra: 1 }).ok, false);
  assert.match(validateOperationInput(s, { prompt: 'x', duration: 5, extra: 1 }).errors[0], /extra: unevaluated property not allowed/);
  // still enforces the per-branch type constraint.
  assert.equal(validateOperationInput(s, { prompt: 123, duration: 5 }).ok, false);
});

test('L4: 未知键按 unevaluatedProperties 规则 — flat schema rejects unknown keys', () => {
  const s = { type: 'object', properties: { prompt: { type: 'string' } }, unevaluatedProperties: false };
  assert.equal(validateOperationInput(s, { prompt: 'ok' }).ok, true);
  assert.equal(validateOperationInput(s, { prompt: 'ok', secret: 1 }).ok, false);
  // unevaluatedProperties as a schema validates (rather than bans) extra keys.
  const s2 = { type: 'object', properties: { prompt: { type: 'string' } }, unevaluatedProperties: { type: 'string' } };
  assert.equal(validateOperationInput(s2, { prompt: 'x', meta: 'note' }).ok, true);
  assert.equal(validateOperationInput(s2, { prompt: 'x', meta: 5 }).ok, false);
});

test('L4: allOf/anyOf/not/type/pattern/const combinators', () => {
  assert.equal(validateOperationInput({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 3).ok, true);
  assert.equal(validateOperationInput({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 1).ok, false);
  assert.equal(validateOperationInput({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 5).ok, true);
  assert.equal(validateOperationInput({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true).ok, false);
  assert.equal(validateOperationInput({ not: { type: 'string' } }, 5).ok, true);
  assert.equal(validateOperationInput({ not: { type: 'string' } }, 'x').ok, false);
  assert.equal(validateOperationInput({ type: 'string', pattern: '^[a-z]+$' }, 'abc').ok, true);
  assert.equal(validateOperationInput({ type: 'string', pattern: '^[a-z]+$' }, 'ABC').ok, false);
  assert.equal(validateOperationInput({ const: 'fixed' }, 'fixed').ok, true);
  assert.equal(validateOperationInput({ const: 'fixed' }, 'other').ok, false);
  assert.equal(validateOperationInput({ type: ['string', 'null'] }, null).ok, true);
  assert.equal(validateOperationInput({ type: 'integer' }, 1.5).ok, false);
});

test('L4: nested properties recurse with dotted error paths', () => {
  const s = {
    type: 'object',
    required: ['cfg'],
    properties: { cfg: { type: 'object', required: ['width'], properties: { width: { type: 'integer', minimum: 1 } } } },
  };
  assert.equal(validateOperationInput(s, { cfg: { width: 10 } }).ok, true);
  const r = validateOperationInput(s, { cfg: {} });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /cfg: required property "width" missing/);
});

test('L4: non-object schema argument is rejected with a clear error', () => {
  const r = validateOperationInput(null, {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /schema must be a JSON Schema object or boolean/);
});
