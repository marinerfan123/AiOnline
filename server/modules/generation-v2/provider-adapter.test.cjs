'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadItemContext, buildSingleImagePayload, normalizeProviderResult, createProviderAdapter } = require('./provider-adapter.cjs');

test('loadItemContext联表读取batch payload/model和单图index', async () => {
  const pg = { async query(sql, params) {
    assert.match(sql, /JOIN generation_batches_v2/);
    assert.deepEqual(params, ['gi-1']);
    return { rows:[{ item_id:'gi-1', item_index:2, model_id:'m1', content_type:'image', request_payload:{prompt:'x',count:4,pendingIds:['p0','p1','p2','p3']} }] };
  }};
  const row = await loadItemContext(pg,'gi-1');
  assert.equal(row.item_index,2);
});

test('buildSingleImagePayload强制count=1并只保留当前pendingId', () => {
  const p = buildSingleImagePayload({
    item_id:'gi-1', item_index:2, model_id:'m1', content_type:'image',
    request_payload:{ prompt:'x', count:4, pendingIds:['p0','p1','p2','p3'], referenceImages:['r1'], resolution:'2k' },
  });
  assert.equal(p.count,1);
  assert.deepEqual(p.pendingIds,['p2']);
  assert.deepEqual(p.referenceImages,['r1']);
  assert.equal(p.modelId,'m1');
});

test('buildSingleImagePayload传播预持久化clientRequestId作为上游幂等键',()=>{const p=buildSingleImagePayload({item_id:'i',item_index:0,model_id:'m',content_type:'image',client_request_id:'cr-1',request_payload:{count:4}});assert.equal(p.idempotencyKey,'cr-1');assert.equal(p.clientRequestId,'cr-1')});
test('normalizeProviderResult抽取单图URL和provider元数据', () => {
  assert.deepEqual(normalizeProviderResult({status:'success',images:['u1','u2'],providerId:'p',keyId:'k',providerTaskId:'t'}), {
    status:'success',providerUrl:'u1',providerId:'p',keyId:'k',providerRequestId:'t',httpStatus:200,
  });
});

test('normalizeProviderResult保留429/Retry-After错误语义', () => {
  const r=normalizeProviderResult({status:'error',rateLimited:true,httpStatus:429,retryAfter:'20',providerId:'p',error:'busy'});
  assert.equal(r.status,'error');assert.equal(r.httpStatus,429);assert.equal(r.errorCode,'RATE_LIMITED');assert.equal(r.retryAfter,'20');
});

test('adapter调用注入dispatchSingle且永远count=1', async () => {
  let payload;
  const adapter=createProviderAdapter({dispatchSingle:async p=>{payload=p;return {status:'success',images:['u']};}});
  const result=await adapter({item_id:'gi-1',item_index:0,model_id:'m1',content_type:'image',request_payload:{count:4,prompt:'x'}});
  assert.equal(payload.count,1);assert.equal(result.providerUrl,'u');
});

// ═══════════════════════════════════════════════════════════════════════════
// §22-23 Driver Contract (L22) 测试
// ═══════════════════════════════════════════════════════════════════════════
const {
  normalizeStatus, normalizeError, normalizeResult,
  fromContract, registerDriver, registeredDriverKinds,
  assertDriverShape, DRIVER_METHODS, DRIVER_KINDS, DRIVER_ERROR, DriverContractError,
} = require('./provider-adapter.cjs');

function makeFakeDriver(overrides = {}) {
  return {
    submit: async () => ({ status: 'submitted' }),
    poll: async () => ({ status: 'pending' }),
    fetch: async () => ({ status: 'success', providerUrl: 'https://fake.test/u.mp4' }),
    cancel: async () => ({ status: 'canceled' }),
    compile: (input) => ({ ...input, provider_specific: true }),
    ...overrides,
  };
}

// ─── 1) Driver 接口形状：{submit,poll,fetch,cancel,compile} 必全 ───
test('Driver接口形状: 完整 {submit,poll,fetch,cancel,compile} 通过', () => {
  assert.deepEqual(DRIVER_METHODS, ['submit', 'poll', 'fetch', 'cancel']);
  assert.deepEqual(assertDriverShape(makeFakeDriver()), []);
});

test('Driver接口形状: 缺方法拒绝并列出缺失项(错误码 DRIVER_INTERFACE_INCOMPLETE)', () => {
  const bad = makeFakeDriver();
  delete bad.cancel;
  delete bad.compile;
  assert.throws(
    () => assertDriverShape(bad),
    (e) => e instanceof DriverContractError
      && e.code === DRIVER_ERROR.DRIVER_INTERFACE_INCOMPLETE
      && /cancel/.test(e.message) && /compile/.test(e.message)
  );
});

// ─── 2) 三归一：normalizeStatus / normalizeError / normalizeResult 同一契约形状 ───
test('normalizeStatus: 原始状态词 → 规范枚举(与 applyProviderEvent normalizedStatus 同形)', () => {
  assert.equal(normalizeStatus('completed'), 'success');
  assert.equal(normalizeStatus('DONE'), 'success');
  assert.equal(normalizeStatus('failed'), 'failed');
  assert.equal(normalizeStatus('processing'), 'pending');
  assert.equal(normalizeStatus('not_found'), 'not_found');
  assert.equal(normalizeStatus('whatever'), 'unknown');
  assert.equal(normalizeStatus(null), 'unknown');
  assert.equal(normalizeStatus(undefined), 'unknown');
});

test('normalizeError: 产出 {status,errorCode,errorMessage,retryAfter?} 契约', () => {
  assert.deepEqual(normalizeError({ code: 'RATE_LIMIT', message: 'busy', retryAfter: 30 }), {
    status: 'unknown', errorCode: 'RATE_LIMIT', errorMessage: 'busy', retryAfter: 30,
  });
  assert.deepEqual(normalizeError({ code: 'NOT_FOUND', message: 'no task' }), {
    status: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'no task',
  });
  assert.equal(normalizeError({ code: 'CONTENT_POLICY' }).status, 'failed');
  assert.equal(normalizeError({ code: 'PROVIDER_FAILED' }).status, 'failed');
  // 未知/网络/超时 → unknown，绝不判 failed（provider-status-router 安全约定）
  assert.equal(normalizeError({ code: 'ETIMEDOUT' }).status, 'unknown');
  assert.equal(normalizeError({ code: 'WEIRD_CODE' }).errorCode, 'WEIRD_CODE');
  assert.deepEqual(normalizeError(new Error('boom')), { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'boom' });
  assert.deepEqual(normalizeError('literal'), { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'literal' });
});

test('normalizeResult: 成功 result → {status:success,providerUrl,...}; 非成功走 error 分支', () => {
  assert.deepEqual(normalizeResult({ status: 'success', providerUrl: 'https://u/v.mp4', providerTaskId: 't1', keyId: 'k' }), {
    status: 'success', providerUrl: 'https://u/v.mp4', providerRequestId: 't1', keyId: 'k',
  });
  assert.equal(normalizeResult({ status: 'success', images: ['i1', 'i2'] }).providerUrl, 'i1');
  const r = normalizeResult({ status: 'failed', errorCode: 'CONTENT_POLICY', errorMessage: 'blocked' });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'CONTENT_POLICY');
  // 非终态结果保留语义（与 queryProviderStatus 同形）
  assert.deepEqual(normalizeResult({ status: 'pending' }), { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'still processing' });
  assert.equal(normalizeResult({ status: 'not_found' }).status, 'not_found');
});

// ─── 3) 工厂 fromContract(providerId, contractRow) → adapter ───
test('fromContract: 已知 driver_kind 返回 adapter 并委托四方法 + compile + 三归一', async () => {
  const calls = [];
  const impl = makeFakeDriver({
    submit: async (x) => { calls.push('submit'); return x; },
    poll: async () => { calls.push('poll'); return { status: 'pending' }; },
    fetch: async () => { calls.push('fetch'); return { status: 'success' }; },
    cancel: async () => { calls.push('cancel'); return { status: 'canceled' }; },
    compile: (x) => { calls.push('compile'); return { ...x, wired: true }; },
    normalizeStatus: (s) => `impl:${s}`,
  });
  const contractRow = {
    provider_id: 'p1', driver_kind: DRIVER_KINDS.AGNES, contract_version: 3,
    capabilities: { operation: 'video.image_to_video' }, schema_hash: 'sha-abc', status: 'ACTIVE',
  };
  const adapter = fromContract('p1', contractRow, { drivers: { [DRIVER_KINDS.AGNES]: impl } });

  assert.equal(adapter.providerId, 'p1');
  assert.equal(adapter.driverKind, 'agnes');
  assert.equal(adapter.contractVersion, 3);
  assert.equal(adapter.schemaHash, 'sha-abc');
  assert.equal(adapter.contractStatus, 'ACTIVE');
  assert.deepEqual(adapter.capabilities, { operation: 'video.image_to_video' });

  await adapter.submit({ a: 1 });
  await adapter.poll();
  await adapter.fetch();
  await adapter.cancel();
  assert.deepEqual(calls, ['submit', 'poll', 'fetch', 'cancel']);
  assert.deepEqual(adapter.compile({ prompt: 'x' }), { prompt: 'x', wired: true });
  // 三归一：impl 提供的 normalizeStatus 优先；缺省回退规范实现
  assert.equal(adapter.normalizeStatus('done'), 'impl:done');
  assert.equal(adapter.normalizeError({ code: 'NOT_FOUND' }).status, 'not_found');
  assert.equal(adapter.normalizeResult({ status: 'success', providerUrl: 'u' }).status, 'success');
});

test('fromContract: registerDriver 注册后可经默认注册表实例化', () => {
  registerDriver(DRIVER_KINDS.IMAGE_SYNC, makeFakeDriver());
  assert.ok(registeredDriverKinds().includes(DRIVER_KINDS.IMAGE_SYNC));
  const adapter = fromContract('p2', { driver_kind: DRIVER_KINDS.IMAGE_SYNC });
  assert.equal(adapter.driverKind, 'image-sync');
  assert.equal(typeof adapter.submit, 'function');
});

// ─── 4) 未知 driver_kind / 契约缺失 → 错误码（绝不 return null）───
test('fromContract: 未知 driver_kind 拒绝(错误码 UNKNOWN_DRIVER_KIND)', () => {
  assert.throws(
    () => fromContract('p1', { driver_kind: 'fal' }, { drivers: { agnes: makeFakeDriver() } }),
    (e) => e instanceof DriverContractError && e.code === DRIVER_ERROR.UNKNOWN_DRIVER_KIND
  );
});

test('fromContract: 缺 providerId / driver_kind 拒绝(错误码 CONTRACT_MISSING)', () => {
  assert.throws(
    () => fromContract('', { driver_kind: 'agnes' }),
    (e) => e instanceof DriverContractError && e.code === DRIVER_ERROR.CONTRACT_MISSING
  );
  assert.throws(
    () => fromContract('p1', {}),
    (e) => e instanceof DriverContractError && e.code === DRIVER_ERROR.CONTRACT_MISSING
  );
});
