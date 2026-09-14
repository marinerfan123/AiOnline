'use strict';
const BACKOFF_MS = [2000, 5000, 12000, 30000, 60000];
const MAX_DELAY_MS = 300000;
const MAX_ATTEMPTS = 5;

function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_DELAY_MS, Math.round(seconds * 1000));
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(MAX_DELAY_MS, at - now));
}

function withJitter(ms, jitter = Math.random()) {
  const unit = Math.max(0, Math.min(1, Number(jitter) || 0));
  return Math.round(ms * (1 + unit * 0.2));
}

function decideRetry({
  attempt = 1, httpStatus = null, errorCode = null, providerRequestId = null,
  retryAfter = null, now = Date.now(), jitter = Math.random(),
} = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  if (providerRequestId && (errorCode || !httpStatus || httpStatus >= 500)) {
    return { status: 'reconciling', retryInline: false, allowRelease: false, delayMs: null, nextAttemptAt: null };
  }
  if (httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
    return { status: 'failed', retryInline: false, allowRelease: true, delayMs: null, nextAttemptAt: null };
  }
  if (n > MAX_ATTEMPTS) {
    return { status: 'review_required', retryInline: false, allowRelease: false, delayMs: null, nextAttemptAt: null };
  }
  const retryable = httpStatus === 429 || httpStatus === 408 || (httpStatus && httpStatus >= 500) || !!errorCode;
  if (!retryable) {
    return { status: 'failed', retryInline: false, allowRelease: true, delayMs: null, nextAttemptAt: null };
  }
  const headerDelay = httpStatus === 429 ? parseRetryAfterMs(retryAfter, now) : null;
  const base = headerDelay == null ? BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)] : headerDelay;
  const delayMs = withJitter(base, jitter);
  return { status: 'retry_wait', retryInline: false, allowRelease: false, delayMs, nextAttemptAt: now + delayMs };
}

module.exports = { BACKOFF_MS, parseRetryAfterMs, decideRetry };
