'use strict';
/**
 * waiting-area-v2.cjs
 *
 * Bridge between the legacy in-memory WAITING_AREA (dispatcher.cjs)
 * and the durable PostgreSQL V2 queue (generation_items_v2).
 *
 * When dispatchOne returns 'throttled' (all resources unavailable),
 * instead of enqueuing into process-memory WAITING_AREA, we insert
 * a low-priority item into generation_items_v2. The existing V2 worker
 * tick loop (claimItems -> processItem) will naturally pick it up,
 * retrying with proper lease fencing and restart recovery.
 *
 * This eliminates the last dependency of queue correctness on process memory.
 */

const crypto = require('crypto');

// Priority for waiting-area tasks (lower than normal real tasks)
const WAITING_PRIORITY = -100;

// Max retry attempts before giving up
const MAX_WAITING_RETRIES = 10;

// Max wait time before marking as 'waiting'
const MAX_WAIT_MS = 90 * 60 * 1000;

/**
 * Enqueue a throttled task into the V2 queue as a low-priority item.
 * Creates a minimal batch wrapper so the item can be claimed by the worker.
 *
 * @param {object} pg - PostgreSQL connection or pool
 * @param {object} opts - Task options
 * @returns {object|null} { itemId, batchId } or null on failure
 */
async function enqueueToV2Queue(pg, opts) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('pg is required');
  }
  if (!opts || !opts.taskId || !opts.userId || !opts.model) {
    throw new TypeError('opts.taskId, opts.userId, opts.model are required');
  }

  const batchId = `wb-wait-${crypto.randomUUID()}`;
  const itemId = `gi-wait-${crypto.randomUUID()}`;
  const idempotencyKey = `wait-${opts.taskId}-${Date.now()}`;
  const contentType = opts.contentType || 'image';

  try {
    await pg.query('BEGIN');
    try {
      // Insert batch
      await pg.query(
        `INSERT INTO generation_batches_v2
          (batch_id, user_id, idempotency_key, model_id, content_type, requested_count,
           unit_price, reserved_total, status, request_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          batchId,
          opts.userId,
          idempotencyKey,
          opts.model,
          contentType,
          opts.count || 1,
          0,
          0,
          'accepted',
          JSON.stringify({
            taskId: opts.taskId,
            prompt: opts.prompt || '',
            ratio: opts.ratio || '1:1',
            cost: opts.cost || 0,
            costPool: opts.costPool || 'recharge',
            idempotencyKey: opts.idempotencyKey || '',
            userPlan: opts.userPlan || 'free',
            pendingIds: opts.pendingIds || [],
            contentType: contentType,
          }),
        ],
      );

      // Insert item (no retry_count column; use attempt_count)
      const nextAttemptAt = new Date(Date.now() + 15000);
      await pg.query(
        `INSERT INTO generation_items_v2
          (item_id, batch_id, item_index, status, mode, priority, attempt_count,
           next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [itemId, batchId, 0, 'queued', 'real', WAITING_PRIORITY, 0, nextAttemptAt],
      );

      await pg.query('COMMIT');
      return { itemId, batchId };
    } catch (e) {
      await pg.query('ROLLBACK').catch(() => {});
      throw e;
    }
  } catch (e) {
    console.warn(`[waiting-v2] enqueue failed: ${e.message}`);
    return null;
  }
}

/**
 * Count waiting-area items that are ready to be claimed.
 */
async function countWaitingItems(pg) {
  if (!pg || typeof pg.query !== 'function') return 0;
  try {
    const r = await pg.query(
      `SELECT COUNT(*)::int AS n FROM generation_items_v2
       WHERE status IN ('queued', 'retry_wait')
         AND priority < 0
         AND mode = 'real'
         AND next_attempt_at <= NOW()`,
    );
    return r.rows[0] && r.rows[0].n ? Number(r.rows[0].n) : 0;
  } catch (e) {
    console.warn(`[waiting-v2] count failed: ${e.message}`);
    return 0;
  }
}

/**
 * Recover orphaned waiting-area tasks after restart.
 * Moves tasks from in-memory WAITING_AREA into the V2 queue.
 */
async function recoverWaitingArea(pg, dispatcherModule) {
  if (!pg || !dispatcherModule) {
    return { recovered: 0, enqueued: 0 };
  }

  const results = { recovered: 0, enqueued: 0 };

  try {
    const waitingSize = dispatcherModule.waitingAreaSize
      ? dispatcherModule.waitingAreaSize()
      : 0;
    if (waitingSize === 0) return results;

    const status = dispatcherModule.getWaitingAreaStatus
      ? dispatcherModule.getWaitingAreaStatus()
      : null;

    if (status && status.tasks) {
      for (const task of status.tasks) {
        results.recovered++;
        const envelope = await enqueueToV2Queue(pg, task);
        if (envelope) {
          results.enqueued++;
          if (dispatcherModule.dequeueWaiting) {
            dispatcherModule.dequeueWaiting(task.taskId);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[waiting-v2] recovery failed: ${e.message}`);
  }

  return results;
}

module.exports = {
  enqueueToV2Queue,
  countWaitingItems,
  recoverWaitingArea,
  WAITING_PRIORITY,
  MAX_WAITING_RETRIES,
  MAX_WAIT_MS,
};
