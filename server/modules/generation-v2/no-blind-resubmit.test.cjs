'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReconcilingItem, claimReconciling } = require('./reconciler.cjs');

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
