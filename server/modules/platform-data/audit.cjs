'use strict';
/**
 * W2-11 — Transactional business audit trail (platform-data).
 * Records actor/workspace/action/object/before/after/timestamp for critical actions, in the SAME
 * transaction as the write (call with the business client). Pure SQL helper: no COMMIT.
 */
const { randomUUID } = require('crypto');

/**
 * Record an audit entry inside the caller's transaction.
 * @returns {Promise<{id: string}>}
 */
async function recordAuditWithinTxn(client, { actor, workspaceId, action, objectType, objectId, before, after }) {
  const id = `audit-${randomUUID()}`;
  await client.query(
    `INSERT INTO business_audit (id, actor, workspace_id, action, object_type, object_id, object_before, object_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, actor, workspaceId || null, action, objectType, objectId,
     before === undefined ? null : JSON.stringify(before),
     after === undefined ? null : JSON.stringify(after)]
  );
  return { id };
}

/** Validate an audit event (complete actor/workspace/object/action). Returns {ok, errors[]}. */
function validateAudit(a) {
  const errors = [];
  if (!a) { errors.push('audit required'); return { ok: false, errors }; }
  if (!a.actor) errors.push('actor required');
  if (!a.action) errors.push('action required');
  if (!a.objectType) errors.push('objectType required');
  if (!a.objectId) errors.push('objectId required');
  return { ok: errors.length === 0, errors };
}

module.exports = { recordAuditWithinTxn, validateAudit };
