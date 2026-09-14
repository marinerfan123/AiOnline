'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FaultInjector, FAULT_POINTS } = require('./fault-injection.cjs');
const { FakeProvider } = require('./fake-provider.cjs');
const { FakeOssStorage } = require('./fake-oss.cjs');

// ─── B2: Fake Provider determinism ───

test('fake-provider: default outcome is success', async () => {
  const fp = new FakeProvider();
  const r = await fp.dispatchSingle({ count: 1 });
  assert.equal(r.status, 'success');
  assert.ok(r.images[0]);
  assert.ok(r.providerTaskId);
});

test('fake-provider: supports rate_limited outcome', async () => {
  const fp = new FakeProvider({ defaultOutcome: 'rate_limited' });
  const r = await fp.dispatchSingle({ count: 1 });
  assert.equal(r.status, 'error');
  assert.equal(r.errorCode, 'RATE_LIMITED');
  assert.equal(r.httpStatus, 429);
});

test('fake-provider: supports timeout (throws)', async () => {
  const fp = new FakeProvider({ defaultOutcome: 'timeout' });
  await assert.rejects(fp.dispatchSingle({ count: 1 }));
});

test('fake-provider: per-key scenarios override default', async () => {
  const fp = new FakeProvider({
    defaultOutcome: 'success',
    scenarios: { 'k1': { outcome: 'error', errorCode: 'CUSTOM_ERR' } },
  });
  const r = await fp.dispatchSingle({ idempotencyKey: 'k1' });
  assert.equal(r.status, 'error');
  assert.equal(r.errorCode, 'CUSTOM_ERR');
});

test('fake-provider: counter increments per dispatch call', async () => {
  const fp = new FakeProvider();
  await fp.dispatchSingle({ count: 1 });
  assert.ok(fp.counter >= 1);
  assert.equal(fp.calls.length, 1);
  await fp.dispatchSingle({ count: 1 });
  assert.ok(fp.counter >= 2);
  assert.equal(fp.calls.length, 2);
});

test('fake-provider: reset clears state', async () => {
  const fp = new FakeProvider();
  await fp.dispatchSingle({ count: 1 });
  fp.reset();
  assert.equal(fp.counter, 0);
  assert.equal(fp.calls.length, 0);
});

// ─── B4: Fake OSS ───

test('fake-oss: default PUT succeeds with deterministic url', async () => {
  const fo = new FakeOssStorage();
  const r = await fo.put({ objectKey: 'gen/abc.png', content: 'data' });
  assert.ok(r.ossUrl.includes('gen%2Fabc.png'));
  assert.equal(fo.store.size, 1);
});

test('fake-oss: overwrite increments call count', async () => {
  const fo = new FakeOssStorage();
  await fo.put({ objectKey: 'gen/x.png', content: 'v1' });
  await fo.put({ objectKey: 'gen/x.png', content: 'v2' });
  const entry = fo.store.get('gen/x.png');
  assert.equal(entry.callCount, 2);
});

test('fake-oss: failKeys causes PUT to throw', async () => {
  const fo = new FakeOssStorage({ failKeys: ['bad'] });
  await assert.rejects(fo.put({ objectKey: 'bad/file.png', content: 'x' }));
});

test('fake-oss: reset clears store', async () => {
  const fo = new FakeOssStorage();
  await fo.put({ objectKey: 'a.png', content: 'x' });
  fo.reset();
  assert.equal(fo.store.size, 0);
  assert.equal(fo.calls.length, 0);
});

// ─── B2: Fault Injector ───

test('fault-injector: setFault + hasFault', () => {
  const fi = new FaultInjector();
  assert.equal(fi.hasFault('BEFORE_PROVIDER_CALL'), false);
  fi.setFault('BEFORE_PROVIDER_CALL');
  assert.equal(fi.hasFault('BEFORE_PROVIDER_CALL'), true);
  fi.clearFaults();
  assert.equal(fi.hasFault('BEFORE_PROVIDER_CALL'), false);
});

test('fault-injector: wildcard fault matches all', () => {
  const fi = new FaultInjector({ faults: ['*'] });
  assert.equal(fi.hasFault('BEFORE_PROVIDER_CALL'), true);
  assert.equal(fi.hasFault('AFTER_OSS_PUT'), true);
});

test('fault-injector: wrapProviderGenerate injects BEFORE_PROVIDER_CALL fault', async () => {
  const fi = new FaultInjector();
  fi.setFault('BEFORE_PROVIDER_CALL');
  const gen = fi.wrapProviderGenerate(async () => ({ status: 'success' }));
  let caught;
  try { await gen({ item_id: 'i1' }); } catch(e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.faultPoint, 'BEFORE_PROVIDER_CALL');
});

test('fault-injector: wrapProviderGenerate no fault — passes through fake provider', async () => {
  const fi = new FaultInjector();
  const gen = fi.wrapProviderGenerate(async () => ({}));
  const r = await gen({ item_id: 'i1', client_request_id: 'cr1' });
  assert.equal(r.status, 'success');
});

test('fault-injector: AFTER_PROVIDER_SUCCESS fault throws', async () => {
  const fi = new FaultInjector();
  fi.setFault('AFTER_PROVIDER_SUCCESS');
  const gen = fi.wrapProviderGenerate(async () => ({}));
  let caught;
  try { await gen({ item_id: 'i1' }); } catch(e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.faultPoint, 'AFTER_PROVIDER_SUCCESS');
});

test('fault-injector: AFTER_PROVIDER_ACCEPT clears providerRequestId', async () => {
  const fi = new FaultInjector();
  fi.setFault('AFTER_PROVIDER_ACCEPT');
  const gen = fi.wrapProviderGenerate(async () => ({}));
  const r = await gen({ item_id: 'i1' });
  assert.equal(r.providerTaskId, null);
});

test('fault-injector: wrapUploadToOss injects BEFORE_UPLOAD fault', async () => {
  const fi = new FaultInjector();
  fi.setFault('BEFORE_UPLOAD');
  const up = fi.wrapUploadToOss(async () => ({}));
  let caught;
  try { await up({ objectKey: 'x.png', item: { item_id: 'i1' } }); } catch(e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.faultPoint, 'BEFORE_UPLOAD');
});

test('fault-injector: wrapUploadToOss success returns ossUrl', async () => {
  const fi = new FaultInjector();
  const up = fi.wrapUploadToOss(async () => ({}));
  const r = await up({ objectKey: 'x.png', providerUrl: 'up', item: { item_id: 'i1', content_type: 'image' } });
  assert.ok(r.ossUrl);
  assert.equal(r.mediaId, 'i1');
});

test('fault-injector: wrapSettleHold injects AFTER_CREDIT_COMMIT fault', async () => {
  const fi = new FaultInjector();
  fi.setFault('AFTER_CREDIT_COMMIT');
  const settle = fi.wrapSettleHold(async (pg, opts) => ({ changed: true }));
  let caught;
  try { await settle({}, { itemId: 'i1', action: 'commit' }); } catch(e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.faultPoint, 'AFTER_CREDIT_COMMIT');
});

test('fault-injector: wrapSettleHold no fault — passes through', async () => {
  const fi = new FaultInjector();
  const settle = fi.wrapSettleHold(async (pg, opts) => ({ changed: true, hold: {} }));
  const r = await settle({}, { itemId: 'i1', action: 'commit' });
  assert.equal(r.changed, true);
});

test('fault-injector: reset clears all state', async () => {
  const fi = new FaultInjector({ faults: ['BEFORE_PROVIDER_CALL'] });
  await fi.fakeProvider.dispatchSingle({ count: 1 });
  fi.reset();
  assert.equal(fi.hasFault('BEFORE_PROVIDER_CALL'), false);
  assert.equal(fi.fakeProvider.calls.length, 0);
  assert.equal(fi.callLog.length, 0);
});

test('fault-injector: callLog records phases', async () => {
  const fi = new FaultInjector();
  const gen = fi.wrapProviderGenerate(async () => ({}));
  await gen({ item_id: 'i1' });
  assert.ok(fi.callLog.some(c => c.phase === 'provider_generate_start'));
  assert.ok(fi.callLog.some(c => c.phase === 'provider_generate_end'));
});

test('FAULT_POINTS enum has expected values', () => {
  const expected = [
    'BEFORE_PROVIDER_CALL', 'AFTER_PROVIDER_ACCEPT', 'BEFORE_PROVIDER_ID_PERSIST',
    'AFTER_PROVIDER_SUCCESS', 'BEFORE_UPLOAD', 'AFTER_OSS_PUT', 'BEFORE_DB_FINALIZE',
    'AFTER_CREDIT_COMMIT', 'REDIS_DOWN', 'WORKER_CRASH',
  ];
  for (const p of expected) {
    assert.ok(FAULT_POINTS.has(p), `${p} should be in FAULT_POINTS`);
  }
});
