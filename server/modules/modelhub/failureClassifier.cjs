'use strict';
/**
 * W4-06 — Failure classifier + retry policy (pure, no I/O). Map a provider error to a retryable
 * category + exponential-backoff schedule (deterministic for tests).
 */
const TRANSIENT = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'NETWORK', 'OUTAGE', '502', '503', '504', '429']);
const PERMANENT = new Set(['AUTH', '401', '403', 'VALIDATION', '400', 'INVALID_PROMPT', 'UNSUPPORTED', 'QUOTA_EXCEEDED', '409']);

function classifyFailure({ code, statusCode, message = '' } = {}) {
  const c = String(code || '');
  const st = String(statusCode || '');
  if (TRANSIENT.has(c) || TRANSIENT.has(st)) return { category: 'transient', retryable: true, reason: c || st || message.slice(0, 40) };
  if (PERMANENT.has(c) || PERMANENT.has(st)) return { category: 'permanent', retryable: false, reason: c || st };
  if (/rate|429|throttl|quota/i.test(message)) return { category: 'transient', retryable: true, reason: 'rate_limit' };
  if (/auth|401|403|forbidden|invalid.*(key|token|secret)/i.test(message)) return { category: 'permanent', retryable: false, reason: 'auth' };
  return { category: 'unknown', retryable: false, reason: 'unknown' };
}

/** Deterministic exponential backoff: attempt 1..N -> 1000,2000,4000 (capped). */
function backoffFor(attempt, { base = 1000, cap = 60000 } = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(cap, base * Math.pow(2, n - 1));
}

function shouldRetry({ classification, attemptCount, maxAttempts = 3 } = {}) {
  if (!classification || !classification.retryable) return { retry: false, reason: classification && classification.category };
  if (attemptCount >= maxAttempts) return { retry: false, reason: 'max_attempts', backoffMs: 0 };
  return { retry: true, backoffMs: backoffFor(attemptCount) };
}

module.exports = { classifyFailure, backoffFor, shouldRetry };
