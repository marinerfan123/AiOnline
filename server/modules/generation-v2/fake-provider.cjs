'use strict';
// Fake Provider — TEST ONLY. Never contacts external services.
// Deterministic outcomes for failure injection testing.
const { GOLDEN_FIXTURES } = require('./fixtures/driver-golden-fixtures.cjs');

// L26 §125 golden 一致路径：以 fixtures 为单一来源，(driverKind,state) → 第一条 result 样本 raw。
// contract tests 用 goldenRaw 做 round-trip（raw→normalizeResult→expected）防 drift。
const _goldenIndex = (() => {
  const idx = Object.create(null);
  for (const f of GOLDEN_FIXTURES) {
    if (f.fn !== 'result') continue;
    const key = `${f.driverKind}:${f.state}`;
    if (!(key in idx)) idx[key] = f.raw;
  }
  return idx;
})();

function _deepClone(v) {
  if (v == null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}

class FakeProvider {
  constructor(opts = {}) {
    this.scenarios = opts.scenarios || {}; // key -> { outcome, providerUrl, providerRequestId, delay }
    this.calls = [];
    this.defaultOutcome = opts.defaultOutcome || 'success';
    this.defaultProviderUrl = opts.defaultProviderUrl || 'https://fake.test/img.png';
    this.defaultDelay = opts.defaultDelay || 0;
    this.counter = 0;
  }

  _nextId() {
    this.counter++;
    return `fake-pr-${this.counter}`;
  }

  // L26：返回与 golden fixture.raw 完全一致的 raw provider 响应（独立深拷贝）。
  // 未命中返回 null。仅供 contract tests 做 round-trip 防 drift。
  goldenRaw(driverKind, state) {
    const raw = _goldenIndex[`${driverKind}:${state}`];
    return raw == null ? null : _deepClone(raw);
  }

  // Simulates dispatchSingle({ ...payload })
  async dispatchSingle(payload) {
    const { count = 1, idempotencyKey, clientRequestId } = payload || {};
    this.counter++;
    const key = idempotencyKey || clientRequestId || `call-${this.counter}`;
    const scenario = this.scenarios[key];
    const outcome = (scenario && scenario.outcome) || this.defaultOutcome;
    const delay = (scenario && scenario.delay != null) ? scenario.delay : this.defaultDelay;

    // Simulate delay (useful for timeout tests — call will await)
    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    const entry = { callNo: this.counter, key, outcome, payload, result: null };

    switch (outcome) {
      case 'success': {
        const url = scenario?.providerUrl || this.defaultProviderUrl;
        const providerRequestId = scenario?.providerRequestId || this._nextId();
        const result = {
          status: 'success',
          images: Array.from({ length: count }, () => url),
          providerId: 'fake-provider',
          keyId: 'fake-key',
          providerTaskId: providerRequestId,
          httpStatus: 200,
        };
        entry.result = result;
        this.calls.push(entry);
        return result;
      }
      case 'pending': {
        const result = {
          status: 'error',
          errorCode: 'PENDING',
          errorMessage: 'still processing',
          httpStatus: 202,
          providerId: 'fake-provider',
          providerTaskId: this._nextId(),
        };
        entry.result = result;
        this.calls.push(entry);
        return result;
      }
      case 'rate_limited': {
        const result = {
          status: 'error',
          errorCode: 'RATE_LIMITED',
          errorMessage: 'rate limited',
          httpStatus: 429,
          retryAfter: scenario?.retryAfter || 30,
          providerId: 'fake-provider',
          rateLimited: true,
        };
        entry.result = result;
        this.calls.push(entry);
        return result;
      }
      case 'error': {
        const result = {
          status: 'error',
          errorCode: scenario?.errorCode || 'PROVIDER_ERROR',
          errorMessage: scenario?.errorMessage || 'provider error',
          httpStatus: scenario?.httpStatus || 500,
          providerId: 'fake-provider',
          providerTaskId: this._nextId(),
        };
        entry.result = result;
        this.calls.push(entry);
        return result;
      }
      case 'timeout': {
        throw new Error('PROVIDER_TIMEOUT');
      }
      case 'unknown': {
        // Returns success but with no providerRequestId — simulates opaque provider
        const result = {
          status: 'success',
          images: Array.from({ length: count }, () => this.defaultProviderUrl),
          providerId: 'fake-provider',
          httpStatus: 200,
        };
        entry.result = result;
        this.calls.push(entry);
        return result;
      }
      // ── L26：契约态 outcome（与 golden fixtures 一致，供 contract round-trip） ──
      case 'failed': {
        // §22 契约 failed 终态：status 词 + FAILED_CODES 中的 errorCode
        const result = {
          status: 'failed',
          errorCode: scenario?.errorCode || 'PROVIDER_FAILED',
          errorMessage: scenario?.errorMessage || 'provider failed',
          providerId: 'fake-provider',
          providerTaskId: this._nextId(),
        };
        entry.result = result;
        this.calls.push(entry);
        return result;
      }
      case 'contract_pending': {
        // §22 契约 pending 态（区别于 legacy 'pending' 的 status:'error' 形状）
        const result = {
          status: 'pending',
          providerId: 'fake-provider',
          providerTaskId: this._nextId(),
        };
        entry.result = result;
        this.calls.push(entry);
        return result;
      }
      case 'unknown_status': {
        // §22 契约 unknown 态：无法归类的状态词
        const result = { status: 'weird' };
        entry.result = result;
        this.calls.push(entry);
        return result;
      }
      default:
        throw new Error(`Unknown fake provider outcome: ${outcome}`);
    }
  }

  reset() {
    this.calls = [];
    this.counter = 0;
  }
}

module.exports = { FakeProvider };
