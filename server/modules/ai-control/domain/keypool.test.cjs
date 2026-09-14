'use strict';
/**
 * M02-A — Key Pool Domain: masking + NO-SECRET guarantees.
 * The most security-critical tests: full api_key must NEVER appear in any
 * metadata projection or redacted output.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const keypool = require('./keypool.cjs');

const SECRET = 'sk-super-secret-abcdef-9876543210';

test('keypool: maskKey shows only last 4, never full secret', () => {
  const m = keypool.maskKey(SECRET);
  assert.ok(m.includes('3210'), 'shows last 4');
  assert.ok(!m.includes(SECRET), 'does not leak full secret');
  assert.ok(!m.includes('super-secret'), 'does not leak middle');
  assert.equal(keypool.maskKey(''), '');
  assert.equal(keypool.maskKey(null), '');
});

test('keypool: keyMetadata never contains the secret', () => {
  const meta = keypool.keyMetadata({
    id: 'k-1', provider_id: 'p1', api_key: SECRET,
    label: 'agnes prod', status: 'active', weight: 50,
    rpm: 60, concurrency: 4, health: 'HEALTHY',
    cooldown_until: 1234, last_used_at: '2026-08-27T00:00:00Z', last_error_code: null,
    created_at: '2026-08-01T00:00:00Z', updated_at: null,
  });
  const serialized = JSON.stringify(meta);
  assert.ok(!serialized.includes(SECRET), 'secret must not appear in metadata JSON');
  assert.equal(meta.enabled, true);
  assert.equal(meta.weight, 50);
  assert.equal(meta.health, 'HEALTHY');
  assert.ok(meta.masked.includes('3210'));
  assert.equal(typeof meta.fingerprint, 'string');
  assert.ok(meta.fingerprint.length === 12, 'fingerprint is 12 hex chars');
});

test('keypool: fingerprint is stable + non-reversible + distinct', () => {
  const f1 = keypool.fingerprint(SECRET);
  const f2 = keypool.fingerprint(SECRET);
  assert.equal(f1, f2, 'stable for same secret');
  assert.ok(f1 !== SECRET && f1.length < SECRET.length, 'not the secret');
  assert.notEqual(keypool.fingerprint('other'), f1, 'distinct for different secrets');
});

test('keypool: disabled key reflects enabled=false', () => {
  const meta = keypool.keyMetadata({ id: 'k-2', provider_id: 'p1', api_key: 'x'.repeat(20), status: 'disabled' });
  assert.equal(meta.enabled, false);
});

test('keypool: keyMetadataList maps + drops nulls', () => {
  const list = keypool.keyMetadataList([
    { id: 'k-1', provider_id: 'p', api_key: 'a'.repeat(10), status: 'active' },
    null,
  ]);
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes('aaaaaaaaaa'));
});

test('keypool: redactCredentialFields scrubs nested secrets', () => {
  const obj = {
    name: 'p1',
    api_key: SECRET,
    nested: { apiKey: SECRET, provider: { api_key: SECRET, ok: 1 } },
    list: [{ token: 'tok-1234567890' }],
  };
  const redacted = keypool.redactCredentialFields(obj);
  const s = JSON.stringify(redacted);
  assert.ok(!s.includes(SECRET), 'full secret removed everywhere');
  assert.ok(!s.includes('tok-1234567890'), 'token removed');
  assert.equal(redacted.nested.provider.ok, 1, 'non-secret fields preserved');
  assert.ok(redacted.api_key.includes('3210'), 'masked, not raw');
});
