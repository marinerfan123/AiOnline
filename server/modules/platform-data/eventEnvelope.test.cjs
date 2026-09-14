'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEvent, validateEvent, idempotencyKey, EVENT_FIELDS } = require('./eventEnvelope.cjs');

test('buildEvent creates a standardized envelope', () => {
  const evt = buildEvent({ type: 'shot.created', actor: { id: 'u1', role: 'admin' }, workspace: 'w1', project: 'p1', object: { id: 's1', type: 'shot' }, correlationId: 'c1', metadata: { seq: 2 } });
  assert.equal(evt.type, 'shot.created');
  assert.ok(evt.id.startsWith('evt-'));
  assert.equal(evt.actor.id, 'u1');
  assert.equal(evt.object.id, 's1');
  assert.equal(evt.correlation_id, 'c1');
  assert.equal(validateEvent(evt).ok, true);
});

test('missing required fields throw / reject', () => {
  assert.throws(() => buildEvent({ actor: { id: 'u1' }, object: { id: 's1', type: 'shot' } }), /event.type/);
  const r = validateEvent({ id: 'x', type: 't', timestamp: 'now', actor: {}, object: {} });
  assert.equal(r.ok, false);
});

test('unknown fields rejected', () => {
  const r = validateEvent({ id: 'x', type: 'a', timestamp: 'now', actor: { id: 'u' }, object: { id: 'o', type: 't' }, secret: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('secret')));
});

test('idempotency key is deterministic + tenant-scoped', () => {
  const base = { actor: 'u1', operation: 'create', object: 'shot:s1', correlationId: 'c1', workspace: 'w1', project: 'p1' };
  assert.equal(idempotencyKey(base), idempotencyKey(base));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, actor: 'u2' }));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, project: 'p2' }));
});

test('envelope field set is fixed', () => {
  assert.deepEqual(EVENT_FIELDS, ['id', 'type', 'actor', 'workspace', 'project', 'object', 'timestamp', 'metadata', 'correlation_id']);
});
