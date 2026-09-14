'use strict';
/**
 * W1-17 — Unified domain event envelope + idempotency contract (platform-data module).
 *
 * Standardizes every domain event to: id, type, actor, workspace, project, object,
 *   timestamp, metadata, correlation_id. Provides idempotency_key semantics for
 *   release-critical writes (deterministic key from the actor+operation+object+correlation).
 * Pure module (no I/O); the outbox (generation_outbox_v2) persists published events.
 */

const crypto = require('crypto');

const EVENT_FIELDS = Object.freeze(['id', 'type', 'actor', 'workspace', 'project', 'object', 'timestamp', 'metadata', 'correlation_id']);

/** Build a standardized event envelope (fills defaults; throws on missing required). */
function buildEvent({ type, actor, workspace, object, correlationId, timestamp, project, metadata }) {
  if (!type || typeof type !== 'string') throw new TypeError('event.type is required');
  if (!actor || !actor.id) throw new TypeError('event.actor.id is required');
  if (!object || !object.id || !object.type) throw new TypeError('event.object.id/type required');
  const evt = {
    id: `evt-${crypto.randomUUID()}`,
    type,
    actor: { id: String(actor.id), role: actor.role || null },
    workspace: workspace || null,
    project: project || null,
    object: { id: String(object.id), type: object.type },
    timestamp: timestamp || new Date().toISOString(),
    metadata: metadata || {},
    correlation_id: correlationId || null,
  };
  return evt;
}

function validateEvent(evt) {
  const errors = [];
  if (!evt || typeof evt !== 'object') return { ok: false, errors: ['event must be an object'] };
  for (const k of ['id', 'type', 'timestamp']) if (!evt[k]) errors.push(`missing ${k}`);
  if (!evt.actor || !evt.actor.id) errors.push('missing actor.id');
  if (!evt.object || !evt.object.id || !evt.object.type) errors.push('missing object.id/type');
  const extra = Object.keys(evt).filter((k) => !EVENT_FIELDS.includes(k) && k !== 'idempotency_key');
  if (extra.length) errors.push(`unknown fields: ${extra.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * Deterministic idempotency key for release-critical writes.
 * Same (actor, operation, object, correlation) => same key, so a replays/retries can
 * be deduplicated. Scope to a workspace+project to avoid cross-tenant collisions.
 */
function idempotencyKey({ actor, operation, object, correlationId, workspace, project }) {
  const parts = [
    String(actor || ''),
    String(operation || ''),
    String(object || ''),
    String(correlationId || ''),
    String(workspace || ''),
    String(project || ''),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = { EVENT_FIELDS, buildEvent, validateEvent, idempotencyKey };
