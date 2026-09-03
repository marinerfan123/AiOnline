'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStudioModelsApi, computeAvailable } = require('./studioModelsApi.cjs');

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

// ── Fake dispatch surface rows (mirror bindings.cjs loadDispatchPairs reads) ──
const BINDING_ROW = { id: 'b-a', model_id: 'seedance-2.5', provider_id: 'prov-1', upstream_model_name: 'seedance-2.5', enabled: true, priority: 0, weight: 0 };
const DISPATCH_MODEL_ROW = { model_id: 'seedance-2.5', provider_id: 'prov-1', enabled: true };
const LIVE_PROVIDER = { id: 'prov-1', enabled: true, api_key: 'sk-test-123456' };

/**
 * Fake PG pool serving both loadBindings (models list) and loadDispatchPairs
 * (provider_model_bindings / models / providers / api_keys) queries.
 */
function makePool({ modelRows, bindings, dispatchModels, providers, apiKeys } = {}) {
  return {
    async query(sql, params = []) {
      const T = (sql || '').toUpperCase();
      if (T.includes('PROVIDER_MODEL_BINDINGS')) {
        const ids = params[0] || [];
        return { rows: (bindings || []).filter((b) => b.enabled && ids.includes(b.model_id)) };
      }
      if (T.includes('LEFT JOIN PROVIDERS')) {
        return { rows: modelRows || [] };
      }
      if (T.includes('FROM MODELS')) {
        return { rows: (dispatchModels || []).filter((m) => m.enabled !== false) };
      }
      if (T.includes('FROM PROVIDERS')) {
        return { rows: providers || [] };
      }
      if (T.includes('FROM API_KEYS')) {
        return { rows: apiKeys || [] };
      }
      return { rows: [] };
    },
  };
}

function harness(overrides = {}) {
  const responses = [];
  const sendJSON = (res, code, body) => responses.push({ code, body });
  const modelRows = overrides.modelRows ?? [{ ...MODEL_ROW, provider_name: PROVIDER_ROW.name, provider_row_id: PROVIDER_ROW.id }];
  const pg = makePool({
    modelRows,
    bindings: overrides.bindings ?? [BINDING_ROW],
    dispatchModels: overrides.dispatchModels ?? [DISPATCH_MODEL_ROW],
    providers: overrides.providers ?? [LIVE_PROVIDER],
    apiKeys: overrides.apiKeys ?? [],
  });
  const api = createStudioModelsApi({ pg, sessionUser: () => ({ id: 'u1' }), sendJSON });
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

test('G07 models API: bindings-aware view → available true + lineCount with live line', async () => {
  const h = harness();
  await h.api.handle({}, {}, '/api/studio/models', 'GET');
  const m = h.responses[0].body.models[0];
  assert.equal(m.lineCount, 1);
  assert.equal(m.available['video.text2video'], true);
  // numeric limit keys are not boolean capabilities → never in `available`
  assert.equal('video.maxDurationMs' in m.available, false);
});

test('G07 models API: bindings-aware view → no key ⇒ available false + lineCount 0', async () => {
  const h = harness({ providers: [{ id: 'prov-1', enabled: true, api_key: '' }], apiKeys: [] });
  await h.api.handle({}, {}, '/api/studio/models', 'GET');
  const m = h.responses[0].body.models[0];
  assert.equal(m.lineCount, 0);
  assert.equal(m.available['video.text2video'], false);
});

test('G07 models API: bindings-aware view → disabled provider ⇒ available false', async () => {
  const h = harness({ providers: [{ id: 'prov-1', enabled: false, api_key: 'sk-test-123456' }] });
  await h.api.handle({}, {}, '/api/studio/models', 'GET');
  const m = h.responses[0].body.models[0];
  assert.equal(m.lineCount, 0);
  assert.equal(m.available['video.text2video'], false);
});

test('computeAvailable: numeric limits skipped; booleans gated by lineCount', () => {
  const caps = { 'video.text2video': true, 'video.maxDurationMs': 30000, 'image.text2image': true };
  assert.deepEqual(computeAvailable(caps, 2), { 'video.text2video': true, 'image.text2image': true });
  assert.deepEqual(computeAvailable(caps, 0), { 'video.text2video': false, 'image.text2image': false });
  assert.deepEqual(computeAvailable({ 'video.text2video': false }, 5), { 'video.text2video': false });
  assert.deepEqual(computeAvailable(undefined, 0), {});
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

test('G07 autolink resolve: 400 without projectId/text', async () => {
  const responses = [];
  const api = createStudioModelsApi({
    pg: { query: async () => ({ rows: [] }) },
    sessionUser: () => ({ id: 'u1' }),
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({}),
  });
  await api.handle({}, {}, '/api/studio/autolink/resolve', 'POST');
  assert.equal(responses[0].code, 400);
});

test('G07 autolink resolve: membership-guarded + resolves tokens', async () => {
  const responses = [];
  const api = createStudioModelsApi({
    pg: {
      async query(sql) {
        if (sql.includes('FROM projects p')) return { rows: [{ workspace_id: 'ws-1' }] };
        if (sql.includes('FROM project_characters')) return { rows: [{ id: 'ch-1', name: 'Alice' }] };
        if (sql.includes('FROM project_references')) return { rows: [] };
        return { rows: [] };
      },
    },
    sessionUser: () => ({ id: 'u1' }),
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({ projectId: 'p1', text: '让 @Alice 表演' }),
  });
  await api.handle({}, {}, '/api/studio/autolink/resolve', 'POST');
  assert.equal(responses[0].code, 200);
  assert.equal(responses[0].body.results.length, 1);
  assert.equal(responses[0].body.results[0].binding.entityId, 'ch-1');
  assert.equal(responses[0].body.results[0].resolution, 'exact');
});

test('G07 autolink resolve: denies cross-project access', async () => {
  const responses = [];
  const api = createStudioModelsApi({
    pg: { query: async () => ({ rows: [] }) },
    sessionUser: () => ({ id: 'u1' }),
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({ projectId: 'p-other', text: '@Alice' }),
  });
  await api.handle({}, {}, '/api/studio/autolink/resolve', 'POST');
  assert.equal(responses[0].code, 403);
});

test('G07 shortcuts API: lists server-configured shortcuts, filtered by nodeType', async () => {
  const h = harness();
  await h.api.handle({ query: { nodeType: 'text' } }, {}, '/api/studio/shortcuts', 'GET');
  assert.equal(h.responses[0].code, 200);
  const all = h.responses[0].body.shortcuts;
  assert.ok(all.length >= 3);
  assert.ok(all.every((s) => s.applicableNodeTypes.includes('text')));
  assert.ok(all.some((s) => s.slash === 'optimize'));
  await h.api.handle({ query: {} }, {}, '/api/studio/shortcuts', 'GET');
  assert.ok(h.responses[1].body.shortcuts.length >= all.length);
});
