'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideRetry, parseRetryAfterMs } = require('./retry-policy.cjs');

test('Retry-After 秒数和HTTP日期可解析并限制范围', () => {
  assert.equal(parseRetryAfterMs('12', 0), 12000);
  assert.equal(parseRetryAfterMs('9999', 0), 300000);
  assert.equal(parseRetryAfterMs('bad', 0), null);
  assert.equal(parseRetryAfterMs(new Date(20000).toUTCString(), 5000), 15000);
});

test('429 进入retry_wait且尊重Retry-After，不在调用栈同步重试', () => {
  const r = decideRetry({ attempt: 1, httpStatus: 429, retryAfter: '15', now: 1000, jitter: 0 });
  assert.equal(r.status, 'retry_wait');
  assert.equal(r.delayMs, 15000);
  assert.equal(r.nextAttemptAt, 16000);
  assert.equal(r.retryInline, false);
});

test('429无header按2/5/12/30/60秒退避', () => {
  const expected = [2000, 5000, 12000, 30000, 60000];
  expected.forEach((ms, i) => assert.equal(decideRetry({ attempt: i + 1, httpStatus: 429, now: 0, jitter: 0 }).delayMs, ms));
});

test('明确4xx参数/内容错误直接failed', () => {
  for (const code of [400, 401, 403, 404, 422]) {
    assert.equal(decideRetry({ attempt: 1, httpStatus: code }).status, 'failed');
  }
});

test('已获provider request id但响应不明确进入reconciling，禁止重提退款', () => {
  const r = decideRetry({ attempt: 2, errorCode: 'TIMEOUT', providerRequestId: 'up-1' });
  assert.equal(r.status, 'reconciling');
  assert.equal(r.retryInline, false);
  assert.equal(r.allowRelease, false);
});

test('无request id的网络错误进入retry_wait；超最大次数进入review_required', () => {
  assert.equal(decideRetry({ attempt: 2, errorCode: 'ECONNRESET', now: 0, jitter: 0 }).status, 'retry_wait');
  const exhausted = decideRetry({ attempt: 6, errorCode: 'TIMEOUT' });
  assert.equal(exhausted.status, 'review_required');
  assert.equal(exhausted.allowRelease, false);
});
