'use strict';

async function settleHold(pg, { itemId, action } = {}) {
  if (!itemId) throw new TypeError('itemId is required');
  if (!['commit', 'release'].includes(action)) throw new TypeError('action must be commit or release');
  const target = action === 'commit' ? 'committed' : 'released';
  const result = await pg.query(
    `UPDATE generation_credit_holds_v2
        SET status='${target}', settled_at=NOW()
      WHERE item_id=$1 AND status='held'
      RETURNING hold_id,item_id,user_id,pool,amount,status`,
    [itemId],
  );
  const hold = result.rows && result.rows[0] ? result.rows[0] : null;
  return { changed: !!hold, hold };
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

module.exports = { settleHold, reconcileBatch };
