'use strict';
const crypto = require('crypto');

function normalizeCount(contentType, count) {
  return contentType === 'video' ? 1 : Math.max(1, Math.min(4, Number(count) || 1));
}

function normalizeMoney(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(text)) {
    if (/^\d+\.\d{5,}$/.test(text)) throw new TypeError('unitPrice supports at most 4 decimal places');
    throw new TypeError('unitPrice must be a finite non-negative decimal');
  }
  const [whole, fraction = ''] = text.split('.');
  const units = BigInt(whole) * 10000n + BigInt((fraction + '0000').slice(0, 4));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('unitPrice too large');
  return Number(units);
}

function moneyUnitsToDecimal(units) {
  const n = BigInt(units);
  return `${n / 10000n}.${String(n % 10000n).padStart(4, '0')}`;
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
    contentType = 'image', unitPrice = 0, pool = 'recharge', requestPayload = {}, mode = 'real',
  } = input || {};
  if (!batchId || !userId || !idempotencyKey || !modelId) throw new TypeError('batchId/userId/idempotencyKey/modelId are required');
  const count = normalizeCount(contentType, input.count);
  const priceUnits = normalizeMoney(unitPrice);
  const price = moneyUnitsToDecimal(priceUnits);
  const total = moneyUnitsToDecimal(priceUnits * count);
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

    const inserted = await db.query(
      `INSERT INTO generation_batches_v2
        (batch_id,user_id,idempotency_key,model_id,content_type,requested_count,unit_price,reserved_total,request_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id,idempotency_key) DO NOTHING
       RETURNING batch_id`,
      [batchId, userId, idempotencyKey, modelId, contentType, count, price, total, JSON.stringify(requestPayload || {})],
    );
    if (!inserted.rowCount) {
      const winner = await db.query(
        `SELECT batch_id,requested_count,model_id,content_type,unit_price
           FROM generation_batches_v2 WHERE user_id=$1 AND idempotency_key=$2`,
        [userId,idempotencyKey],
      );
      const row = winner.rows && winner.rows[0];
      if (!row) throw new Error('idempotency winner missing after conflict');
      if (row.model_id !== modelId || Number(row.requested_count) !== count || row.content_type !== contentType || normalizeMoney(row.unit_price) !== priceUnits) {
        throw new Error('idempotency key reused with different generation parameters');
      }
      await db.query('COMMIT');
      return { batchId:row.batch_id,count:Number(row.requested_count),idempotent:true };
    }

    const items = Array.from({ length: count }, (_, i) => ({
      itemId: `gi-${crypto.randomUUID()}`, index: i,
    }));
    const itemParams = items.flatMap((x) => [x.itemId, batchId, x.index, mode]);
    const itemRows = items.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`).join(',');
    await db.query(
      `INSERT INTO generation_items_v2 (item_id,batch_id,item_index,mode) VALUES ${itemRows}`,
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

module.exports = { normalizeCount, normalizeMoney, moneyUnitsToDecimal, createBatchWithItems };
