'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStudioModelsApi } = require('./studioModelsApi.cjs');

const MODEL_ROW = {
  model_id: 'seedance-2.5',
  name: 'Seedance 2.5',
  provider_id: 'prov-1',
  enabled: true,
  capabilities: { text_to_video: true, 'video.maxDurationMs': 30000 },
  param_template: {
    duration: { type: 'number', label: 'Duration', min: 1, max: 60, default: 5, component: 'slider' },
    modes: { text2video: { enabled: true } },
  },
  modes: null,
};
const PROVIDER_ROW = { id: 'prov-1', name: 'Seedance' };

function harness() {
  const responses = [];
  const sendJSON = (res, code, body) => responses.push({ code, body });
  const api = createStudioModelsApi({
    pg: { async query() { return { rows: [{ ...MODEL_ROW, provider_name: PROVIDER_ROW.name, provider_row_id: PROVIDER_ROW.id }] }; } },
    sessionUser: () => ({ id: 'u1' }),
    sendJSON,
  });
  return { api, responses };
}

test('G07 models API: unauthenticated → 401', async () => {
  const responses = [];
  const api = createStudioModelsApi({
    pg: { query: async () => ({ rows: [] }) },
    sessionUser: () => null,
    sendJSON: (res, code, body) => responses.push({ code, body }),
  });
  await api.handle({}, {}, '/api/studio/models', 'GET');
  assert.equal(responses[0].code, 401);
});

test('G07 models API: list projects canonical bindings (no provider secrets)', async () => {
  const h = harness();
  await h.api.handle({}, {}, '/api/studio/models', 'GET');
  assert.equal(h.responses[0].code, 200);
  const { models, count } = h.responses[0].body;
  assert.equal(count, 1);
  assert.equal(models[0].bindingId, 'seedance-2.5');
  assert.equal(models[0].provider, 'Seedance');
  assert.equal(models[0].capabilities['video.text2video'], true);
  // schema & legacy aliases are NOT part of the list payload
  assert.equal('schema' in models[0], false);
  assert.equal('legacyCapabilities' in models[0], false);
});

test('G07 models API: schema endpoint returns dynamic ModelSchema', async () => {
  const h = harness();
  await h.api.handle({}, {}, '/api/studio/models/seedance-2.5/schema', 'GET');
  assert.equal(h.responses[0].code, 200);
  const { schema } = h.responses[0].body;
  assert.equal(schema.properties.duration.originalField, 'duration');
  assert.equal(schema.properties.duration.component, 'slider');
  assert.equal(schema.modes.text2video.enabled, true);
});

test('G07 models API: capabilities endpoint + 404 unknown binding', async () => {
  const h = harness();
  await h.api.handle({}, {}, '/api/studio/models/seedance-2.5/capabilities', 'GET');
  assert.equal(h.responses[0].code, 200);
  assert.equal(h.responses[0].body.capabilities['video.maxDurationMs'], 30000);
  assert.equal(h.responses[0].body.legacyCapabilities.text_to_video, true);
  await h.api.handle({}, {}, '/api/studio/models/nope/schema', 'GET');
  assert.equal(h.responses[1].code, 404);
});

test('G07 models API: OPTIONS returns 204 and other prefixes pass through', async () => {
  const h = harness();
  await h.api.handle({}, {}, '/api/studio/models', 'OPTIONS');
  assert.equal(h.responses[0].code, 204);
  const r = await h.api.handle({}, {}, '/api/v2/projects', 'GET');
  assert.equal(r, false);
});
