'use strict';
/**
 * M02-C — Routing Policy Domain (durable canary/routing metadata)
 *
 * The DB is the authority. Process memory may cache but is never authoritative.
 * One active policy per (model, capability, target_binding) or (model, target_binding).
 */
const POLICY_STATUSES = ['active', 'paused'];

/**
 * Validate a routing policy input (pre-write).
 * @param {object} policy  { model_id, target_binding_id, capability?, percent?, salt?, updated_by? }
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object') return { ok: false, errors: ['policy 必须是对象'] };
  if (!policy.model_id) errors.push('缺少 model_id');
  if (!policy.target_binding_id) errors.push('缺少 target_binding_id');
  if (typeof policy.percent !== 'undefined' && (!Number.isInteger(policy.percent) || policy.percent < 0 || policy.percent > 100)) {
    errors.push('percent 必须是 0-100 的整数');
  }
  if (policy.salt !== undefined && typeof policy.salt !== 'string') {
    errors.push('salt 必须是字符串');
  }
  if (policy.updated_by !== undefined && typeof policy.updated_by !== 'string') {
    errors.push('updated_by 必须是字符串');
  }
  if (policy.capability !== undefined && typeof policy.capability !== 'string') {
    errors.push('capability 必须是字符串');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Project a policy row to domain object.
 */
function toPolicy(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    model_id: row.model_id ?? null,
    capability: row.capability ?? null,
    target_binding_id: row.target_binding_id ?? null,
    percent: Number(row.percent) ?? 0,
    salt: row.salt ?? '',
    status: row.status ?? 'active',
    revision: Number(row.revision) ?? 1,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * Resolve routing target for a request using weighted random selection.
 * Uses hash(model_id + capability + salt + request_seed) to deterministically pick.
 * @param {object[]} policies  Active policies for the model
 * @param {string}   modelId
 * @param {string}   capability
 * @param {number}   seed      Request seed for deterministic selection
 * @returns {object|null} Selected { bindingId, percent } or null
 */
function resolveRouting(policies, modelId, capability, seed) {
  if (!policies || !policies.length) return null;

  const crypto = require('node:crypto');
  const seedStr = `${modelId}:${capability}:${seed}`;
  const hash = parseInt(crypto.createHash('sha256').update(seedStr).digest('hex').slice(0, 8), 16);
  const bucket = hash % 100;

  // Filter active policies matching this model+capability
  const matching = policies.filter((p) => {
    if (p.status !== 'active') return false;
    if (p.model_id !== modelId) return false;
    // Match exact capability or wildcard (null capability = all capabilities)
    if (p.capability !== null && p.capability !== capability) return false;
    return true;
  });

  if (!matching.length) return null;

  // Pick the policy with highest percent that covers this bucket
  for (const policy of matching.sort((a, b) => b.percent - a.percent)) {
    if (bucket < policy.percent) {
      return { bindingId: policy.target_binding_id, percent: policy.percent, policyId: policy.id };
    }
  }
  return null;
}

module.exports = {
  POLICY_STATUSES,
  validatePolicy,
  toPolicy,
  resolveRouting,
};
