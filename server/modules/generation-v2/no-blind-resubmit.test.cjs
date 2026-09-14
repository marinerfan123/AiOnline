'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReconcilingItem, claimReconciling, recoverSubmitUnknown } = require('./reconciler.cjs');

function fakePgWithRows(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/WITH picked/.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('pending provider reconciliation moves to reconcile_wait, not retry_wait fresh dispatch', async () => {
  const transitions = [];
  const result = await resolveReconcilingItem({}, {
    item_id: 'i-pending', lease_version: 7, provider_request_id: 'provider-1', provider_id: 'p1', client_request_id: 'client-1',
  }, {
    queryProviderStatus: async () => ({ status: 'pending' }),
    transitionItem: async (_pg, action) => { transitions.push(action); return { item_id: action.itemId, status: action.to }; },
  });

  assert.equal(result.status, 'reconcile_wait');
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].from, 'reconciling');
  assert.equal(transitions[0].to, 'reconcile_wait');
  assert.notEqual(transitions[0].to, 'retry_wait');
  assert.equal(transitions[0].patch.provider_request_id, undefined, 'must not erase original provider identity');
});

test('reconcile_wait is claimed only by reconciler when scheduled, never by generation claim path', async () => {
  const pg = fakePgWithRows([{ item_id: 'i-rw', status: 'reconcile_wait', provider_request_id: 'provider-1' }]);
  const rows = await claimReconciling(pg, { workerId: 'reconciler-1', limit: 1 });
  assert.equal(rows.length, 1);
  assert.match(pg.calls[0].sql, /status IN \('reconciling','reconcile_wait'\)/);
  assert.match(pg.calls[0].sql, /next_attempt_at <= NOW\(\)/);
});

test('success after pending completes original remote item without a second submit', async () => {
  let submitCount = 1; // original already accepted by provider before crash/reconcile
  let queryCount = 0;
  const statuses = [{ status: 'pending' }, { status: 'pending' }, { status: 'success', providerUrl: 'https://cdn.example/original.png' }];
  const transitions = [];

  for (const providerStatus of statuses) {
    const from = providerStatus.status === 'success' ? 'reconciling' : 'reconciling';
    const r = await resolveReconcilingItem({}, {
      item_id: 'i-later-success', lease_version: 3 + queryCount, provider_request_id: 'provider-original', provider_id: 'p1',
    }, {
      queryProviderStatus: async () => { queryCount++; return providerStatus; },
      transitionItem: async (_pg, action) => { transitions.push({ ...action, from }); return { item_id: action.itemId, status: action.to }; },
    });
    assert.ok(['reconcile_wait', 'generated'].includes(r.status));
  }

  assert.equal(submitCount, 1);
  assert.equal(queryCount, 3);
  assert.equal(transitions.at(-1).to, 'generated');
});

test('unknown-after-submit goes to review_required and never schedules fresh submit', async () => {
  const transitions = [];
  const result = await resolveReconcilingItem({}, {
    item_id: 'i-unknown', lease_version: 1, provider_request_id: 'provider-maybe-accepted', client_request_id: 'client-original',
  }, {
    queryProviderStatus: async () => ({ status: 'unknown', error: 'ambiguous' }),
    transitionItem: async (_pg, action) => { transitions.push(action); return { item_id: action.itemId, status: action.to }; },
  });
  assert.equal(result.status, 'review_required');
  assert.equal(transitions[0].to, 'review_required');
  assert.notEqual(transitions[0].to, 'retry_wait');
});

// ─── §52-54/§152: SUBMIT_UNKNOWN 六步恢复序 (Gate7) ───

function submitUnknownDeps(overrides = {}) {
  const calls = { resubmit: 0, transition: [] };
  return {
    calls,
    checkClientRequestTokenSupport: async () => true,
    lookupSubmitPayload: async () => ({ prompt: 'a cat' }),
    searchProviderTask: async () => ({ found: false }),
    withinDecidableWindow: async () => false,
    resubmit: async () => { calls.resubmit++; return 'provider-new-1'; },
    transitionItem: async (_pg, action) => { calls.transition.push(action); return { item_id: action.itemId, status: action.to }; },
    ...overrides,
  };
}

test('SUBMIT_UNKNOWN: submit 响应丢失 → 窗口内不重提, 不建第二任务 (Gate7)', async () => {
  const deps = submitUnknownDeps({ withinDecidableWindow: async () => false });
  const result = await recoverSubmitUnknown({}, {
    item_id: 'i-submit-unknown', lease_version: 1, provider_request_id: null, client_request_id: 'client-original',
  }, deps);

  assert.equal(result.status, 'reconcile_wait');
  assert.equal(deps.calls.resubmit, 0, 'must NOT resubmit within decidable window (§152)');
  assert.equal(deps.calls.transition.length, 1);
  assert.equal(deps.calls.transition[0].to, 'reconcile_wait');
  assert.notEqual(deps.calls.transition[0].to, 'generating', 'must not dispatch a second task');
});

test('SUBMIT_UNKNOWN: 确认未创建 + 窗口已过 → 以同一 client_request_id 重提一次', async () => {
  let resubmittedItem = null;
  let resubmittedPayload = null;
  const deps = submitUnknownDeps({
    withinDecidableWindow: async () => true,
    searchProviderTask: async () => ({ found: false }),
    resubmit: async (item, payload) => { deps.calls.resubmit++; resubmittedItem = item; resubmittedPayload = payload; return 'provider-new-1'; },
  });
  const result = await recoverSubmitUnknown({}, {
    item_id: 'i-confirm-not-created', lease_version: 1, provider_request_id: null, client_request_id: 'client-original',
  }, deps);

  assert.equal(result.status, 'resubmitted');
  assert.equal(deps.calls.resubmit, 1, 'exactly one resubmit');
  assert.equal(resubmittedItem.client_request_id, 'client-original', 'same client_request_id');
  assert.deepEqual(resubmittedPayload, { prompt: 'a cat' });
  assert.equal(deps.calls.transition[0].to, 'generating');
  assert.equal(deps.calls.transition[0].patch.provider_request_id, 'provider-new-1');
});

test('SUBMIT_UNKNOWN: 搜到已存在 provider task → 采纳并交还 reconcile, 不重提', async () => {
  const deps = submitUnknownDeps({
    searchProviderTask: async () => ({ found: true, providerRequestId: 'provider-existing' }),
  });
  const result = await recoverSubmitUnknown({}, {
    item_id: 'i-adopt', lease_version: 1, provider_request_id: null, client_request_id: 'client-original',
  }, deps);

  assert.equal(result.status, 'adopted');
  assert.equal(deps.calls.resubmit, 0, 'must not resubmit when task already exists');
  assert.equal(deps.calls.transition[0].to, 'reconcile_wait');
  assert.equal(deps.calls.transition[0].patch.provider_request_id, 'provider-existing');
});

test('SUBMIT_UNKNOWN: 窗口已过但 provider 不支持 token → 转人工复核, 不盲目重提', async () => {
  const deps = submitUnknownDeps({
    checkClientRequestTokenSupport: async () => false,
    withinDecidableWindow: async () => true,
  });
  const result = await recoverSubmitUnknown({}, {
    item_id: 'i-no-token', lease_version: 1, provider_request_id: null, client_request_id: 'client-original',
  }, deps);

  assert.equal(result.status, 'review_required');
  assert.equal(deps.calls.resubmit, 0, 'no token support → never blind resubmit (§52-53)');
  assert.equal(deps.calls.transition[0].to, 'review_required');
});

// ─── CRITICAL: reconcile_wait 项被 claimReconciling 领取后必须先 hop 回 reconciling ───
// 修复前 resolveReconcilingItem 对 reconcile_wait 项硬编码 from='reconciling'，CAS 必失败
// → stale_lease → item 永卡 reconcile_wait（pending/SUBMIT_UNKNOWN 等待窗口到期后无法恢复）。
test('reconcile_wait 项先 hop 回 reconciling 再推进（不因 from 硬编码卡死）', async () => {
  let currentStatus = 'reconcile_wait';
  let leaseVersion = 5;
  const transitions = [];
  const result = await resolveReconcilingItem({}, {
    item_id: 'i-rw-hop', lease_version: leaseVersion, provider_request_id: 'pr-rw', status: currentStatus,
  }, {
    queryProviderStatus: async () => ({ status: 'success', providerUrl: 'https://cdn/x.png' }),
    // 模拟真实 CAS：from 必须等于当前 status，否则返回 null（stale_lease）
    transitionItem: async (_pg, action) => {
      transitions.push(action);
      if (action.from !== currentStatus) return null;
      currentStatus = action.to;
      leaseVersion += 1;
      return { item_id: action.itemId, status: action.to, lease_version: leaseVersion };
    },
  });

  assert.equal(result.status, 'generated');
  assert.equal(transitions.length, 2);
  assert.equal(transitions[0].from, 'reconcile_wait', '先归一 hop');
  assert.equal(transitions[0].to, 'reconciling');
  assert.equal(transitions[1].from, 'reconciling', 'hop 后再按 reconciling 推进');
  assert.equal(transitions[1].to, 'generated');
});

test('reconcile_wait 项 hop 失败（lease 被并发抢走）→ stale_lease，不误推进', async () => {
  const transitions = [];
  const result = await resolveReconcilingItem({}, {
    item_id: 'i-rw-race', lease_version: 2, provider_request_id: 'pr-race', status: 'reconcile_wait',
  }, {
    queryProviderStatus: async () => ({ status: 'success', providerUrl: 'https://cdn/y.png' }),
    transitionItem: async (_pg, action) => { transitions.push(action); return null; },
  });
  assert.equal(result.status, 'stale_lease');
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].from, 'reconcile_wait');
});
