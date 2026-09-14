'use strict';
/**
 * W4-04 — Provider attempt persistence (pure sanitization + fingerprint). Stores provider/model/
 * request fingerprint/status/timing/result/error class WITHOUT secrets. Strips credential-ish keys.
 */
const SECRET_KEYS = /(api[_-]?key|secret|token|credential|authorization|password|bearer)/i;
const { classifyFailure } = require('../modelhub/failureClassifier.cjs');

/** Sanitize a provider attempt to only safe, durable fields (no secrets). */
function sanitizeAttempt({ provider, model, request, status, startedAt, finishedAt, result, error } = {}) {
  const fingerprint = hashFingerprint(request);
  const errClass = error ? classifyFailure({ code: error.code, statusCode: error.statusCode, message: error.message }) : null;
  return {
    provider: provider || null,
    model: model || null,
    requestFingerprint: fingerprint,
    status: status || 'pending',
    startedAt: startedAt || null,
    finishedAt: finishedAt || null,
    durationMs: startedAt && finishedAt ? Math.max(0, new Date(finishedAt) - new Date(startedAt)) : null,
    result: safeResult(result),
    errorClass: errClass ? errClass.category : null,
    retryable: errClass ? errClass.retryable : null,
    errorMessage: error ? String(error.message || '').slice(0, 200) : null,
  };
}

/** Strip any key that looks like a secret from a request/result object (recursive). */
function safeResult(v) {
  if (Array.isArray(v)) return v.map(safeResult);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) { if (SECRET_KEYS.test(k)) continue; out[k] = safeResult(val); }
    return out;
  }
  return v;
}

function hashFingerprint(obj) {
  const crypto = require('crypto');
  const safe = safeResult(obj);
  return crypto.createHash('sha256').update(JSON.stringify(safe)).digest('hex').slice(0, 20);
}

module.exports = { sanitizeAttempt, safeResult, hashFingerprint };
