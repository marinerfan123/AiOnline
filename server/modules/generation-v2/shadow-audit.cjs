'use strict';

const SHADOW_AUDIT_SQL = `
SELECT b.batch_id,
       b.request_payload->>'legacyTaskId' AS legacy_task_id,
       legacy.count::int AS legacy_count,
       b.requested_count::int,
       COUNT(DISTINCT i.item_id)::int AS item_count,
       COUNT(DISTINCT h.item_id)::int AS hold_count,
       COALESCE(SUM(h.amount) FILTER (WHERE h.item_id IS NOT NULL),0)::text AS hold_total,
       b.reserved_total::text
  FROM generation_batches_v2 b
  LEFT JOIN generation_tasks legacy
    ON legacy.task_id=b.request_payload->>'legacyTaskId'
  LEFT JOIN generation_items_v2 i ON i.batch_id=b.batch_id
  LEFT JOIN generation_credit_holds_v2 h ON h.item_id=i.item_id
 WHERE b.created_at >= NOW()-($1 * INTERVAL '1 hour')
   AND COALESCE((b.request_payload->>'shadow')::boolean,false)=true
 GROUP BY b.batch_id,legacy.count
 ORDER BY b.created_at ASC`;

function sameMoney(a, b) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.0001;
}

async function buildShadowAudit(pg, { sinceHours = 24 } = {}) {
  const hours = Math.max(1, Math.min(24 * 30, Number(sinceHours) || 24));
  const result = await pg.query(SHADOW_AUDIT_SQL, [hours]);
  let consistent = 0, mismatched = 0, missingLegacy = 0;
  const issues = [];
  for (const row of result.rows || []) {
    const missing = !row.legacy_task_id || row.legacy_count == null;
    const match = !missing
      && Number(row.legacy_count) === Number(row.requested_count)
      && Number(row.item_count) === Number(row.requested_count)
      && Number(row.hold_count) === Number(row.requested_count)
      && sameMoney(row.hold_total, row.reserved_total);
    if (match) consistent++;
    else {
      if (missing) missingLegacy++; else mismatched++;
      issues.push({
        batchId: row.batch_id,
        legacyTaskId: row.legacy_task_id,
        reason: missing ? 'missing_legacy' : 'count_or_amount_mismatch',
        legacyCount: row.legacy_count,
        requestedCount: row.requested_count,
        itemCount: row.item_count,
        holdCount: row.hold_count,
        holdTotal: row.hold_total,
        reservedTotal: row.reserved_total,
      });
    }
  }
  const total = (result.rows || []).length;
  return { ok: issues.length === 0, sampled: total, total, consistent, mismatched, missingLegacy, issues };
}

module.exports = { SHADOW_AUDIT_SQL, buildShadowAudit };
