'use strict';
const crypto = require('crypto');

function normalizeCount(contentType, count) {
  return contentType === 'video' ? 1 : Math.max(1, Math.min(4, Number(count) || 1));
}

/**
 * V2 影子接单核心：单事务建立 batch + N items + 每 item hold + outbox。
 * 当前模块尚未挂到 /api/generate，先以测试锁定幂等和事务边界。
 */
async function createBatchWithItems(pg, input) {
  if (!pg || (typeof pg.query !== 'function' && typeof pg.connect !== 'function')) {
    throw new TypeError('pg.query or pg.connect is required');
  }
  const ownClient = typeof pg.connect === 'function';
  const db = ownClient ? await pg.connect() : pg;
  const {
    batchId, userId, idempotencyKey, modelId,
    contentType = 'image', unitPrice = 0, pool = 'recharge', requestPayload = {},
  } = input || {};
  if (!batchId || !userId || !idempotencyKey || !modelId) throw new TypeError('batchId/userId/idempotencyKey/modelId are required');
  const count = normalizeCount(contentType, input.count);
  const price = Number(unitPrice) || 0;
  if (price < 0) throw new RangeError('unitPrice must be >= 0');
  if (!['reward', 'recharge'].includes(pool)) throw new TypeError('invalid pool');

  try {
    await db.query('BEGIN');
    try {
    const existing = await db.query(
      `SELECT batch_id, requested_count FROM generation_batches_v2
        WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [userId, idempotencyKey],
    );
    if (existing.rows && existing.rows.length) {
      await db.query('COMMIT');
      return {
        batchId: existing.rows[0].batch_id,
        count: Number(existing.rows[0].requested_count),
        idempotent: true,
      };
    }

    await db.query(
      `INSERT INTO generation_batches_v2
        (batch_id,user_id,idempotency_key,model_id,content_type,requested_count,unit_price,reserved_total,request_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [batchId, userId, idempotencyKey, modelId, contentType, count, price, price * count, JSON.stringify(requestPayload || {})],
    );

    const items = Array.from({ length: count }, (_, i) => ({
      itemId: `gi-${crypto.randomUUID()}`, index: i,
    }));
    const itemParams = items.flatMap((x) => [x.itemId, batchId, x.index]);
    const itemRows = items.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(',');
    await db.query(
      `INSERT INTO generation_items_v2 (item_id,batch_id,item_index) VALUES ${itemRows}`,
      itemParams,
    );

    const holdParams = items.flatMap((x) => [x.itemId, userId, pool, price]);
    const holdRows = items.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`).join(',');
    await db.query(
      `INSERT INTO generation_credit_holds_v2 (item_id,user_id,pool,amount) VALUES ${holdRows}`,
      holdParams,
    );

    await db.query(
      `INSERT INTO generation_outbox_v2 (aggregate_type,aggregate_id,event_type,payload)
       VALUES ('generation_batch',$1,'generation.batch.accepted',$2)`,
      [batchId, JSON.stringify({ batchId, userId, count })],
    );
    await db.query('COMMIT');
      return { batchId, count, idempotent: false };
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    }
  } finally {
    if (ownClient && typeof db.release === 'function') db.release();
  }
}

module.exports = { normalizeCount, createBatchWithItems };
