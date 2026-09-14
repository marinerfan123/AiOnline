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

// ---- Activity lease (L10: EXTEND lease mechanism to generation_activity_runs / 0060) ----
// 8 activity types (§42). Activity-level lifecycle is separate from
// generation_items_v2.status:
//   pending -> running -> succeeded
//                    \-> waiting_retry -> (re-claimed) running
//                    \-> failed (terminal once attempt_count >= maxAttempts)
// lease_owner / lease_expires_at / heartbeat_at fence every write (§51):
// claim/adopt CAS the lease; every later write goes through WHERE lease_owner=$me.
const ACTIVITY_TYPES = Object.freeze([
  'PREPARE_ASSETS', 'ACQUIRE_QUOTA', 'SUBMIT_PROVIDER', 'OBSERVE_PROVIDER',
  'FETCH_OUTPUT', 'VERIFY_OUTPUT', 'FINALIZE_ASSETS', 'SETTLE_BILLING',
]);
const ACTIVITY_ACTIVE_STATUSES = new Set(['pending', 'waiting_retry', 'running']);

function _activityLeaseSeconds(leaseSeconds) {
  return Math.max(10, Math.min(900, Number(leaseSeconds) || 120));
}
function _activityLimit(limit) {
  return Math.max(1, Math.min(100, Number(limit) || 10));
}

// Claim fresh activities: pending/waiting_retry whose lease is free (NULL) or
// expired, and whose retry time has arrived. CAS lease_owner/lease_expires_at/
// heartbeat_at and bump attempt_count (each claim == one execution attempt).
async function claimActivity(pg, { workerId, limit = 10, leaseSeconds = 120 } = {}) {
  if (!workerId) throw new TypeError('workerId is required');
  const safeLimit = _activityLimit(limit);
  const safeLease = _activityLeaseSeconds(leaseSeconds);
  const result = await pg.query(
    `WITH picked AS (
       SELECT id FROM generation_activity_runs
        WHERE status IN ('pending','waiting_retry')
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
          AND next_retry_at <= NOW()
        ORDER BY next_retry_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE generation_activity_runs a
        SET status='running', lease_owner=$2,
            lease_expires_at=NOW()+($3 * INTERVAL '1 second'),
            heartbeat_at=NOW(),
            attempt_count=a.attempt_count+1,
            started_at=COALESCE(a.started_at, NOW())
       FROM picked
      WHERE a.id=picked.id
      RETURNING a.*`,
    [safeLimit, workerId, safeLease],
  );
  return result.rows || [];
}

// Adopt activities whose lease expired (worker crash -> another worker takes
// over, §51). Includes 'running' so a crashed worker's in-flight activity is
// re-run by the new owner instead of being stranded forever.
async function adoptActivity(pg, { workerId, limit = 10, leaseSeconds = 120 } = {}) {
  if (!workerId) throw new TypeError('workerId is required');
  const safeLimit = _activityLimit(limit);
  const safeLease = _activityLeaseSeconds(leaseSeconds);
  const result = await pg.query(
    `WITH picked AS (
       SELECT id FROM generation_activity_runs
        WHERE status IN ('pending','waiting_retry','running')
          AND lease_expires_at < NOW()
        ORDER BY lease_expires_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE generation_activity_runs a
        SET status='running', lease_owner=$2,
            lease_expires_at=NOW()+($3 * INTERVAL '1 second'),
            heartbeat_at=NOW(),
            attempt_count=a.attempt_count+1
       FROM picked
      WHERE a.id=picked.id
      RETURNING a.*`,
    [safeLimit, workerId, safeLease],
  );
  return result.rows || [];
}

// Heartbeat: renew lease + heartbeat_at only while we still own it and it has
// not expired. Returns null once another worker has adopted (fencing).
async function renewActivityLease(pg, { id, workerId, leaseSeconds = 120 } = {}) {
  if (!id || !workerId) throw new TypeError('id and workerId are required');
  const sec = _activityLeaseSeconds(leaseSeconds);
  const result = await pg.query(
    `UPDATE generation_activity_runs
        SET lease_expires_at=NOW()+($3 * INTERVAL '1 second'), heartbeat_at=NOW()
      WHERE id=$1 AND lease_owner=$2
        AND status IN ('pending','waiting_retry','running')
        AND lease_expires_at > NOW()
      RETURNING id, lease_owner, lease_expires_at, heartbeat_at`,
    [id, workerId, sec],
  );
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

// Fencing (§51): only the current lease owner may write. complete/fail both go
// through WHERE id AND lease_owner=$me, so a stale owner's write is a no-op once
// the row has been adopted by someone else (no double-run, no double-settle).
async function completeActivity(pg, { id, workerId } = {}) {
  if (!id || !workerId) throw new TypeError('id and workerId are required');
  // 0060 CHECK 词表的终态成功是 'succeeded'（非 'done'）；写 'done' 会撞
  // generation_activity_runs_status_check 约束（23514），activity 永远无法完成。
  const result = await pg.query(
    `UPDATE generation_activity_runs
        SET status='succeeded', completed_at=NOW(), lease_owner=NULL, lease_expires_at=NULL
      WHERE id=$1 AND lease_owner=$2
        AND status IN ('pending','waiting_retry','running')
      RETURNING id, status, attempt_count`,
    [id, workerId],
  );
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

async function failActivity(pg, { id, workerId, status = 'waiting_retry', errorCode = null, nextRetryAt = null } = {}) {
  if (!id || !workerId) throw new TypeError('id and workerId are required');
  if (status !== 'waiting_retry' && status !== 'failed') throw new TypeError('invalid terminal status');
  const result = await pg.query(
    `UPDATE generation_activity_runs
        SET status=$3, error_code=$4,
            next_retry_at=COALESCE($5::timestamptz, NOW()),
            lease_owner=NULL, lease_expires_at=NULL
      WHERE id=$1 AND lease_owner=$2
        AND status IN ('pending','waiting_retry','running')
      RETURNING id, status, attempt_count`,
    [id, workerId, status, errorCode, nextRetryAt],
  );
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

module.exports = {
  claimItems, transitionItem, reapExpiredLeases,
  ACTIVITY_TYPES, ACTIVITY_ACTIVE_STATUSES,
  claimActivity, adoptActivity, renewActivityLease, completeActivity, failActivity,
};
