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
