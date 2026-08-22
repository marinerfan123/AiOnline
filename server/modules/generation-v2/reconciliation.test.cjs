'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTestPool, initTestSchema, truncateAll, closeTestPool, assertSafeTestDatabase
} = require('../../tests/helpers/test-db.cjs');
const { resolveReconcilingItem } = require('./reconciler.cjs');
const {
  queryProviderStatus, loadProviderById, loadModelById, resolveProviderType, sanitizeErrorMessage
} = require('./provider-status-router.cjs');

let pg;
test.before(async () => {
  assertSafeTestDatabase(process.env.TEST_PG_DATABASE || 'moling_test');
  pg = createTestPool();
  await initTestSchema(pg);
});

test.after(async () => {
  await closeTestPool(pg);
});

test.beforeEach(async () => {
  await truncateAll(pg);
});

// ─── Helpers (match actual DB schema from server.js) ───
// providers: (id PK, name, base_url, protocol, api_key, enabled BOOL, default_endpoint JSONB)
// models: (id PK, model_id NOT NULL, display_name, provider_id FK, enabled BOOL, endpoint JSONB)
async function insertVideoProvider(providerId, modelId, baseUrl) {
  await pg.query(
    `INSERT INTO providers (id, name, base_url, protocol, api_key, enabled)
     VALUES ($1, 'test-video-provider', $2, 'openai-compatible', 'sk-test-fake-only', TRUE)`,
    [providerId, baseUrl]
  );
  await pg.query(
    `INSERT INTO models (id, model_id, display_name, provider_id, enabled)
     VALUES ($1, $1, 'Test Video Model', $2, TRUE)`,
    [modelId, providerId]
  );
  return { providerId, modelId };
}

async function insertImageProvider(providerId, modelId) {
  await pg.query(
    `INSERT INTO providers (id, name, base_url, protocol, api_key, enabled)
     VALUES ($1, 'test-image-provider', 'https://api.openai.com/v1', 'openai-compatible', 'sk-test-fake-only', TRUE)`,
    [providerId]
  );
  await pg.query(
    `INSERT INTO models (id, model_id, display_name, provider_id, enabled)
     VALUES ($1, $1, 'Test Image Model', $2, TRUE)`,
    [modelId, providerId]
  );
  return { providerId, modelId };
}

async function insertReconcilingItem(batchId, itemId, providerRequestId, providerId) {
  const modelId = batchId.replace('b-', 'm-');
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count,
      request_payload, content_type, unit_price, reserved_total, status, idempotency_key)
     VALUES ($1, 'u-r', $2, 1, '{}', 'video', 100, 100, 'running', $1)`,
    [batchId, modelId]
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode,
      provider_request_id, provider_id, lease_version)
     VALUES ($1, $2, 0, 'reconciling', 'real', $3, $4, 1)`,
    [itemId, batchId, providerRequestId, providerId]
  );
}

// ─── R1: providerRequestId SUCCESS → generated ───

test('R1: reconciler resolves video SUCCESS via injected adapter → generated', async () => {
  const { providerId, modelId } = await insertVideoProvider('p-r1', 'm-r1', 'https://api.agnes-ai.cn/v1');
  const batchId = `b-r1-${Date.now()}`;
  const itemId = `i-r1-${Date.now()}`;
  await insertReconcilingItem(batchId, itemId, 'agnes-task-123', providerId);

  const result = await resolveReconcilingItem(pg, {
    item_id: itemId, lease_version: 1, provider_request_id: 'agnes-task-123',
    provider_id: providerId, model_id: modelId,
  }, {
    transitionItem: async (_, action) => ({ status: action.to }),
    queryProviderStatus: async () => ({
      status: 'success', providerUrl: 'https://cdn.fake/video.mp4'
    }),
  });

  assert.equal(result.status, 'generated');
});

// ─── R2: PENDING → retry_wait (recoverable) ───

test('R2: reconciler resolves PENDING → retry_wait', async () => {
  const result = await resolveReconcilingItem(pg, {
    item_id: 'i-r2', lease_version: 1, provider_request_id: 'pr-r2',
  }, {
    transitionItem: async (_, action) => ({ status: action.to }),
    queryProviderStatus: async () => ({ status: 'pending', errorCode: 'STILL_PROCESSING' }),
  });
  assert.equal(result.status, 'retry_wait');
});

// ─── R3: FAILED → retry_wait (terminal failure path) ───

test('R3: reconciler resolves FAILED → retry_wait with error', async () => {
  const result = await resolveReconcilingItem(pg, {
    item_id: 'i-r3', lease_version: 1, provider_request_id: 'pr-r3',
  }, {
    transitionItem: async (_, action) => ({ status: action.to, patch: action.patch }),
    queryProviderStatus: async () => ({ status: 'failed', error: 'provider failed', errorCode: 'PROVIDER_FAILED' }),
  });
  assert.equal(result.status, 'retry_wait');
});

// ─── R4: NOT_FOUND → review_required (NO blind resubmit) ───

test('R4: reconciler resolves NOT_FOUND → review_required (no resubmit)', async () => {
  const result = await resolveReconcilingItem(pg, {
    item_id: 'i-r4', lease_version: 1, provider_request_id: 'pr-r4',
  }, {
    transitionItem: async (_, action) => ({ status: action.to }),
    queryProviderStatus: async () => ({ status: 'not_found', errorCode: 'NOT_FOUND' }),
  });
  assert.equal(result.status, 'review_required');
});

// ─── R5: UNKNOWN → review_required (NO blind resubmit) ───

test('R5: reconciler resolves UNKNOWN → review_required (no resubmit)', async () => {
  const result = await resolveReconcilingItem(pg, {
    item_id: 'i-r5', lease_version: 1, provider_request_id: 'pr-r5',
  }, {
    transitionItem: async (_, action) => ({ status: action.to }),
    queryProviderStatus: async () => ({ status: 'unknown', error: 'ambiguous response' }),
  });
  assert.equal(result.status, 'review_required');
});

// ─── R6: network timeout → safe bounded reconciliation ───

test('R6: network exception in queryProviderStatus → review_required', async () => {
  const result = await resolveReconcilingItem(pg, {
    item_id: 'i-r6', lease_version: 1, provider_request_id: 'pr-r6',
  }, {
    transitionItem: async (_, action) => ({ status: action.to }),
    queryProviderStatus: async () => { throw new Error('ETIMEDOUT'); },
  });
  assert.equal(result.status, 'review_required');
});

// ─── R7: malformed provider response → UNKNOWN → review_required ───

test('R7: malformed response returns unknown → review_required', async () => {
  const result = await resolveReconcilingItem(pg, {
    item_id: 'i-r7', lease_version: 1, provider_request_id: 'pr-r7',
  }, {
    transitionItem: async (_, action) => ({ status: action.to }),
    queryProviderStatus: async () => ({ status: 'unknown', errorCode: 'MALFORMED_RESPONSE', error: 'unparseable JSON' }),
  });
  assert.equal(result.status, 'review_required');
});

// ─── R8: missing providerRequestId + clientRequestId unsupported → review_required ───

test('R8: missing providerRequestId → unknown (clientRequestId not used for provider lookup)', async () => {
  const { providerId, modelId } = await insertImageProvider('p-r8', 'm-r8');

  const result = await queryProviderStatus(pg, {
    providerId, modelId,
    providerRequestId: null,
    clientRequestId: 'client-123',
    content_type: 'image',
  });

  assert.equal(result.status, 'unknown');
  assert.ok(result.errorCode, 'should have error code for missing providerRequestId');
});

// ─── R9: missing providerRequestId on unsupported provider → unknown ───

test('R9: missing providerRequestId on unsupported provider → unknown', async () => {
  const { providerId, modelId } = await insertImageProvider('p-r9', 'm-r9');

  const result = await queryProviderStatus(pg, {
    providerId, modelId,
    providerRequestId: null,
    content_type: 'image',
  });

  assert.equal(result.status, 'unknown');
});

// ─── R10: duplicate reconciliation → idempotent state transition ───

test('R10: duplicate reconciliation is idempotent (CAS lease_version)', async () => {
  let transitions = [];
  const fakeTransition = async (_, action) => {
    transitions.push(action);
    // CAS: only first call succeeds
    return transitions.length === 1 ? { status: action.to } : null;
  };

  const r1 = await resolveReconcilingItem(pg, {
    item_id: 'i-r10', lease_version: 1, provider_request_id: 'pr-r10',
  }, {
    transitionItem: fakeTransition,
    queryProviderStatus: async () => ({ status: 'success', providerUrl: 'https://cdn.fake/video.mp4' }),
  });
  assert.equal(r1.status, 'generated');

  const r2 = await resolveReconcilingItem(pg, {
    item_id: 'i-r10', lease_version: 1, provider_request_id: 'pr-r10',
  }, {
    transitionItem: fakeTransition,
    queryProviderStatus: async () => ({ status: 'success', providerUrl: 'https://cdn.fake/video.mp4' }),
  });
  assert.equal(r2.status, 'stale_lease', 'duplicate should get stale_lease from CAS failure');
  assert.equal(transitions.length, 2, 'should have attempted 2 transitions');
});

// ─── R11: success response processed twice → no duplicate upload ───

test('R11: two successive success reconciliations → only first succeeds', async () => {
  let callCount = 0;
  const fakeTransition = async (_, action) => {
    callCount++;
    // First call succeeds, subsequent get CAS failure
    return callCount === 1 ? { status: action.to } : null;
  };

  const r1 = await resolveReconcilingItem(pg, {
    item_id: 'i-r11', lease_version: 1, provider_request_id: 'pr-r11',
  }, {
    transitionItem: fakeTransition,
    queryProviderStatus: async () => ({ status: 'success', providerUrl: 'u' }),
  });
  assert.equal(r1.status, 'generated');

  // Reset for second call — simulate stale_lease scenario
  const r2 = await resolveReconcilingItem(pg, {
    item_id: 'i-r11', lease_version: 1, provider_request_id: 'pr-r11',
  }, {
    transitionItem: fakeTransition,
    queryProviderStatus: async () => ({ status: 'success', providerUrl: 'u' }),
  });
  assert.equal(r2.status, 'stale_lease', 'second call should fail CAS');
});

// ─── R12: failed response processed twice → no duplicate release ───

test('R12: two successive failed reconciliations → only first transitions', async () => {
  let callCount = 0;
  const fakeTransition = async (_, action) => {
    callCount++;
    return callCount === 1 ? { status: action.to } : null;
  };

  const r1 = await resolveReconcilingItem(pg, {
    item_id: 'i-r12', lease_version: 1, provider_request_id: 'pr-r12',
  }, {
    transitionItem: fakeTransition,
    queryProviderStatus: async () => ({ status: 'failed', error: 'failed' }),
  });
  assert.equal(r1.status, 'retry_wait');

  const r2 = await resolveReconcilingItem(pg, {
    item_id: 'i-r12', lease_version: 1, provider_request_id: 'pr-r12',
  }, {
    transitionItem: fakeTransition,
    queryProviderStatus: async () => ({ status: 'failed', error: 'failed' }),
  });
  assert.equal(r2.status, 'stale_lease', 'second should get stale_lease');
});

// ─── Provider type resolution ───

test('resolveProviderType: agnes → video-agnes', () => {
  const t = resolveProviderType({ base_url: 'https://api.agnes-ai.cn/v1' });
  assert.equal(t, 'video-agnes');
});

test('resolveProviderType: minimax → video-minimax', () => {
  const t = resolveProviderType({ base_url: 'https://api.minimaxi.com/v2' });
  assert.equal(t, 'video-minimax');
});

test('resolveProviderType: volcano → video-volcano', () => {
  const t = resolveProviderType({ base_url: 'https://ark.cn-beijing.volces.com/api/v3' });
  assert.equal(t, 'video-volcano');
});

test('resolveProviderType: openai-compatible → image-sync', () => {
  const t = resolveProviderType({ base_url: 'https://api.openai.com/v1', protocol: 'openai-compatible' });
  assert.equal(t, 'image-sync');
});

test('resolveProviderType: explicit videoAdapter → video-agnes', () => {
  const t = resolveProviderType({
    base_url: 'https://custom.example.com',
    default_endpoint: { videoAdapter: 'agnes' },
  });
  assert.equal(t, 'video-agnes');
});

// ─── sanitizeErrorMessage ───

test('sanitizeErrorMessage: redacts Bearer tokens', () => {
  const out = sanitizeErrorMessage('Auth failed: Bearer sk-abc123xyz');
  assert.ok(!out.includes('sk-abc123xyz'));
  assert.ok(out.includes('REDACTED'));
});

test('sanitizeErrorMessage: redacts API keys', () => {
  const out = sanitizeErrorMessage('api_key=sk-prod-key-12345');
  assert.ok(!out.includes('sk-prod-key-12345'));
  assert.ok(out.includes('REDACTED'));
});

test('sanitizeErrorMessage: truncates long messages', () => {
  const long = 'x'.repeat(500);
  const out = sanitizeErrorMessage(long);
  assert.ok(out.length <= 200);
});

// ─── Provider config loading ───

test('loadProviderById: returns provider from DB', async () => {
  await pg.query(
    `INSERT INTO providers (id, name, base_url, protocol, api_key, enabled)
     VALUES ('p-load', 'load-test', 'https://test.example.com', 'openai-compatible', 'sk-test', TRUE)`,
  );
  const p = await loadProviderById(pg, 'p-load');
  assert.ok(p);
  assert.equal(p.id, 'p-load');
  assert.equal(p.base_url, 'https://test.example.com');
  assert.equal(p.enabled, true);
});

test('loadProviderById: returns null for missing', async () => {
  const p = await loadProviderById(pg, 'nonexistent');
  assert.equal(p, null);
});

test('loadModelById: returns model from DB', async () => {
  await pg.query(
    `INSERT INTO providers (id, name, base_url, protocol, api_key, enabled)
     VALUES ('p-model', 'mp', 'https://test.example.com', 'openai-compatible', 'sk-test', TRUE)`,
  );
  await pg.query(
    `INSERT INTO models (id, model_id, display_name, provider_id, enabled)
     VALUES ('m-load', 'm-load', 'Load Test', 'p-model', TRUE)`,
  );
  const m = await loadModelById(pg, 'm-load');
  assert.ok(m);
  assert.equal(m.model_id, 'm-load');
});

test('queryProviderStatus: sync image provider returns unknown with SYNC_PROVIDER_NO_QUERY', async () => {
  const { providerId, modelId } = await insertImageProvider('p-rsync', 'm-rsync');
  const r = await queryProviderStatus(pg, {
    providerId, modelId, providerRequestId: 'pr-123', content_type: 'image',
  });
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'SYNC_PROVIDER_NO_QUERY');
});

test('queryProviderStatus: missing providerRequestId returns unknown', async () => {
  const r = await queryProviderStatus(pg, {
    providerId: 'p-any', modelId: 'm-any', providerRequestId: null, content_type: 'video',
  });
  assert.equal(r.status, 'unknown');
  assert.ok(r.errorCode);
});

test('queryProviderStatus: disabled provider returns unknown', async () => {
  await pg.query(
    `INSERT INTO providers (id, name, base_url, protocol, api_key, enabled)
     VALUES ('p-disabled', 'disabled', 'https://api.agnes-ai.cn/v1', 'openai-compatible', 'sk-test', FALSE)`,
  );
  await pg.query(
    `INSERT INTO models (id, model_id, display_name, provider_id, enabled)
     VALUES ('m-disabled', 'm-disabled', 'Disabled', 'p-disabled', TRUE)`,
  );
  const r = await queryProviderStatus(pg, {
    providerId: 'p-disabled', modelId: 'm-disabled',
    providerRequestId: 'pr-456', content_type: 'video',
  });
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'PROVIDER_DISABLED');
});
