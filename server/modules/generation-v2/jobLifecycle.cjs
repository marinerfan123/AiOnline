'use strict';
/**
 * W4-03 — Idempotent job/queue lifecycle (pure state machine). Job state transitions are
 * transactional, replay-safe (only valid transitions) and lease-aware (claim only if lease free).
 */
const STATE = ['queued', 'claimed', 'running', 'done', 'failed', 'canceled'];
const ALLOWED = {
  queued: ['claimed', 'canceled'],
  claimed: ['running', 'failed', 'canceled'],
  running: ['done', 'failed', 'canceled'],
  done: [],
  failed: ['queued'], // requeue
  canceled: [],
};

/** Transition a job. {queue: queued|claimed|running|done|failed|canceled}. Returns {ok, next}. */
function transition(job, to, { reason = null } = {}) {
  const from = job && job.status;
  if (!from) return { ok: false, error: { code: 'JOB_NO_STATE' } };
  if (!ALLOWED[from] || !ALLOWED[from].includes(to)) return { ok: false, error: { code: 'INVALID_TRANSITION', from, to } };
  return { ok: true, next: { status: to, reason, transitionedAt: new Date().toISOString(), priorStatus: from } };
}

/** Attempt a lease claim on a job. {ok, leased}. Only if no valid lease or lease owner matches. */
function claimLease({ status, leaseOwner, leaseExpiresAt, actor }) {
  const now = Date.now();
  if (status === 'running' || status === 'done' || status === 'failed' || status === 'canceled') return { ok: false, reason: 'TERMINAL_OR_RUNNING' };
  const active = leaseOwner && (!leaseExpiresAt || new Date(leaseExpiresAt).getTime() > now);
  if (active && leaseOwner !== actor) return { ok: false, reason: 'LEASE_HELD' };
  return { ok: true, leased: true, leaseOwner: actor, leaseExpiresAt: new Date(now + 60_000).toISOString() };
}

module.exports = { transition, claimLease, STATE, ALLOWED };
