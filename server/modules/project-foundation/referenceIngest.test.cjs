'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  INPUT_KINDS,
  ASSET_KINDS,
  REFERENCE_ONLY_KINDS,
  INGEST_MATRIX,
  normalizeIntent,
  computeIngestKey,
  ingestIds,
  planIngest,
  classifyIngestError,
  isRetryableIngestError,
  buildRetryPolicy,
} = require('./referenceIngest.cjs');
const { REFERENCE_TYPES, validateReference } = require('./reference.cjs');
const { validateAssetRights } = require('./assetRights.cjs');

const BASE = { projectId: 'proj-1', name: 'Lookbook' };

// ── Ingest matrix ───────────────────────────────────────────────────────────
test('input kind registry is complete and consistent', () => {
  assert.deepEqual(INPUT_KINDS, ['image', 'video', 'audio', 'file', 'url', 'text']);
  assert.deepEqual(ASSET_KINDS, ['image', 'video', 'audio', 'file', 'url']);
  assert.deepEqual(REFERENCE_ONLY_KINDS, ['text']);
  // Only 'text' is reference-only; everything else is advertised as asset-bearing.
  for (const k of INPUT_KINDS) {
    assert.ok(INGEST_MATRIX[k], `matrix entry missing for ${k}`);
  }
});

// image → asset+reference (IMAGE / style / uploaded)
test('ingest matrix: image upload produces IMAGE asset + style reference, rights origin uploaded', () => {
  const plan = planIngest({ ...BASE, kind: 'image', mimeType: 'image/png', sizeBytes: 1234, fileName: 'ref.png' });
  assert.equal(plan.ok, true);
  const p = plan.plan;
  assert.equal(p.kind, 'asset+reference');
  assert.equal(p.asset.assetType, 'IMAGE');
  assert.equal(p.asset.type, 'image');
  assert.equal(p.asset.origin, 'UPLOAD');
  assert.equal(p.asset.status, 'pending_upload'); // recoverable
  assert.equal(p.reference.type, 'style');
  assert.equal(p.reference.project_id, BASE.projectId);
  assert.equal(p.reference.source, 'upload');
  assert.equal(p.assetRights.origin, 'uploaded');
  assert.ok(p.assetRights.reference_assets.includes(p.reference.id));
  assert.equal(p.provenance.referenceId, p.reference.id);
  assert.equal(p.provenance.assetId, p.asset.id);
  // proven durable records pass their validators
  assert.equal(validateReference(p.reference).ok, true);
  assert.equal(validateAssetRights(p.assetRights).ok, true);
});

// url → asset+reference (IMAGE / style / imported)
test('ingest matrix: URL produces imported IMAGE asset + style reference', () => {
  const plan = planIngest({ ...BASE, kind: 'url', url: 'https://example.com/ref.jpg' });
  const p = plan.plan;
  assert.equal(p.kind, 'asset+reference');
  assert.equal(p.asset.origin, 'IMPORT');
  assert.equal(p.asset.status, 'ready');
  assert.equal(p.asset.source, 'url');
  assert.equal(p.assetRights.origin, 'imported');
  assert.equal(p.reference.type, 'style');
  assert.equal(p.reference.source, 'url');
  assert.equal(p.reference.source_id, p.asset.id); // durable link to the imported asset
  assert.equal(p.reference.attributes.url, 'https://example.com/ref.jpg');
  assert.equal(p.provenance.sourceUrl, 'https://example.com/ref.jpg');
});

// video / audio / file default reference types
test('ingest matrix: video/audio/file default reference types', () => {
  const video = planIngest({ ...BASE, kind: 'video', mimeType: 'video/mp4' });
  assert.equal(video.plan.asset.assetType, 'VIDEO');
  assert.equal(video.plan.reference.type, 'motion');

  const audio = planIngest({ ...BASE, kind: 'audio', mimeType: 'audio/mpeg' });
  assert.equal(audio.plan.asset.assetType, 'AUDIO');
  assert.equal(audio.plan.reference.type, 'audio');

  const file = planIngest({ ...BASE, kind: 'file', mimeType: 'application/pdf', fileName: 'notes.pdf' });
  assert.equal(file.plan.asset.assetType, 'OTHER');
  assert.equal(file.plan.reference.type, 'object');
});

// text → reference only
test('ingest matrix: text narrative produces a reference only (no asset)', () => {
  const plan = planIngest({ ...BASE, kind: 'text', text: 'grim sand-and-amber desert, low sun, dust haze', referenceType: 'environment' });
  const p = plan.plan;
  assert.equal(p.kind, 'reference');
  assert.equal(p.asset, null);
  assert.equal(p.assetRights, null);
  assert.equal(p.reference.type, 'environment');
  assert.equal(p.reference.source, 'narrative');
  assert.equal(p.reference.source_id, null);
  assert.equal(p.reference.attributes.narrative, 'grim sand-and-amber desert, low sun, dust haze');
});

// asReference URL → reference only
test('ingest matrix: url with asReference produces a reference only', () => {
  const plan = planIngest({ ...BASE, kind: 'url', url: 'https://example.com/look', asReference: true, referenceType: 'style' });
  assert.equal(plan.plan.kind, 'reference');
  assert.equal(plan.plan.asset, null);
  assert.equal(plan.plan.reference.source_id, 'https://example.com/look');
});

// skipReference on url → asset only
test('ingest matrix: url with skipReference produces asset only (no reference)', () => {
  const plan = planIngest({ ...BASE, kind: 'url', url: 'https://example.com/raw.jpg', skipReference: true });
  assert.equal(plan.plan.kind, 'asset');
  assert.equal(plan.plan.reference, null);
});

// referenceType override is honored and validated
test('referenceType override maps to the requested reference type', () => {
  const plan = planIngest({ ...BASE, kind: 'image', referenceType: 'character' });
  assert.equal(plan.plan.reference.type, 'character');
  const bad = planIngest({ ...BASE, kind: 'image', referenceType: 'vibe' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_INTENT');
});

// ── Unsupported / invalid input ─────────────────────────────────────────────
test('unsupported input kind fails explicitly (UNSUPPORTED_INPUT, not retryable)', () => {
  const plan = planIngest({ ...BASE, kind: 'gif', url: 'x' });
  assert.equal(plan.ok, false);
  assert.equal(plan.error.code, 'UNSUPPORTED_INPUT');
  assert.equal(plan.error.retryable, false);
  assert.match(plan.error.message, /Unsupported ingest input kind/);
});

test('invalid intents are rejected with INVALID_INTENT', () => {
  assert.equal(planIngest({ ...BASE, kind: 'text' }).error.code, 'INVALID_INTENT'); // missing text
  assert.equal(planIngest({ kind: 'image' }).error.code, 'INVALID_INTENT'); // missing projectId
  assert.equal(planIngest({ ...BASE, kind: 'url', url: 'ftp://x' }).error.code, 'INVALID_INTENT'); // bad protocol
  assert.equal(planIngest({ ...BASE, kind: 'url' }).error.code, 'INVALID_INTENT'); // missing url
  assert.equal(planIngest(null).error.code, 'INVALID_INTENT'); // null intent
});

// ── Idempotency / deterministic ids ────────────────────────────────────────
test('idempotency: same intent produces same ingest key and asset/reference ids', () => {
  const a = planIngest({ ...BASE, kind: 'image', mimeType: 'image/png', fileName: 'ref.png' });
  const b = planIngest({ ...BASE, kind: 'image', mimeType: 'image/png', fileName: 'ref.png' });
  assert.equal(a.plan.asset.id, b.plan.asset.id);
  assert.equal(a.plan.reference.id, b.plan.reference.id);
  assert.equal(a.plan.ingestKey, b.plan.ingestKey);
  assert.equal(computeIngestKey({ ...BASE, kind: 'image', fileName: 'u.png' }),
               computeIngestKey({ ...BASE, kind: 'image', fileName: 'u.png' }));
});

test('idempotency: contentHash dedupes two uploads of the same bytes', () => {
  const a = computeIngestKey({ ...BASE, kind: 'image', fileName: 'a.png', contentHash: 'abc' });
  const b = computeIngestKey({ ...BASE, kind: 'image', fileName: 'b.png', contentHash: 'abc' });
  assert.equal(a, b);
});

test('idempotency: different content makes different ids', () => {
  const a = planIngest({ ...BASE, kind: 'image', fileName: 'a.png' });
  const b = planIngest({ ...BASE, kind: 'image', fileName: 'b.png' });
  assert.notEqual(a.plan.asset.id, b.plan.asset.id);
});

function computeIngestKeyFrom(v) {
  return computeIngestKey(v);
}

// ── Provenance / origin linking ─────────────────────────────────────────────
test('provenance links the asset, reference and ingest key coherently', () => {
  const plan = planIngest({ ...BASE, kind: 'url', url: 'https://example.com/ref.jpg' });
  const p = plan.plan;
  assert.equal(p.provenance.origin, 'imported');
  assert.equal(p.provenance.inputKind, 'url');
  assert.equal(p.provenance.sourceUrl, 'https://example.com/ref.jpg');
  assert.equal(p.provenance.assetId, p.asset.id);
  assert.equal(p.provenance.referenceId, p.reference.id);
  assert.deepEqual(p.provenance.referenceAssets, [p.reference.id]);
});

// ── Upload retry / recoverability ──────────────────────────────────────────
test('retry classification: recoverable errors are retryable', () => {
  assert.equal(isRetryableIngestError({ code: 'OSS_UNAVAILABLE' }), true);
  assert.equal(isRetryableIngestError({ code: 'TIMEOUT' }), true);
  assert.equal(isRetryableIngestError({ code: 'NETWORK' }), true);
  assert.equal(isRetryableIngestError({ code: 'RATE_LIMITED' }), true);
  assert.equal(isRetryableIngestError({ code: 'HTTP_5XX', httpStatus: 502 }), true);
  assert.equal(isRetryableIngestError({ httpStatus: 429 }), true);
  assert.equal(isRetryableIngestError({ code: 'THING', retryable: true }), true);
  assert.equal(isRetryableIngestError(new Error('connect ECONNRESET (network timeout)')), true);
});

test('retry classification: permanent errors are NOT retryable', () => {
  assert.equal(isRetryableIngestError({ code: 'UNSUPPORTED_INPUT', retryable: false }), false);
  assert.equal(isRetryableIngestError({ code: 'INVALID_INTENT' }), false);
  assert.equal(isRetryableIngestError({ code: 'VALIDATION', retryable: false }), false);
  assert.equal(isRetryableIngestError({ httpStatus: 401 }), false);
  assert.equal(isRetryableIngestError({ httpStatus: 409 }), false);
  assert.equal(isRetryableIngestError({ code: 'AUTH_DENIED' }), false);
  assert.equal(isRetryableIngestError('random string'), false);
});

test('retry policy: exponential backoff with capped attempts', () => {
  const first = buildRetryPolicy({ attempts: 1, baseDelayMs: 1000, jitter: 0, maxAttempts: 5 });
  assert.equal(first.shouldRetry, true);
  assert.equal(first.nextAttempt, 2);
  assert.equal(first.backoffMs, 1000);

  const second = buildRetryPolicy({ attempts: 2, baseDelayMs: 1000, jitter: 0, maxAttempts: 5 });
  assert.equal(second.backoffMs, 2000);

  const third = buildRetryPolicy({ attempts: 3, baseDelayMs: 1000, jitter: 0, maxAttempts: 5 });
  assert.equal(third.backoffMs, 4000);
});

test('retry policy: gives up after max attempts and never grows unbounded', () => {
  const done = buildRetryPolicy({ attempts: 5, baseDelayMs: 1000, jitter: 0, maxAttempts: 5 });
  assert.equal(done.shouldRetry, false);
  assert.equal(done.reason, 'max_attempts_exhausted');

  const far = buildRetryPolicy({ attempts: 60, baseDelayMs: 1000, jitter: 0, maxAttempts: 5, maxDelayMs: 60000 });
  assert.equal(far.shouldRetry, false);
});

test('retry policy: jitter stays within bounds and is deterministic with an injectable RNG', () => {
  let calls = 0;
  const policy = buildRetryPolicy({ attempts: 1, baseDelayMs: 1000, jitter: 0.5, random: () => { calls++; return 0.5; } });
  assert.equal(calls, 1);
  // range = 1000 * 0.5 = 500; delay = 1000 - 500 + 0.5*1000 = 1000
  assert.equal(policy.backoffMs, 1000);
});

test('retry policy: negative attempts clamp to 0 and always retry when within budget', () => {
  const p = buildRetryPolicy({ attempts: -3, baseDelayMs: 500, jitter: 0, maxAttempts: 3 });
  assert.equal(p.shouldRetry, true);
  assert.equal(p.backoffMs, 500);
});
