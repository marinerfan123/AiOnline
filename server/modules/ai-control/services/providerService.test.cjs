'use strict';
/**
 * M02-B — providerService unit tests (no real DB).
 * Covers: credential-source classification (POOL / LEGACY_FALLBACK / NONE),
 * placeholder-secret handling, and key-pool masking (full secret never
 * escapes any read projection). Uses a fake pg.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('./providerService.cjs');

// ── classifyCredentialSource (B5) ──
test('classify: empty pool + no legacy → NONE', () => {
  const r = svc.classifyCredentialSource({ key_pool: [], credential: { has_legacy_key: false } });
  assert.equal(r.source, 'NONE');
  assert.equal(r.pool_count, 0);
  assert.equal(r.eligible_count, 0);
});

test('classify: legacy key present, empty pool → LEGACY_FALLBACK', () => {
  const r = svc.classifyCredentialSource({ key_pool: [], credential: { has_legacy_key: true } });
  assert.equal(r.source, 'LEGACY_FALLBACK');
  assert.equal(r.has_legacy_key, true);
});

test('classify: active pool key present → POOL (preferred over legacy)', () => {
  const r = svc.classifyCredentialSource({
    key_pool: [{ enabled: true }, { enabled: false }],
    credential: { has_legacy_key: true },
  });
  assert.equal(r.source, 'POOL');
  assert.equal(r.pool_count, 2);
  assert.equal(r.eligible_count, 1);
});

test('classify: only disabled pool keys + legacy → LEGACY_FALLBACK', () => {
  const r = svc.classifyCredentialSource({
    key_pool: [{ enabled: false }],
    credential: { has_legacy_key: true },
  });
  assert.equal(r.source, 'LEGACY_FALLBACK');
});

test('classify: only disabled pool keys, no legacy → NONE', () => {
  const r = svc.classifyCredentialSource({
    key_pool: [{ enabled: false }],
    credential: { has_legacy_key: false },
  });
  assert.equal(r.source, 'NONE');
});

// ── placeholder secret handling (B3 / legacy parity) ──
test('isPlaceholderSecret: empty/short/star → true', () => {
  assert.equal(svc.isPlaceholderSecret(''), true);
  assert.equal(svc.isPlaceholderSecret('***'), true);
  assert.equal(svc.isPlaceholderSecret('***1234'), true);
  assert.equal(svc.isPlaceholderSecret('abc'), true);
});

test('isPlaceholderSecret: real long key → false', () => {
  assert.equal(svc.isPlaceholderSecret('sk-testfake-key-000000'), false);
});

// ── key-pool masking (B3) ──
test('getProviderView masks legacy + pool keys, no full secret in output', async () => {
  const secret = 'sk-topsecret99999';
  const poolSecret = 'sk-poolkey888888';
  const pg2 = {
    async query(sql) {
      const S = sql.toUpperCase();
      if (S.includes('FROM PROVIDERS WHERE ID=$1')) return { rows: [{ id: 'p1', name: 'P1', api_key: secret, enabled: true, revision: 1, base_url: '', protocol: 'x' }] };
      if (S.includes('FROM API_KEYS WHERE PROVIDER_ID=$1 ORDER BY CREATED_AT')) return { rows: [{ id: 'k1', provider_id: 'p1', api_key: poolSecret, label: 'x', status: 'active', weight: 100 }] };
      if (S.includes('FROM PROVIDER_MODEL_BINDINGS')) return { rows: [] };
      if (S.includes('FROM MODELS WHERE PROVIDER_ID=$1')) return { rows: [] };
      return { rows: [] };
    },
  };
  const v = await svc.getProviderView(pg2, 'p1');
  assert.ok(v, 'provider view returned');
  assert.equal(v.credential.has_legacy_key, true);
  assert.ok(v.credential.masked_legacy_key.endsWith('9999'), 'legacy masked last4');
  assert.equal(v.key_pool[0].masked.endsWith('8888'), true, 'pool key masked last4');
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes(secret), 'no full legacy secret');
  assert.ok(!raw.includes(poolSecret), 'no full pool secret');
});
