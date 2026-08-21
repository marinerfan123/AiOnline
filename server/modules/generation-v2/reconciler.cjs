'use strict';
const lease = require('./lease.cjs');

async function claimReconciling(pg, { workerId, limit = 10, leaseSeconds = 300 } = {}) {
  if (!workerId) throw new TypeError('workerId required');
  const n = Math.max(1, Math.min(100, Number(limit) || 10));
  const s = Math.max(30, Math.min(3600, Number(leaseSeconds) || 300));
  const r = await pg.query(
    `WITH picked AS (
       SELECT item_id FROM generation_items_v2
        WHERE status='reconciling'
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY updated_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE generation_items_v2 i
        SET lease_owner=$2, lease_expires_at=NOW()+($3*INTERVAL '1 second'),
            lease_version=i.lease_version+1
       FROM picked WHERE i.item_id=picked.item_id
     RETURNING i.*`,
    [n, workerId, s]);
  return r.rows || [];
}

async function resolveReconcilingItem(pg, item, injected = {}) {
  const deps = { transitionItem: lease.transitionItem, queryProviderStatus: null, ...injected };
  if (typeof deps.queryProviderStatus !== 'function') throw new TypeError('queryProviderStatus required');
  const base = { itemId: item.item_id, leaseVersion: Number(item.lease_version) };
  let providerResult;
  try {
    providerResult = await deps.queryProviderStatus(item.provider_request_id, item);
  } catch (e) {
    providerResult = { status: 'unknown', error: e.message };
  }
  if (providerResult.status === 'success' && providerResult.providerUrl) {
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'generated',
      patch: { provider_url: providerResult.providerUrl, provider_request_id: item.provider_request_id, lease_expires_at: null },
    });
    return row ? { status: 'generated' } : { status: 'stale_lease' };
  }
  if (providerResult.status === 'failed') {
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'retry_wait',
      patch: { last_error_code: 'PROVIDER_FAILED', last_error: providerResult.error || 'provider reported failure', next_attempt_at: new Date(Date.now() + 30000), lease_expires_at: null },
    });
    return row ? { status: 'retry_wait' } : { status: 'stale_lease' };
  }
  if (providerResult.status === 'pending') {
    const row = await deps.transitionItem(pg, {
      ...base, from: 'reconciling', to: 'retry_wait',
      patch: { last_error_code: 'PROVIDER_PENDING', last_error: 'still processing', next_attempt_at: new Date(Date.now() + 15000), lease_expires_at: null },
    });
    return row ? { status: 'retry_wait' } : { status: 'stale_lease' };
  }
  // unknown/ambiguous: freeze for human review, do NOT release funds
  const row = await deps.transitionItem(pg, {
    ...base, from: 'reconciling', to: 'review_required',
    patch: { last_error_code: 'RECONCILE_UNKNOWN', last_error: providerResult.error || 'provider status unknown', lease_expires_at: null },
  });
  return row ? { status: 'review_required' } : { status: 'stale_lease' };
}

async function publishOutbox(pg, { limit = 100, workerId = `outbox-${process.pid}`, leaseSeconds = 60 } = {}, injected = {}) {
  const deps = { publish: null, ...injected };
  if (typeof deps.publish !== 'function') throw new TypeError('publish function required');
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const r = await pg.query(
    `WITH picked AS (
       SELECT event_id FROM generation_outbox_v2
        WHERE published_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE generation_outbox_v2 o
        SET lease_owner=$2,lease_expires_at=NOW()+($3*INTERVAL '1 second')
       FROM picked WHERE o.event_id=picked.event_id
     RETURNING o.event_id,o.aggregate_id,o.aggregate_type,o.event_type,o.payload,o.created_at`,
    [n,workerId,Math.max(10,Math.min(600,Number(leaseSeconds)||60))]);
  const events = r.rows || [];
  if (!events.length) return { published: 0 };
  let published = 0;
  const delivered = [];
  for (const ev of events) {
    try {
      let payload = ev.payload;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) {} }
      await deps.publish({ ...ev, payload });
      delivered.push(ev.event_id);
      published++;
    } catch (_) { /* leave undelivered; will retry next tick */ }
  }
  if (delivered.length) await markOutboxDelivered(pg, delivered);
  return { published };
}

async function markOutboxDelivered(pg, ids) {
  if (!ids || !ids.length) return { count: 0 };
  const r = await pg.query(
    `UPDATE generation_outbox_v2 SET published_at=NOW(), attempts=attempts+1,lease_owner=NULL,lease_expires_at=NULL
      WHERE event_id=ANY($1::bigint[]) AND published_at IS NULL
      RETURNING event_id`, [ids]);
  return { count: (r.rows || []).length };
}

module.exports = { claimReconciling, resolveReconcilingItem, publishOutbox, markOutboxDelivered };
