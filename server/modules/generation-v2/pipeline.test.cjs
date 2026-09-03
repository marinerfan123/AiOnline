'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildIntake, intakeDedup } = require('./intakeRecord.cjs');
const { transition, claimLease } = require('./jobLifecycle.cjs');
const { sanitizeAttempt } = require('./attemptRecord.cjs');
const { processResult, finalizeDedup } = require('./resultFinalize.cjs');

test('W4-02 intake: stores scope/versions/ids + deterministic idempotency key', () => {
  const r = buildIntake({ shotId: 's1', projectId: 'p1', workspaceId: 'w1', ir: { ir_version: 1 }, compiled: { version: 1, deterministicHash: 'h' }, route: { id: 'amper' }, quote: { quoteId: 'q1' }, reserve: { reserveId: 'r1' }, userId: 'u1' });
  assert.equal(r.ok, true);
  assert.equal(r.record.shotId, 's1');
  assert.equal(r.record.compilerHash, 'h');
  assert.equal(r.record.idempotencyKey, 'intake:p1:s1:u1');
});

test('W4-02 duplicate intake dedup', () => {
  const rec = { idempotencyKey: 'intake:p1:s1:u1' };
  assert.equal(intakeDedup(rec, 'intake:p1:s1:u1').ok, false);
  assert.equal(intakeDedup(rec, 'different').ok, true);
});

test('W4-03 job: valid transitions only (replay-safe)', () => {
  assert.equal(transition({ status: 'queued' }, 'claimed').ok, true);
  assert.equal(transition({ status: 'queued' }, 'done').ok, false); // invalid
  assert.equal(transition({ status: 'running' }, 'done').ok, true);
});

test('W4-03 lease-aware claim', () => {
  assert.equal(claimLease({ status: 'queued', actor: 'w1' }).ok, true);
  const held = claimLease({ status: 'queued', leaseOwner: 'w2', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), actor: 'w1' });
  assert.equal(held.ok, false); // lease held by other
  assert.equal(claimLease({ status: 'done', actor: 'w1' }).ok, false); // terminal
});

test('W4-04 attempt: strips secrets, records fingerprint/status/errorClass', () => {
  const a = sanitizeAttempt({ provider: 'amper', model: 'genny', request: { prompt: 'p', apiKey: 'SECRET' }, status: 'failed', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z', error: { code: 'ECONNRESET' } });
  assert.equal(a.requestFingerprint.includes('SECRET'), false);
  assert.equal(Object.keys(a).some((k) => /apiKey/i.test(k)), false);
  assert.equal(a.errorClass, 'transient');
  assert.equal(a.retryable, true);
});

test('W4-05 result: deterministic versionId by callbackId (idempotent dedup)', () => {
  const r1 = processResult({ callbackId: 'cb1', provider: 'amper', model: 'm', generationId: 'g1', shotId: 's1', result: { mediaId: 'm1' } });
  const r2 = processResult({ callbackId: 'cb1', provider: 'amper' });
  assert.equal(r1.versionId, r2.versionId, 'same callback -> same version');
  assert.equal(finalizeDedup(r1.versionId, [r1.versionId]), true, 'duplicate callback detected');
  assert.equal(r1.assetVersion.kind, 'generated');
});
