'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inferModelType } = require('./model-type.cjs');

test('all current model families keep their media type', () => {
  const cases = [
    ['agnes-image-2.1-flash', 'image'],
    ['agnes-image-2.5-flash', 'image'],
    ['gpt-image-2', 'image'],
    ['doubao-seedream-4-5-251128', 'image'],
    ['doubao-seedream-3-0-t2i', 'image'],
    ['agnes-video-2.5', 'video'],
    ['agnes-video-2.5-flash', 'video'],
    ['agnes-video-v2.0', 'video'],
    ['doubao-seedance-2.5', 'video'],
    ['sora-2', 'video'],
    ['gpt-5.6-sol', 'text'],
    ['agnes-3.0-flash', 'text'],
  ];
  for (const [modelId, expected] of cases) {
    assert.equal(inferModelType(modelId), expected, modelId);
  }
});

test('explicit stored media type is retained for provider-specific IDs', () => {
  assert.equal(inferModelType('vendor-custom-model', 'image'), 'image');
  assert.equal(inferModelType('vendor-custom-model', 'video'), 'video');
  assert.equal(inferModelType('vendor-custom-model', 'text'), 'text');
});
