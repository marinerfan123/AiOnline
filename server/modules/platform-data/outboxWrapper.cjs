'use strict';
/**
 * W2-12 — Transactional outbox wrapper (platform-data).
 *
 * Release-critical events (project/shot/generation/asset/review/payment/reward) MUST be written to
 * the outbox in the SAME transaction as the business write, carrying retry state + idempotency_key
 * so duplicate delivery is a no-op. Call with the same `client` used for the business write.
 */

const OUTBOX_TABLE = 'event_outbox';

/**
 * Enqueue an event inside the caller's transaction. Duplicate idempotency_key is a no-op.
 * @returns {Promise<{id: string, idempotent: boolean}>}
 */
async function enqueueWithinTxn(client, { id, idempotencyKey, envelope }) {
  const r = await client.query(
    `INSERT INTO ${OUTBOX_TABLE} (id, idempotency_key, envelope)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [id, idempotencyKey, JSON.stringify(envelope)]
  );
  if (!r.rows.length) {
    const ex = await client.query(`SELECT id FROM ${OUTBOX_TABLE} WHERE idempotency_key = $1`, [idempotencyKey]);
    return { id: ex.rows[0].id, idempotent: true };
  }
  return { id: r.rows[0].id, idempotent: false };
}

/** Atomically claim up to `limit` ready events (pending/failed, due). Returns claimed rows. */
async function claimReady(client, { limit = 20, leaseOwner, leaseSeconds = 60 } = {}) {
  const r = await client.query(
    `UPDATE ${OUTBOX_TABLE}
     SET status = 'delivering', delivery_attempts = delivery_attempts + 1, updated_at = NOW()
     WHERE id IN (
       SELECT id FROM ${OUTBOX_TABLE}
       WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, envelope, delivery_attempts`,
    [limit]
  );
  return r.rows;
}

async function markDelivered(client, id) {
  await client.query(
    `UPDATE ${OUTBOX_TABLE} SET status='delivered', delivered_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [id]
  );
}

async function markFailed(client, { id, error, nextAttemptAt }) {
  await client.query(
    `UPDATE ${OUTBOX_TABLE}
     SET status='failed', last_error=$2, next_attempt_at=$3, updated_at=NOW()
     WHERE id=$1`,
    [id, String(error || '').slice(0, 500), nextAttemptAt ? new Date(nextAttemptAt) : new Date()]
  );
}

module.exports = { enqueueWithinTxn, claimReady, markDelivered, markFailed, OUTBOX_TABLE };
