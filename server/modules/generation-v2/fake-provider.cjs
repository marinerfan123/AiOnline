'use strict';
// Fake Provider — TEST ONLY. Never contacts external services.
// Deterministic outcomes for failure injection testing.

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
