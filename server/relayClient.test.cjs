'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelayClient, isRelayConfigured, isRelayEnabled, signUserId } = require('./relayClient.cjs');

const env = {
  MODEL_RELAY_ENABLED: 'true',
  MODEL_RELAY_BASE_URL: 'http://relay.internal:3010/',
  MODEL_RELAY_INTERNAL_TOKEN: 'internal-secret',
  MODEL_RELAY_USER_SIGNING_KEY: 'signing-secret',
};

test('relay requests carry signed user context and never provider credentials', async () => {
  const calls = [];
  const client = createRelayClient({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ status: 'pending', taskId: 'task-1', modelId: 'flux-1' }), { status: 202, headers: { 'content-type': 'application/json' } });
    },
  });

  await client.createGeneration({
    userId: 'user-7',
    request: { modelId: 'flux-1', prompt: 'a lighthouse', duration: 8, idempotencyKey: 'idem-1', providerApiKey: 'must-not-be-forwarded' },
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'http://relay.internal:3010/v1/generations');
  assert.equal(call.options.headers.authorization, 'Bearer internal-secret');
  assert.equal(call.options.headers['x-user-id'], 'user-7');
  assert.equal(call.options.headers['x-user-signature'], signUserId('user-7', env.MODEL_RELAY_USER_SIGNING_KEY));
  assert.equal(JSON.parse(call.options.body).duration, 8);
  assert.equal(JSON.parse(call.options.body).providerApiKey, undefined);
  assert.doesNotMatch(JSON.stringify(call.options.headers), /provider|sk-/i);
});

test('only explicitly configured relay mode is enabled', () => {
  assert.equal(isRelayConfigured(env), true);
  assert.equal(isRelayEnabled(env), true);
  assert.equal(isRelayConfigured({ ...env, MODEL_RELAY_INTERNAL_TOKEN: '' }), false);
  assert.equal(isRelayEnabled({ ...env, MODEL_RELAY_ENABLED: 'false' }), false);
  assert.equal(isRelayEnabled({ ...env, MODEL_RELAY_USER_SIGNING_KEY: '' }), false);
});

test('retries only temporary relay failures', async () => {
  let count = 0;
  const client = createRelayClient({
    env,
    fetchImpl: async () => {
      count += 1;
      return new Response(JSON.stringify({ error: 'temporary' }), { status: count === 1 ? 503 : 200 });
    },
  });
  const result = await client.getTask({ userId: 'user-7', taskId: 'task-1' });
  assert.equal(result.status, undefined);
  assert.equal(count, 2);
});
