'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyFailure, backoffFor, shouldRetry } = require('./failureClassifier.cjs');

test('transient (network/429/5xx) retryable', () => {
  assert.equal(classifyFailure({ code: 'ECONNRESET' }).retryable, true);
  assert.equal(classifyFailure({ statusCode: 503 }).retryable, true);
  assert.equal(classifyFailure({ statusCode: 429 }).retryable, true);
});

test('permanent (auth/validation/409) NOT retryable', () => {
  assert.equal(classifyFailure({ statusCode: 401 }).retryable, false);
  assert.equal(classifyFailure({ statusCode: 400 }).retryable, false);
  assert.equal(classifyFailure({ statusCode: 409 }).retryable, false);
});

test('message-based rate/auth heuristic', () => {
  assert.equal(classifyFailure({ message: 'rate limit exceeded' }).retryable, true);
  assert.equal(classifyFailure({ message: 'invalid api key' }).retryable, false);
});

test('exponential backoff deterministic (1000,2000,4000...)', () => {
  assert.equal(backoffFor(1), 1000);
  assert.equal(backoffFor(2), 2000);
  assert.equal(backoffFor(3), 4000);
  assert.equal(backoffFor(10), 60000); // capped
});

test('shouldRetry respects max attempts', () => {
  assert.equal(shouldRetry({ classification: { retryable: true, category: 'transient' }, attemptCount: 1 }).retry, true);
  assert.equal(shouldRetry({ classification: { retryable: true }, attemptCount: 3, maxAttempts: 3 }).retry, false);
  assert.equal(shouldRetry({ classification: { retryable: false } }).retry, false);
});
