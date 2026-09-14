'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeReconciliation, repairPlan } = require('./productReconciler.cjs');
test('detects orphan jobs + duplicate finalize + stale reserve', () => {
  const r = computeReconciliation({
    jobs: [{ id: 'j1', status: 'running', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }],
    assetVersions: [{ version_id: 'v1', callbackId: 'cb1' }, { version_id: 'v2', callbackId: 'cb1' }],
    reserves: [{ reserveId: 'r1', status: 'reserved', holdsForever: true }],
  });
  assert.deepEqual(r.report.orphanJobs, ['j1']);
  assert.deepEqual(r.report.duplicateFinalize, ['v2']);
  assert.deepEqual(r.report.unsettledReserves, ['r1']);
  assert.equal(r.healthy, false);
});
test('healthy when no orphans/duplicates', () => {
  const r = computeReconciliation({ jobs: [{ id: 'j1', status: 'done' }], assetVersions: [{ version_id: 'v1', callbackId: 'cb1' }], reserves: [{ reserveId: 'r1', status: 'settled' }] });
  assert.equal(r.healthy, true);
});
test('repairPlan: requeue orphan + release stale reserve', () => {
  const plan = repairPlan({ orphanJobs: ['j1'], unsettledReserves: ['r1'] });
  assert.deepEqual(plan[0], { type: 'REQUEUE_ORPHAN', id: 'j1', to: 'queued' });
  assert.deepEqual(plan[1], { type: 'RELEASE_STALE_RESERVE', id: 'r1' });
});
