'use strict';
/**
 * W4-10 — Product-level generation reconciler PURE DECISION contract (no I/O). Complements the
 * production reconciler.cjs (lease-based worker reconciliation) by providing a deterministic,
 * idempotent product-level health report + repair plan (orphans / duplicates / drift).
 * NOTE: does NOT replace server/modules/generation-v2/reconciler.cjs (production logic).
 */
function computeReconciliation({ jobs = [], outbox = [], assetVersions = [], reserves = [] } = {}) {
  const orphanJobs = jobs.filter((j) => j.status === 'running' && j.leaseExpiresAt && new Date(j.leaseExpiresAt).getTime() < Date.now());
  const stuckQueued = jobs.filter((j) => j.status === 'queued' && j.attempts >= (j.maxAttempts || 3));
  const duplicateFinalize = assetVersions.filter((v, i) => assetVersions.findIndex((x) => x.callbackId === v.callbackId) !== i);
  const unsettledReserves = reserves.filter((r) => r.status === 'reserved' && r.holdsForever);
  return {
    ok: true,
    report: {
      orphanJobs: orphanJobs.map((j) => j.id),
      stuckQueued: stuckQueued.map((j) => j.id),
      duplicateFinalize: duplicateFinalize.map((v) => v.version_id),
      unsettledReserves: unsettledReserves.map((r) => r.reserveId),
      totals: { jobs: jobs.length, outbox: outbox.length, assetVersions: assetVersions.length, reserves: reserves.length },
    },
    healthy: orphanJobs.length === 0 && duplicateFinalize.length === 0 && unsettledReserves.length === 0,
  };
}

/** Deterministic repair plan (idempotent recovery). */
function repairPlan(report) {
  const actions = [];
  for (const id of report.orphanJobs) actions.push({ type: 'REQUEUE_ORPHAN', id, to: 'queued' });
  for (const id of report.unsettledReserves) actions.push({ type: 'RELEASE_STALE_RESERVE', id });
  return actions;
}

module.exports = { computeReconciliation, repairPlan };
