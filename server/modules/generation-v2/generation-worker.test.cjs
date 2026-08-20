'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { processItem, runWorkerTick } = require('./generation-worker.cjs');

function makeDeps(overrides = {}) {
  const transitions = [];
  const attempts = [];
  return {
    transitions, attempts,
    deps: {
      claimItems: async () => [],
      withLeaseHeartbeat: async (_pg,_opt,_deps,operation) => operation(new AbortController().signal),
      transitionItem: async (_pg, args) => { transitions.push(args); return { item_id: args.itemId, status: args.to, lease_version: args.leaseVersion }; },
      providerGenerate: async () => ({ status: 'success', providerId: 'p1', keyId: 'k1', providerRequestId: 'up1', providerUrl: 'https://x/a.png' }),
      decideRetry: () => ({ status: 'retry_wait', nextAttemptAt: 1000, allowRelease: false }),
      recordAttempt: async (_pg, row) => { attempts.push(row); },
      ...overrides,
    },
  };
}

const ITEM = { item_id:'gi-1', lease_version:2, attempt_count:1, batch_id:'gb-1' };

test('成功路径 leased→generating→generated，持久化provider身份和URL', async () => {
  const { deps, transitions, attempts } = makeDeps();
  const r = await processItem({}, ITEM, deps);
  assert.equal(r.status, 'generated');
  assert.deepEqual(transitions.map(x => x.to), ['generating','generated']);
  assert.equal(transitions[1].patch.provider_request_id, 'up1');
  assert.equal(transitions[1].patch.provider_url, 'https://x/a.png');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'success');
});

test('旧worker第一步CAS失败时不调用provider', async () => {
  let providerCalled = false;
  const { deps } = makeDeps({
    transitionItem: async () => null,
    providerGenerate: async () => { providerCalled = true; return {}; },
  });
  const r = await processItem({}, ITEM, deps);
  assert.equal(r.status, 'stale_lease');
  assert.equal(providerCalled, false);
});

test('429不内联重试，写retry_wait和next_attempt_at', async () => {
  const { deps, transitions } = makeDeps({
    providerGenerate: async () => ({ status:'error', httpStatus:429, errorCode:'RATE_LIMITED', retryAfter:'12' }),
    decideRetry: () => ({ status:'retry_wait', nextAttemptAt:13000, allowRelease:false, retryInline:false }),
  });
  const r = await processItem({}, ITEM, deps);
  assert.equal(r.status, 'retry_wait');
  assert.equal(transitions.at(-1).to, 'retry_wait');
  assert.equal(transitions.at(-1).patch.next_attempt_at.getTime(), 13000);
});

test('已取得providerRequestId但响应不明确进入reconciling', async () => {
  const { deps, transitions } = makeDeps({
    providerGenerate: async () => ({ status:'error', errorCode:'TIMEOUT', providerRequestId:'up-amb' }),
    decideRetry: () => ({ status:'reconciling', allowRelease:false, retryInline:false }),
  });
  await processItem({}, ITEM, deps);
  assert.equal(transitions.at(-1).to, 'reconciling');
  assert.equal(transitions.at(-1).patch.provider_request_id, 'up-amb');
});

test('runWorkerTick领取后按concurrency受控并发处理', async () => {
  let active=0,max=0,done=0;
  const { deps } = makeDeps({
    claimItems: async () => Array.from({length:7},(_,i)=>({...ITEM,item_id:`gi-${i}`})),
    transitionItem: async (_pg,a) => ({item_id:a.itemId,status:a.to}),
    providerGenerate: async () => { active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;done++;return {status:'success',providerUrl:'x'}; },
  });
  const r = await runWorkerTick({}, { workerId:'w1', concurrency:3 }, deps);
  assert.equal(r.claimed,7);
  assert.equal(done,7);
  assert.ok(max<=3, `最大并发${max}`);
});
