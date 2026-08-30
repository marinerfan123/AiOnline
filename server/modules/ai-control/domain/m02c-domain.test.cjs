'use strict';
/**
 * M02-C — Domain tests for revision, grant, routing-policy.
 * Pure functions, no DB. Run: node --test server/modules/ai-control/domain/*.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRevision, computeContentHash, toRevision } = require('./revision.cjs');
const { validateGrant, hasCapability, resolveEffectiveCapabilities } = require('./grant.cjs');
const { validatePolicy, resolveRouting } = require('./routing-policy.cjs');

// ── Revision tests ────────────────────────────────────────────────────────────

test('revision: valid doc passes', () => {
  const r = validateRevision({
    model_id: 'm1',
    revision: 1,
    manifest: { type: 'text_to_image', capabilities: { text_to_image: true } },
    published_by: 'admin-1',
  });
  assert.equal(r.ok, true);
});

test('revision: missing model_id rejected', () => {
  const r = validateRevision({ manifest: {} });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('model_id')));
});

test('revision: invalid revision number rejected', () => {
  const r = validateRevision({ model_id: 'm1', revision: 0, manifest: {} });
  assert.equal(r.ok, false);
});

test('revision: manifest must be object', () => {
  const r = validateRevision({ model_id: 'm1', revision: 1, manifest: 'string' });
  assert.equal(r.ok, false);
});

test('revision: content_hash is deterministic SHA-256', () => {
  const manifest = { type: 'text', capabilities: { text: true } };
  const h1 = computeContentHash(manifest);
  const h2 = computeContentHash(manifest);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64); // SHA-256 hex length
  const different = computeContentHash({ type: 'text' });
  assert.notEqual(h1, different);
});

test('revision: toRevision projects correctly', () => {
  const row = {
    id: 'mr-1', model_id: 'm1', revision: 1, content_hash: 'abc',
    manifest: { type: 'text' }, status: 'active', supersedes: null,
    published_by: 'u1', published_at: '2024-01-01T00:00:00Z', retired_at: null,
  };
  const rev = toRevision(row);
  assert.equal(rev.id, 'mr-1');
  assert.equal(rev.model_id, 'm1');
  assert.equal(rev.status, 'active');
});

// ── Grant tests ───────────────────────────────────────────────────────────────

test('grant: valid grant passes', () => {
  const r = validateGrant({ model_id: 'm1', user_id: 'u1' });
  assert.equal(r.ok, true);
  const r2 = validateGrant({ model_id: 'm1', workspace_id: 'w1' });
  assert.equal(r2.ok, true);
});

test('grant: missing model_id rejected', () => {
  const r = validateGrant({ user_id: 'u1' });
  assert.equal(r.ok, false);
});

test('grant: neither user nor workspace rejected', () => {
  const r = validateGrant({ model_id: 'm1' });
  assert.equal(r.ok, false);
});

test('grant: both user and workspace rejected', () => {
  const r = validateGrant({ model_id: 'm1', user_id: 'u1', workspace_id: 'w1' });
  assert.equal(r.ok, false);
});

test('grant: hasCapability returns true when no grants (OPEN)', () => {
  assert.equal(hasCapability([], { userId: 'u1' }), true);
  assert.equal(hasCapability([], { workspaceId: 'w1' }), true);
});

test('grant: hasCapability returns true for matching granted user', () => {
  const grants = [{ id: 'g1', user_id: 'u1', model_id: 'm1', status: 'granted', expires_at: null }];
  assert.equal(hasCapability(grants, { userId: 'u1' }), true);
  assert.equal(hasCapability(grants, { userId: 'u2' }), false);
});

test('grant: hasCapability returns true for matching granted workspace', () => {
  const grants = [{ id: 'g1', workspace_id: 'w1', model_id: 'm1', status: 'granted', expires_at: null }];
  assert.equal(hasCapability(grants, { workspaceId: 'w1' }), true);
  assert.equal(hasCapability(grants, { workspaceId: 'w2' }), false);
});

test('grant: revoked grant denies access', () => {
  const grants = [{ id: 'g1', user_id: 'u1', model_id: 'm1', status: 'revoked', expires_at: null }];
  assert.equal(hasCapability(grants, { userId: 'u1' }), false);
});

test('grant: expired grant denies access', () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  const grants = [{ id: 'g1', user_id: 'u1', model_id: 'm1', status: 'granted', expires_at: past }];
  assert.equal(hasCapability(grants, { userId: 'u1' }), false);
});

test('grant: resolveEffectiveCapabilities returns all when no grants', () => {
  const caps = ['text', 'image', 'video'];
  const result = resolveEffectiveCapabilities(caps, []);
  assert.deepEqual(result, caps);
});

test('grant: resolveEffectiveCapabilities filters when grants exist', () => {
  const caps = ['text', 'image', 'video'];
  const grants = [
    { id: 'g1', user_id: 'u1', model_id: 'm1', capability: 'text', status: 'granted', expires_at: null },
    { id: 'g2', user_id: 'u1', model_id: 'm1', capability: '*', status: 'granted', expires_at: null },
  ];
  const result = resolveEffectiveCapabilities(caps, grants, { userId: 'u1' });
  // '*' grants everything
  assert.deepEqual(result.sort(), caps.sort());
});

// ── Routing Policy tests ──────────────────────────────────────────────────────

test('policy: valid policy passes', () => {
  const r = validatePolicy({ model_id: 'm1', target_binding_id: 'b1', percent: 50 });
  assert.equal(r.ok, true);
});

test('policy: missing model_id rejected', () => {
  const r = validatePolicy({ target_binding_id: 'b1' });
  assert.equal(r.ok, false);
});

test('policy: percent out of range rejected', () => {
  let r = validatePolicy({ model_id: 'm1', target_binding_id: 'b1', percent: -1 });
  assert.equal(r.ok, false);
  r = validatePolicy({ model_id: 'm1', target_binding_id: 'b1', percent: 101 });
  assert.equal(r.ok, false);
});

test('resolveRouting: no policies returns null', () => {
  const result = resolveRouting([], 'm1', 'text', 42);
  assert.equal(result, null);
});

test('resolveRouting: selects binding within percent', () => {
  const policies = [
    { id: 'p1', model_id: 'm1', capability: null, target_binding_id: 'b1', percent: 100, status: 'active' },
  ];
  const result = resolveRouting(policies, 'm1', 'text', 42);
  assert.equal(result.bindingId, 'b1');
  assert.equal(result.percent, 100);
});

test('resolveRouting: excludes paused policies', () => {
  const policies = [
    { id: 'p1', model_id: 'm1', capability: null, target_binding_id: 'b1', percent: 100, status: 'paused' },
  ];
  const result = resolveRouting(policies, 'm1', 'text', 42);
  assert.equal(result, null);
});

test('resolveRouting: matches specific capability', () => {
  const policies = [
    { id: 'p1', model_id: 'm1', capability: 'image', target_binding_id: 'b1', percent: 100, status: 'active' },
  ];
  assert.equal(resolveRouting(policies, 'm1', 'image', 42).bindingId, 'b1');
  assert.equal(resolveRouting(policies, 'm1', 'video', 42), null);
});
