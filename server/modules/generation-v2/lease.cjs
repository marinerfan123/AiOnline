'use strict';
const { isAllowedTransition } = require('./lease-guard.cjs');

const PATCH_FIELDS = new Set([
  'provider_id', 'key_id', 'provider_request_id', 'provider_url', 'oss_url',
  'last_error_code', 'last_error', 'next_attempt_at', 'started_at',
  'generated_at', 'uploaded_at', 'completed_at', 'lease_expires_at',
]);
const STATES = new Set([
  'queued', 'leased', 'generating', 'provider_accepted', 'reconciling',
  'generated', 'uploading', 'retry_wait', 'review_required',
  'done', 'failed', 'canceled',
  'reconcile_wait',
]);

async function claimItems(pg, { workerId, limit = 10, leaseSeconds = 120 } = {}) {
  if (!workerId) throw new TypeError('workerId is required');
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  const safeLease = Math.max(10, Math.min(900, Number(leaseSeconds) || 120));
  const result = await pg.query(
    `WITH picked AS (
       SELECT item_id
         FROM generation_items_v2
        WHERE status IN ('queued','retry_wait')
          AND mode='real'
          AND next_attempt_at <= NOW()
        ORDER BY priority DESC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE generation_items_v2 i
        SET status='leased', lease_owner=$2,
            lease_expires_at=NOW()+($3 * INTERVAL '1 second'),
            lease_version=i.lease_version+1,
            attempt_count=i.attempt_count+1
       FROM picked
      WHERE i.item_id=picked.item_id
      RETURNING i.*`,
    [safeLimit, workerId, safeLease],
  );
  return result.rows || [];
}

async function transitionItem(pg, { itemId, leaseVersion, workerId, from, to, patch = {} } = {}) {
  if (!itemId || !Number.isInteger(Number(leaseVersion))) throw new TypeError('itemId and leaseVersion are required');
  if (!STATES.has(from) || !STATES.has(to)) throw new TypeError('invalid state');
  if (!isAllowedTransition(from, to)) throw new TypeError(`illegal state transition: ${from}->${to}`);
  const entries = Object.entries(patch || {});
  for (const [field] of entries) {
    if (!PATCH_FIELDS.has(field)) throw new TypeError(`invalid patch field: ${field}`);
  }
  const params = [itemId, Number(leaseVersion), from, to, workerId || null];
  const sets = ['status=$4'];
  for (const [field, value] of entries) {
    params.push(value);
    sets.push(`${field}=$${params.length}`);
  }
  const result = await pg.query(
    `UPDATE generation_items_v2
        SET ${sets.join(', ')}
      WHERE item_id=$1 AND lease_version=$2 AND status=$3
        AND ($5::text IS NULL OR lease_owner=$5)
        AND lease_expires_at > NOW()
      RETURNING item_id,status,lease_version`,
    params,
  );
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

async function reapExpiredLeases(pg, { limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const result = await pg.query(
    `WITH expired AS (
       SELECT item_id
         FROM generation_items_v2
        WHERE status IN ('leased','generating')
          AND mode='real'
          AND lease_expires_at < NOW()
        ORDER BY lease_expires_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE generation_items_v2 i
        SET status=CASE WHEN i.status='generating' THEN 'reconciling' ELSE 'retry_wait' END,
            next_attempt_at=NOW(),
            lease_owner=NULL, lease_expires_at=NULL,
            lease_version=i.lease_version+1,
            last_error_code='LEASE_EXPIRED',
            last_error=CASE WHEN i.status='generating'
              THEN 'worker lease expired after provider submission; reconcile before retry'
              ELSE 'worker lease expired before provider submission; safe to retry' END
       FROM expired
      WHERE i.item_id=expired.item_id
      RETURNING i.item_id,i.status,i.lease_version`,
    [safeLimit],
  );
  return result.rows || [];
}

module.exports = { claimItems, transitionItem, reapExpiredLeases };
