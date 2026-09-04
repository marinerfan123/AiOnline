'use strict';
/**
 * W3-06 — Routing decision audit record (pure builder + persistence SQL). Selected candidate,
 * rejected candidates, scores/reasons, policy/plan and timestamp are queryable by generation.
 * Persist with the SAME client/transaction as the business write (replay by generation_id).
 *
 * L40 — Routing Policy 版本化 + 决策快照（§34/§35）:
 *   - buildPolicySnapshot  : 决策时点不可变快照 {policyVersion, model, binding, score, reasons[]}
 *   - recordRoutingDecision: 落 ai_routing_decisions(0010) 并携带 policy_snapshot（INSERT-only）
 *   - listByVersion        : 按快照 policyVersion 回溯决策
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

/**
 * Build an immutable decision-time policy snapshot (L40 §35).
 * Shape: { policyVersion, model, binding, score, reasons[] }.
 * Frozen + reasons deep-copied so no runtime path can mutate it after build.
 * @returns {object}  frozen snapshot
 */
function buildPolicySnapshot({ policyVersion, model, binding, score, reasons = [] } = {}) {
  if (policyVersion == null) throw new TypeError('policyVersion required');
  const snapshot = {
    policyVersion,
    model: model ?? null,
    binding: binding ?? null,
    score: (score != null && Number.isFinite(score)) ? score : null,
    reasons: Array.isArray(reasons) ? [...reasons] : [],
  };
  return Object.freeze(snapshot);
}

/**
 * Record a routing decision with its immutable policy snapshot into
 * ai_routing_decisions (0010). INSERT-only — no UPDATE path, so decision history is
 * never rewritten at runtime (and the 0068 trigger forbids it at the DB layer too).
 * @param {object} client  pg client/transaction
 * @param {object} decision  { id?, modelId, capability?, region?, selectedBindingId?,
 *   selectedProviderId?, reason?, fallbackCandidates?, rejected?, weights?, seed?,
 *   requestId?, generationTaskId?, policySnapshot? }
 */
async function recordRoutingDecision(client, decision = {}) {
  const snapshot = decision.policySnapshot
    ? buildPolicySnapshot(decision.policySnapshot)
    : null;
  const id = decision.id || `rd-${randomUUID().replace(/-/g, '')}`;
  await client.query(
    `INSERT INTO ai_routing_decisions
       (id, model_id, capability, region, selected_binding_id, selected_provider_id, reason,
        fallback_candidates, rejected, weights, seed, request_id, generation_task_id, policy_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      decision.modelId ?? null,
      decision.capability ?? null,
      decision.region ?? null,
      decision.selectedBindingId ?? null,
      decision.selectedProviderId ?? null,
      decision.reason ?? null,
      JSON.stringify(decision.fallbackCandidates || []),
      JSON.stringify(decision.rejected || []),
      decision.weights != null ? JSON.stringify(decision.weights) : null,
      decision.seed ?? null,
      decision.requestId ?? null,
      decision.generationTaskId ?? null,
      snapshot ? JSON.stringify(snapshot) : null,
    ],
  );
  return id;
}

/**
 * List decisions recorded under a policy version (snapshot->>'policyVersion'),
 * newest first. Returns rows (async — executes on the caller's client).
 * @param {object} client  pg client
 * @param {number|string} policyVersion
 */
async function listByVersion(client, policyVersion) {
  const r = await client.query(
    `SELECT id, model_id, capability, selected_binding_id, selected_provider_id, reason, policy_snapshot, created_at
     FROM ai_routing_decisions
     WHERE policy_snapshot->>'policyVersion' = $1
     ORDER BY created_at DESC`,
    [String(policyVersion)],
  );
  return r.rows || [];
}

module.exports = {
  buildRoutingAuditRecord,
  persistRoutingAudit,
  selectRoutingAuditByGeneration,
  buildPolicySnapshot,
  recordRoutingDecision,
  listByVersion,
};
