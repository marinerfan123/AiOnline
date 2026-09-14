'use strict';

async function tx(pg, fn) {
  const own = typeof pg.connect === 'function';
  const client = own ? await pg.connect() : pg;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (own && client.release) client.release();
  }
}

async function settleHold(pg, { itemId, action } = {}) {
  if (!itemId) throw new TypeError('itemId is required');
  if (!['commit', 'release'].includes(action)) throw new TypeError('action must be commit or release');
  const target = action === 'commit' ? 'committed' : 'released';
  const result = await pg.query(
    `UPDATE generation_credit_holds_v2
        SET status=$2, settled_at=NOW()
      WHERE item_id=$1 AND status='held'
      RETURNING hold_id,item_id,user_id,pool,amount,status`,
    [itemId, target],
  );
  const hold = result.rows && result.rows[0] ? result.rows[0] : null;
  return { changed: !!hold, hold };
}

/**
 * §90 Ledger 幂等 settle 键 = attempt_id（settle:{attempt_id} / release:{attempt_id}）。
 *
 * 与 settleHold（item_id CAS）互补：
 *   - hold 物理 CAS 仍按 item_id（1:1 item）——held→committed/released；
 *   - 账务 settle 行按 attempt_id 记 ref，`ON CONFLICT (ref, kind) DO NOTHING`
 *     保证同一 attempt 的 webhook/worker 重放不会重复 settle（§90）。
 *
 * commit 行记录 actual_amount（provider 实际计费 / pricing.cjs calculate）与
 * user_charge_amount（最终扣用户）；release 行退 user_charge 部分回余额。
 *
 * @param {object} pg   Pool 或 client
 * @param {object} args
 * @param {string} args.itemId    hold 的 item_id（物理 CAS 键）
 * @param {number|string} args.attemptId  账务 settle 幂等键（§90 settle:{attempt_id}）
 * @param {'commit'|'release'} args.action
 * @param {number} [args.userCharge] 最终扣用户金额（缺省 = hold.amount）
 * @param {number} [args.actual]     provider 实际计费（缺省 = userCharge）
 * @returns {Promise<{changed:boolean, hold:object|null}>}
 */
async function settleByAttempt(pg, { itemId, attemptId, action, userCharge, actual } = {}) {
  if (!itemId || attemptId == null) throw new TypeError('settleByAttempt: itemId and attemptId are required');
  if (!['commit', 'release'].includes(action)) throw new TypeError('action must be commit or release');
  const target = action === 'commit' ? 'committed' : 'released';
  const settleRef = `${action}:${attemptId}`;
  return tx(pg, async (db) => {
    const h = await db.query(
      `UPDATE generation_credit_holds_v2
          SET status=$2, settled_at=NOW()
        WHERE item_id=$1 AND status='held'
        RETURNING user_id, pool, amount`,
      [itemId, target],
    );
    const hold = h.rows && h.rows[0] ? h.rows[0] : null;
    if (!hold) return { changed: false, hold: null };
    const p = hold.pool || 'recharge';
    const charge = Number(userCharge != null ? userCharge : hold.amount) || 0;
    const actualAmt = Number(actual != null ? actual : charge) || 0;
    const col = p === 'reward' ? 'reward_credits' : 'recharge_credits';

    if (action === 'commit') {
      await db.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after, actual_amount, user_charge_amount)
         VALUES ($1, 'commit', $2, $3, $4, (SELECT credits FROM users WHERE id = $1), $5, $2)
         ON CONFLICT (ref, kind) DO NOTHING`,
        [hold.user_id, charge, settleRef, p, actualAmt],
      );
    } else {
      const inserted = await db.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after, user_charge_amount)
         VALUES ($1, 'release', $2, $3, $4, (SELECT credits FROM users WHERE id = $1), $2)
         ON CONFLICT (ref, kind) DO NOTHING
         RETURNING id`,
        [hold.user_id, charge, settleRef, p],
      );
      if (inserted.rowCount) {
        await db.query(`UPDATE users SET ${col} = ${col} + $1 WHERE id = $2`, [charge, hold.user_id]);
      }
    }
    return { changed: true, hold };
  });
}

async function reconcileBatch(pg, batchId) {
  if (!batchId) throw new TypeError('batchId is required');
  const result = await pg.query(
    `WITH counts AS (
       SELECT b.batch_id,b.requested_count,
              COUNT(*) FILTER (WHERE i.status='done')::int AS success_count,
              COUNT(*) FILTER (WHERE i.status='failed')::int AS failed_count,
              COUNT(*) FILTER (WHERE i.status='canceled')::int AS canceled_count,
              COUNT(*) FILTER (WHERE i.status IN ('done','failed','canceled'))::int AS terminal_count
         FROM generation_batches_v2 b
         JOIN generation_items_v2 i ON i.batch_id=b.batch_id
        WHERE b.batch_id=$1
        GROUP BY b.batch_id,b.requested_count
     ), projected AS (
       SELECT *, CASE
         WHEN success_count=requested_count THEN 'done'
         WHEN success_count>0 AND terminal_count=requested_count THEN 'partial'
         WHEN canceled_count=requested_count THEN 'canceled'
         WHEN terminal_count=requested_count THEN 'failed'
         ELSE 'running'
       END AS projected_status
       FROM counts
     )
     UPDATE generation_batches_v2 b
        SET success_count=p.success_count,
            failed_count=p.failed_count,
            canceled_count=p.canceled_count,
            status=p.projected_status,
            started_at=COALESCE(b.started_at,NOW()),
            completed_at=CASE WHEN p.terminal_count=p.requested_count THEN COALESCE(b.completed_at,NOW()) ELSE NULL END
       FROM projected p
      WHERE b.batch_id=p.batch_id
      RETURNING b.batch_id,b.status,b.success_count,b.failed_count,b.canceled_count,b.completed_at`,
    [batchId],
  );
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

module.exports = { settleHold, settleByAttempt, reconcileBatch };
