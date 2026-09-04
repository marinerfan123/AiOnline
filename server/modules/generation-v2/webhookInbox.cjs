'use strict';
/**
 * Webhook Inbox — generation-v2 provider 状态回执的幂等异步队列。
 *
 * 契约（§57-60）：
 *   - webhook HTTP handler 只 verify→parse→dedupe(insertIfNew)→INSERT→2xx，不下载、不 reduce；
 *   - worker 经 claimNext→applyProviderEvent 异步 reduce（唯一状态入口，见 provider-status-router.cjs）。
 *
 * 四个原语全部幂等 + CAS：
 *   insertIfNew  — ON CONFLICT DO NOTHING（去重键 UNIQUE(provider_id, provider_event_id)）
 *   claimNext    — FOR UPDATE SKIP LOCKED + status='new'->'processing' 原子 CAS（并发双 claim 只一方得行）
 *   complete     — WHERE status IN ('new','processing')，重复调用 no-op
 *   fail         — WHERE status IN ('new','processing')，重复调用 no-op
 *
 * 租约：next_attempt_at 兼作 claim 租约（claimNext 时 = NOW()+leaseSeconds）；
 *       crash 后 stale processing 行（next_attempt_at <= NOW()）可被重领，attempts 递增。
 */

function _leaseSeconds(v) {
  return Math.max(10, Math.min(3600, Number(v) || 60));
}

/**
 * 幂等入箱：同 (provider_id, provider_event_id) 只插一次。
 * @returns {{ inserted: boolean, row: object|null }}
 */
async function insertIfNew(pg, { providerId, providerEventId, eventType, payload, signatureState } = {}) {
  if (!providerId || !providerEventId) throw new TypeError('providerId and providerEventId required');
  const r = await pg.query(
    `INSERT INTO webhook_inbox (provider_id, provider_event_id, event_type, payload, signature_state)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (provider_id, provider_event_id) DO NOTHING
     RETURNING id, provider_id, provider_event_id, event_type, payload, signature_state,
               status, attempts, next_attempt_at, created_at`,
    [providerId, providerEventId, eventType || '', payload ? JSON.stringify(payload) : '{}', signatureState || 'verified'],
  );
  const row = r.rows && r.rows[0] ? r.rows[0] : null;
  return { inserted: !!row, row };
}

/**
 * 领取一条待处理事件（new，或 lease 过期的 stale processing）。
 * SKIP LOCKED：并发双 claim 只一方成功，另一方拿到 null —— 单 reduce 的第一道闸。
 * @returns {object|null} inbox 行（含 payload），无可领时 null
 */
async function claimNext(pg, { workerId, leaseSeconds = 60 } = {}) {
  if (!workerId) throw new TypeError('workerId required');
  const s = _leaseSeconds(leaseSeconds);
  const r = await pg.query(
    `WITH picked AS (
       SELECT id FROM webhook_inbox
        WHERE status='new'
           OR (status='processing' AND next_attempt_at <= NOW())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE webhook_inbox w
        SET status='processing',
            attempts=w.attempts+1,
            next_attempt_at=NOW() + ($1::double precision * INTERVAL '1 second'),
            updated_at=NOW()
       FROM picked WHERE w.id=picked.id
     RETURNING w.id, w.provider_id, w.provider_event_id, w.event_type, w.payload,
               w.signature_state, w.status, w.attempts, w.next_attempt_at, w.created_at`,
    [s],
  );
  return (r.rows && r.rows[0]) || null;
}

/**
 * 标记 reduced（幂等：仅 processing/new → reduced）。
 * @returns {object|null}
 */
async function complete(pg, { id } = {}) {
  if (!id) throw new TypeError('id required');
  const r = await pg.query(
    `UPDATE webhook_inbox
        SET status='reduced', updated_at=NOW()
      WHERE id=$1 AND status IN ('new','processing')
     RETURNING id, status`,
    [id],
  );
  return (r.rows && r.rows[0]) || null;
}

/**
 * 标记 failed（幂等：仅 processing/new → failed）。
 * @returns {object|null}
 */
async function fail(pg, { id, errorCode, errorMessage } = {}) {
  if (!id) throw new TypeError('id required');
  const r = await pg.query(
    `UPDATE webhook_inbox
        SET status='failed', last_error=COALESCE($2::text, last_error), updated_at=NOW()
      WHERE id=$1 AND status IN ('new','processing')
     RETURNING id, status`,
    [id, errorCode || errorMessage || null],
  );
  return (r.rows && r.rows[0]) || null;
}

module.exports = { insertIfNew, claimNext, complete, fail };
