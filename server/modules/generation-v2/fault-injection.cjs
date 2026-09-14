'use strict';
// Fault Injection Harness for Generation V2 — TEST ONLY.
// Injects controllable failures at key lifecycle points:
//   BEFORE_PROVIDER_CALL, AFTER_PROVIDER_ACCEPT, BEFORE_PROVIDER_ID_PERSIST,
//   AFTER_PROVIDER_SUCCESS, BEFORE_UPLOAD, AFTER_OSS_PUT, BEFORE_DB_FINALIZE,
//   AFTER_CREDIT_COMMIT, REDIS_DOWN, WORKER_CRASH

const { FakeProvider } = require('./fake-provider.cjs');
const { FakeOssStorage } = require('./fake-oss.cjs');

const FAULT_POINTS = new Set([
  'BEFORE_PROVIDER_CALL',
  'AFTER_PROVIDER_ACCEPT',
  'BEFORE_PROVIDER_ID_PERSIST',
  'AFTER_PROVIDER_SUCCESS',
  'BEFORE_UPLOAD',
  'AFTER_OSS_PUT',
  'BEFORE_DB_FINALIZE',
  'AFTER_CREDIT_COMMIT',
  'REDIS_DOWN',
  'WORKER_CRASH',
]);

class FaultInjector {
  constructor(opts = {}) {
    this.faults = new Set(opts.faults || []);
    this.fakeProvider = new FakeProvider(opts.providerOpts || {});
    this.fakeOss = new FakeOssStorage(opts.ossOpts || {});
    this.redisDown = false;
    this.callLog = [];
  }

  hasFault(point) {
    return this.faults.has(point) || this.faults.has('*');
  }

  setFault(point) {
    if (!FAULT_POINTS.has(point)) throw new Error(`Unknown fault point: ${point}`);
    this.faults.add(point);
  }

  clearFaults() {
    this.faults.clear();
    this.redisDown = false;
  }

  // Wraps providerGenerate to inject faults
  wrapProviderGenerate(providerGenerate) {
    const self = this;
    return async function faultedProviderGenerate(item, signal) {
      self.callLog.push({ phase: 'provider_generate_start', itemId: item.item_id });

      if (self.hasFault('BEFORE_PROVIDER_CALL')) {
        const err = new Error('FAULT: before_provider_call');
        err.faultPoint = 'BEFORE_PROVIDER_CALL';
        self.callLog.push({ phase: 'fault', point: 'BEFORE_PROVIDER_CALL' });
        throw err;
      }

      const result = await self.fakeProvider.dispatchSingle({
        count: 1,
        idempotencyKey: item.client_request_id,
        clientRequestId: item.client_request_id,
      });

      self.callLog.push({ phase: 'provider_generate_end', itemId: item.item_id, resultStatus: result.status });

      if (result.status === 'success' && self.hasFault('AFTER_PROVIDER_SUCCESS')) {
        const err = new Error('FAULT: after_provider_success');
        err.faultPoint = 'AFTER_PROVIDER_SUCCESS';
        self.callLog.push({ phase: 'fault', point: 'AFTER_PROVIDER_SUCCESS' });
        throw err;
      }

      if (self.hasFault('AFTER_PROVIDER_ACCEPT') && result.status === 'success') {
        // Simulate: provider accepted but response lost (crash window)
        result.providerTaskId = null; // Simulate missing providerRequestId
        self.callLog.push({ phase: 'fault', point: 'AFTER_PROVIDER_ACCEPT', note: 'providerRequestId cleared' });
      }

      // Pass through the original result format for normalizeProviderResult
      return result;
    };
  }

  // Wraps uploadToOss to inject upload faults
  wrapUploadToOss(uploadToOss) {
    const self = this;
    return async function faultedUploadToOss(opts) {
      self.callLog.push({ phase: 'upload_start', item: opts.item });

      if (self.hasFault('BEFORE_UPLOAD')) {
        const err = new Error('FAULT: before_upload');
        err.faultPoint = 'BEFORE_UPLOAD';
        self.callLog.push({ phase: 'fault', point: 'BEFORE_UPLOAD' });
        throw err;
      }

      const result = await self.fakeOss.put({
        objectKey: opts.objectKey,
        content: opts.providerUrl,
        contentType: opts.item?.content_type || 'image',
      });

      self.callLog.push({ phase: 'upload_end', item: opts.item, ossUrl: result.ossUrl });

      if (self.hasFault('AFTER_OSS_PUT')) {
        const err = new Error('FAULT: after_oss_put');
        err.faultPoint = 'AFTER_OSS_PUT';
        self.callLog.push({ phase: 'fault', point: 'AFTER_OSS_PUT' });
        throw err;
      }

      return { ossUrl: result.ossUrl, mediaId: opts.item?.item_id };
    };
  }

  // Wraps settleHold to inject billing faults
  wrapSettleHold(settleHold) {
    const self = this;
    return async function faultedSettleHold(pg, opts) {
      self.callLog.push({ phase: 'settle_hold', itemId: opts.itemId, action: opts.action });

      if (self.hasFault('AFTER_CREDIT_COMMIT')) {
        const err = new Error('FAULT: after_credit_commit');
        err.faultPoint = 'AFTER_CREDIT_COMMIT';
        self.callLog.push({ phase: 'fault', point: 'AFTER_CREDIT_COMMIT' });
        throw err;
      }

      return settleHold(pg, opts);
    };
  }

  // Wraps reconcile queryProviderStatus to inject reconciliation faults
  wrapQueryProviderStatus(queryProviderStatus) {
    const self = this;
    return async function faultedQueryProviderStatus(providerRequestId, item) {
      self.callLog.push({ phase: 'reconcile_query', providerRequestId, itemId: item?.item_id });

      if (self.hasFault('BEFORE_PROVIDER_ID_PERSIST')) {
        return { status: 'unknown', error: 'FAULT: before_provider_id_persist' };
      }

      if (self.fakeProvider.calls.length > 0) {
        // Return the last matching call's outcome
        const lastCall = self.fakeProvider.calls[self.fakeProvider.calls.length - 1];
        if (lastCall.result && lastCall.result.status === 'success') {
          return {
            status: 'success',
            providerUrl: lastCall.result.images?.[0] || lastCall.result.providerUrl,
          };
        }
      }

      return { status: 'unknown', error: 'no provider call found' };
    };
  }

  reset() {
    this.faults.clear();
    this.fakeProvider.reset();
    this.fakeOss.reset();
    this.redisDown = false;
    this.callLog = [];
  }
}

module.exports = { FaultInjector, FAULT_POINTS };
