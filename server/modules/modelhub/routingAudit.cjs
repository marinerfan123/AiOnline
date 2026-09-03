'use strict';
/**
 * W3-06 — Routing decision audit record (pure builder + persistence SQL). Selected candidate,
 * rejected candidates, scores/reasons, policy/plan and timestamp are queryable by generation.
 * Persist with the SAME client/transaction as the business write (replay by generation_id).
 */
const { randomUUID } = require('crypto');

/** Build an audit record from a W3-05 routeDecision + generation context. */
function buildRoutingAuditRecord({ generationId, decision, policy, plan, actor, timestamp = new Date().toISOString() } = {}) {
  if (!generationId) throw new TypeError('generationId required');
  const selected = decision && decision.chosen;
  const candidates = (decision && decision.candidates || []).map((c) => ({
    id: c.id, score: c.score === -Infinity ? null : c.score, reasons: c.reasons || [],
  }));
  return {
    id: `ra-${randomUUID()}`,
    generationId,
    selected,
    rejected: candidates.filter((c) => c.id !== selected).map((c) => c.id),
    candidates,
    reason: (decision && decision.reason) || null,
    policy: policy || null,
    plan: plan || null,
    actor: actor || null,
    timestamp,
  };
}

/** Insert an audit record in the caller's transaction. */
async function persistRoutingAudit(client, record) {
  await client.query(
    `INSERT INTO routing_audit (id, generation_id, selected, rejected, candidates, reason, policy, plan, actor, timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [record.id, record.generationId, record.selected, JSON.stringify(record.rejected), JSON.stringify(record.candidates), record.reason, JSON.stringify(record.policy || null), record.plan || null, record.actor || null, record.timestamp]
  );
  return record.id;
}

/** Replay: fetch the audit record(s) for a generation. */
function selectRoutingAuditByGeneration(generationId) {
  return `SELECT id, selected, rejected, candidates, reason, policy, plan, actor, timestamp FROM routing_audit WHERE generation_id=$1 ORDER BY timestamp ASC`;
}

module.exports = { buildRoutingAuditRecord, persistRoutingAudit, selectRoutingAuditByGeneration };
