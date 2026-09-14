'use strict';
// Fake OSS — TEST ONLY. Never contacts external storage.
// Deterministic outcomes for upload failure injection testing.

class FakeOssStorage {
  constructor(opts = {}) {
    this.store = new Map(); // key -> { contentHash, callCount, lastPutAt }
    this.calls = [];
    this.defaultOutcome = opts.defaultOutcome || 'success';
    this.failKeys = new Set(opts.failKeys || []); // objectKey prefixes that fail
  }

  _hash(content) {
    let h = 0;
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) - h + content.charCodeAt(i)) | 0;
    }
    return `hash-${Math.abs(h).toString(16)}`;
  }

  async put({ objectKey, content, contentType } = {}) {
    this.calls.push({ type: 'put', objectKey, contentType, result: null });
    const entry = this.calls[this.calls.length - 1];

    if (this.failKeys.has(objectKey) || [...this.failKeys].some(k => objectKey.startsWith(k)) || this.defaultOutcome === 'error') {
      const err = new Error('FakeOssStorage: PUT failed');
      entry.result = { error: err.message };
      throw err;
    }

    const hash = this._hash(typeof content === 'string' ? content : '');
    const existing = this.store.get(objectKey);
    const callCount = (existing && existing.callCount) ? existing.callCount + 1 : 1;

    this.store.set(objectKey, { contentHash: hash, callCount, lastPutAt: Date.now(), contentType });
    const ossUrl = `https://fake-oss.test/${encodeURIComponent(objectKey)}`;
    entry.result = { ossUrl };
    return { ossUrl };
  }

  reset() {
    this.store.clear();
    this.calls = [];
  }
}

module.exports = { FakeOssStorage };
