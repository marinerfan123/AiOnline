'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectModelBinding, normalizeCapabilities, LEGACY_TO_CANONICAL } = require('./modelSchema.cjs');
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
