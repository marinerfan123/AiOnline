'use strict';
/**
 * W4-02 — Generation V2 Shot intake (pure contract). Stores Shot id, project/workspace scope,
 * IR/compiler/router versions, quote/reserve ids + idempotency key. Deterministic idempotency key
 * so a duplicate intake is a no-op.
 */
const crypto = require('crypto');

/** Build an intake record. Duplicate (same idempotencyKey) -> {duplicate:true}. */
function buildIntake({ shotId, projectId, workspaceId, ir, compiled, route, quote, reserve, userId } = {}) {
  if (!shotId || !projectId || !workspaceId) return { ok: false, error: { code: 'INTAKE_MISSING_SCOPE' } };
  const idempotencyKey = `intake:${projectId}:${shotId}:${userId || 'anon'}`;
  return {
    ok: true,
    record: {
      intakeId: `in-${crypto.randomUUID()}`,
      shotId, projectId, workspaceId, userId: userId || null,
      irVersion: ir && ir.ir_version,
      compilerVersion: compiled && compiled.version,
      compilerHash: compiled && compiled.deterministicHash,
      routeId: route && route.id,
      quoteId: quote && quote.quoteId,
      reserveId: reserve && reserve.reserveId,
      idempotencyKey,
    },
  };
}

/** Dedup decision: accept only if the idempotency key is not already ingested. */
function intakeDedup(record, existingKey) {
  if (existingKey === record.idempotencyKey) return { ok: false, duplicate: true };
  return { ok: true, duplicate: false };
}

module.exports = { buildIntake, intakeDedup };
