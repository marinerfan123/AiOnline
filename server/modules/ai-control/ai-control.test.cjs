'use strict';
/**
 * M02-A — Repository + Service NO-SECRET + projection tests.
 * Uses an in-memory fake pg pool (no real DB). The critical assertions:
 *   - provider/key API projections never contain the full api_key
 *   - user-facing model view strips admin-only route params
 *   - provider cost / margin only in admin quote projection
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('./repositories/aiControlRepository.cjs');
const svc = require('./services/aiControlService.cjs');

const LEGACY_KEY = 'sk-legacy-AAAA-BBBB';
const POOL_KEY = 'sk-poolkey-1111-2222-3333';

function fakePg() {
  const providers = [{
    id: 'p1', name: 'Agnes', type: 'official', base_url: 'https://api.agnes-ai.cn/v1',
    protocol: 'openai-compatible', enabled: true, supported_types: ['image', 'video'],
    capacity_model: 'limited', api_key: LEGACY_KEY, created_at: 'x', updated_at: 'y',
  }];
  const apiKeys = [
    { id: 'k1', provider_id: 'p1', api_key: POOL_KEY, label: 'agnes-1', status: 'active', weight: 100, rpm: 60, concurrency: 4, health: 'HEALTHY', cooldown_until: null, last_used_at: null, last_error_code: null, created_at: 'x', updated_at: 'y' },
    { id: 'k2', provider_id: 'p1', api_key: 'sk-disabled-XXXX', label: 'old', status: 'disabled', weight: 0, rpm: null, concurrency: null, health: 'UNKNOWN', cooldown_until: null, last_used_at: null, last_error_code: null, created_at: 'x', updated_at: 'y' },
  ];
  const models = [{
    id: 'm1', model_id: 'kling-x', display_name: 'Kling X', type: 'video', enabled: true,
    ai_capabilities: { type: 'text_to_video', capabilities: { text_to_video: true, image_to_video: true } },
    ai_parameter_schemas: { prompt: { type: 'string', required: true }, duration: { type: 'integer', min: 1, max: 18 } },
    capability_version: 2, credit_cost: 120,
    provider_id: 'p1', endpoint: { generate: { path: '/videos' } }, param_template: { fps: 24 },
  }];
  const bindings = [
    { id: 'b1', model_id: 'kling-x', provider_id: 'p1', upstream_model_name: 'agnes-kling-x', enabled: true, priority: 5, weight: 80, endpoint: { generate: { path: '/videos' } }, param_template: { fps: 24 }, base_url: 'https://api.agnes-ai.cn/v1', p_enabled: true },
  ];

  return {
    async query(sql, params = []) {
      const T = sql.toUpperCase();
      if (T.includes('FROM PROVIDERS') && T.includes('ORDER BY')) return { rows: providers };
      if (T.startsWith('SELECT * FROM PROVIDERS WHERE ID=')) return { rows: params[0] === 'p1' ? providers : [] };
      if (T.includes('FROM API_KEYS WHERE PROVIDER_ID=ANY')) return { rows: apiKeys };
      if (T.includes('SELECT * FROM MODELS WHERE MODEL_ID=$1')) return { rows: models.filter((m) => m.model_id === params[0]) };
      if (T.includes('FROM PROVIDER_MODEL_BINDINGS B') && T.includes('WHERE B.MODEL_ID=ANY($1)')) return { rows: bindings };
      if (T.startsWith('SELECT * FROM MODELS WHERE ENABLED')) return { rows: models };
      if (T.includes('FROM PROVIDER_MODEL_BINDINGS B') && T.includes('WHERE B.MODEL_ID=$1')) return { rows: bindings };
      if (T.startsWith('SELECT ID, NAME, BASE_URL, ENABLED FROM PROVIDERS')) return { rows: providers };
      return { rows: [] };
    },
  };
}

test('service: listProvidersForAdmin masks keys, exposes pool counts', async () => {
  const pg = fakePg();
  const list = await svc.listProvidersForAdmin(pg);
  assert.equal(list.length, 1);
  const p = list[0];
  const s = JSON.stringify(p);
  assert.ok(!s.includes(POOL_KEY), 'full pool secret must not appear');
  assert.ok(!s.includes('sk-disabled-XXXX'), 'disabled secret must not appear');
  assert.ok(!s.includes(LEGACY_KEY), 'legacy secret must not appear');
  assert.equal(p.key_pool_count, 2);
  assert.equal(p.active_key_count, 1);
  assert.equal(p.credential.has_legacy_key, true);
  assert.ok(p.credential.masked_legacy_key.includes('BBBB'), 'legacy masked shows last4');
  assert.ok(p.key_pool.every((k) => !JSON.stringify(k).includes(POOL_KEY)));
});

test('service: listModelsForUser — user sees bindings but NOT admin route params', async () => {
  const pg = fakePg();
  const userView = await svc.listModelsForUser(pg, { role: 'user' });
  const m = userView.find((x) => x.model_id === 'kling-x');
  assert.ok(m, 'logical model present');
  assert.equal(m.bindings.length, 1);
  assert.equal(m.capability_version, 2);
  const b = m.bindings[0];
  assert.equal(b.provider_id, 'p1');
  assert.ok(!('parameter_overrides' in b), 'user must not see binding param template');
  assert.ok(!('endpoint' in b), 'user must not see endpoint');
  assert.ok(!JSON.stringify(m).includes(POOL_KEY));
});

test('service: getModelForUser — admin gets route params, user does not', async () => {
  const pg = fakePg();
  const adminView = await svc.getModelForUser(pg, 'kling-x', { role: 'admin' });
  assert.ok(adminView.bindings[0].parameter_overrides, 'admin sees parameter_overrides');
  assert.ok(adminView.bindings[0].endpoint, 'admin sees endpoint');
  const userView = await svc.getModelForUser(pg, 'kling-x', { role: 'user' });
  assert.ok(!userView.bindings[0].parameter_overrides, 'user must not see parameter_overrides');
});

test('service: quoteForViewer strips cost for non-admin', () => {
  const q = { providerCost: 0.32, platformPrice: 120, currency: 'credits', pricingRuleId: 'mp-1', pricingSource: 'model_pricing' };
  const admin = svc.quoteForViewer({ role: 'admin' }, q);
  assert.equal(admin.estimated_provider_cost, 0.32);
  assert.ok('margin' in admin);
  const user = svc.quoteForViewer({ role: 'user' }, q);
  assert.ok(!('estimated_provider_cost' in user), 'no provider cost for user');
  assert.ok(!('margin' in user), 'no margin for user');
  assert.equal(user.estimated_credits, 120);
});

test('service: listCapabilities returns machine-readable registry', async () => {
  const pg = fakePg();
  const caps = await svc.listCapabilities(pg);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].model_id, 'kling-x');
  assert.equal(caps[0].type, 'text_to_video');
  assert.equal(caps[0].capabilities.image_to_video, true);
  assert.ok(caps[0].parameter_schema.duration);
});

test('service: recordRouting persists + returns auditable decision (no secret)', async () => {
  const pg = fakePg();
  let inserted = null;
  const orig = pg.query.bind(pg);
  pg.query = async (sql, params) => {
    if (/INSERT INTO AI_ROUTING_DECISIONS/i.test(sql)) { inserted = params; return { rows: [{ id: params[0] }] }; }
    return orig(sql, params);
  };
  const d = await svc.recordRouting(pg, {
    chosen: { bindingId: 'b1', modelId: 'kling-x', providerId: 'p1', score: 0.8, reasons: ['x'] },
    ranking: [{ bindingId: 'b1', modelId: 'kling-x', providerId: 'p1', score: 0.8 }],
    rejected: [], weights: {}, seed: 1,
  }, { model_id: 'kling-x', capability: 'video' }, { requestId: 'req-1' });
  assert.ok(d.routing_decision_id.startsWith('rd-'));
  assert.equal(d.selected.providerId, 'p1');
  assert.ok(inserted, 'decision row was inserted');
  assert.ok(!JSON.stringify(inserted).includes('sk-'), 'no secret in persisted decision');
});

test('repo: upsertModelCapability validates before write', async () => {
  const pg = fakePg();
  await assert.rejects(
    () => repo.upsertModelCapability(pg, 'kling-x', { type: 'teleport' }),
    /capability 校验失败/,
    'invalid capability must be rejected before any DB write'
  );
});
