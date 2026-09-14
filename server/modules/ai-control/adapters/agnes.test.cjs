'use strict';
/**
 * M02-A — Agnes Adapter COMPATIBILITY PROOF.
 *
 * Uses a FAKE transport (no paid upstream). Proves:
 *  1) the adapter satisfies the formal Provider Adapter Contract
 *  2) normalizeInput is BYTE-IDENTICAL to the certified agnes.cjs buildAgnesVars
 *     (same input → same wire body — no behavior drift from the production path)
 *  3) submit/poll/normalizeStatus/normalizeError/normalizeResult behave per contract
 *  4) the credential never leaks into the wire body or a serialized result
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgnesAdapter } = require('./agnes.cjs');
const { assertAdapterContract } = require('../contracts/adapter.cjs');
const certified = require('../../../providers/video/agnes.cjs');

// ── fake transport (records what it would send; returns canned upstream) ──
function fakeTransport() {
  const sent = { submitBody: null, pollQuery: null };
  return {
    sent,
    submit: async (body) => { sent.submitBody = body; return { status: 200, body: { video_id: 'agnes-vt-123' } }; },
    poll: async (query) => { sent.pollQuery = query; return { status: 200, body: { status: 'completed', metadata: { url: 'https://cdn.example/v.mp4' } } }; },
  };
}

const PROVIDER = { base_url: 'https://api.agnes-ai.cn/v1' };
const MODEL = { model_id: 'agnes-image-2.1-flash', upstreamModelName: 'agnes-image-2.1-flash' };

test('adapter: satisfies the formal contract', () => {
  const a = createAgnesAdapter({ transport: fakeTransport() });
  const check = assertAdapterContract(a);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(a.name, 'agnes');
});

test('adapter: normalizeInput is byte-identical to certified buildAgnesVars', () => {
  const a = createAgnesAdapter({ transport: fakeTransport() });
  const input = { prompt: 'a cat', ratio: '16:9', durationSec: 6, negative: 'blur', referenceImages: ['https://img/1.jpg'] };
  const viaAdapter = a.normalizeInput(MODEL, input);
  const viaCertified = certified.buildAgnesVars(
    { prompt: input.prompt, ratio: input.ratio, durationSec: input.durationSec, referenceImages: input.referenceImages, negative: input.negative },
    MODEL,
  );
  assert.deepEqual(viaAdapter, viaCertified, 'wire body must match certified path exactly');
  // spot-check the agnes-specific invariants survived
  assert.equal(viaAdapter.model, 'agnes-image-2.1-flash');
  assert.equal(viaAdapter.mode, 'ti2vid');
  assert.equal(typeof viaAdapter.num_frames, 'number');
  assert.ok((viaAdapter.num_frames - 1) % 8 === 0, 'num_frames is 8n+1');
});

test('adapter: two reference images → keyframes mode (certified parity)', () => {
  const a = createAgnesAdapter({ transport: fakeTransport() });
  const body = a.normalizeInput(MODEL, { prompt: 'x', referenceImages: ['https://img/1.jpg', 'https://img/2.jpg'] });
  assert.equal(body.mode, 'keyframes');
  assert.deepEqual(body.extra_body, { image: ['https://img/1.jpg', 'https://img/2.jpg'], mode: 'keyframes' });
});

test('adapter: submit → SUBMITTED with provider task id (fake upstream)', async () => {
  const t = fakeTransport();
  const a = createAgnesAdapter({ transport: t });
  const r = await a.submit({ credential: 'sk-SECRET-1234', provider: PROVIDER, logicalModel: MODEL, input: { prompt: 'hi' } });
  assert.equal(r.status, 'SUBMITTED');
  assert.equal(r.taskId, 'agnes-vt-123');
  assert.equal(r.providerTaskId, 'agnes-vt-123');
  // wire body carried the prompt, NOT the credential
  assert.equal(t.sent.submitBody.prompt, 'hi');
  assert.ok(!JSON.stringify(t.sent.submitBody).includes('sk-SECRET-1234'), 'credential must not be in wire body');
});

test('adapter: poll completed → normalizeResult SUCCEEDED + url (fake upstream)', async () => {
  const t = fakeTransport();
  const a = createAgnesAdapter({ transport: t });
  const r = await a.poll({ credential: 'sk-SECRET-1234', provider: PROVIDER, logicalModel: MODEL, taskId: 'agnes-vt-123' });
  assert.equal(r.status, 'SUCCEEDED');
  assert.equal(r.url, 'https://cdn.example/v.mp4');
  assert.equal(r.provider_status_raw, 'completed');
  assert.ok(!JSON.stringify(r).includes('sk-SECRET-1234'));
});

test('adapter: poll in_progress → PROCESSING (non-terminal, keeps raw)', async () => {
  const a = createAgnesAdapter({ transport: { submit: async () => ({ status: 200, body: { video_id: 'v' } }), poll: async () => ({ status: 200, body: { status: 'in_progress' } }) } });
  const r = await a.poll({ credential: 'x', provider: PROVIDER, logicalModel: MODEL, taskId: 'v' });
  assert.equal(r.status, 'PROCESSING');
  assert.equal(r.provider_status_raw, 'in_progress');
});

test('adapter: submit 429 → normalizeError RATE_LIMITED retryable, no secret leak', async () => {
  const a = createAgnesAdapter({ transport: { submit: async () => ({ status: 429, body: { error: { message: 'too many' } } }), poll: async () => ({ status: 200, body: {} }) } });
  const r = await a.submit({ credential: 'sk-SECRET-1234', provider: PROVIDER, logicalModel: MODEL, input: { prompt: 'hi' } });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.code, 'RATE_LIMITED');
  assert.equal(r.retryable, true);
  assert.equal(r.http_status, 429);
  assert.ok(!JSON.stringify(r).includes('sk-SECRET-1234'));
});

test('adapter: submit 401 → CREDENTIAL_INVALID non-retryable', async () => {
  const a = createAgnesAdapter({ transport: { submit: async () => ({ status: 401, body: { error: 'auth' } }), poll: async () => ({ status: 200, body: {} }) } });
  const r = await a.submit({ credential: 'sk-x', provider: PROVIDER, logicalModel: MODEL, input: { prompt: 'hi' } });
  assert.equal(r.code, 'CREDENTIAL_INVALID');
  assert.equal(r.retryable, false);
});

test('adapter: normalizeStatus maps agnes raw states via provider-specific table', () => {
  const a = createAgnesAdapter({ transport: fakeTransport() });
  assert.equal(a.normalizeStatus('queued'), 'QUEUED');
  assert.equal(a.normalizeStatus('inqueue'), 'QUEUED');
  assert.equal(a.normalizeStatus('completed'), 'SUCCEEDED');
  assert.equal(a.normalizeStatus('failed'), 'FAILED');
  assert.equal(a.normalizeStatus('canceled'), 'CANCELLED');
});

test('adapter: cancel → not_supported (Agnes has no cancel API)', async () => {
  const a = createAgnesAdapter({ transport: fakeTransport() });
  const r = await a.cancel({ credential: 'x', provider: PROVIDER, logicalModel: MODEL, taskId: 'v' });
  assert.equal(r.status, 'not_supported');
});

test('adapter: missing transport fails fast (no silent real HTTP in tests)', async () => {
  const a = createAgnesAdapter({});
  await assert.rejects(() => a.submit({ credential: 'x', provider: PROVIDER, logicalModel: MODEL, input: { prompt: 'hi' } }), /transport/);
});
