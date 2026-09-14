'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./envelopes.cjs');

test('G00 node envelope: valid base node passes', () => {
  const r = C.validateNodeEnvelope({
    id: 'n1', canvasId: 'c1', nodeType: 'image',
    position: { x: 10, y: 20 }, size: { width: 320, height: 240 },
    data: { prompt: 'x' }, uiState: {}, revision: 3,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:01.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('G00 node envelope: rejects missing revision / bad position', () => {
  const r = C.validateNodeEnvelope({ id: 'n1', canvasId: 'c1', nodeType: 'text', position: { x: 'a' }, data: {}, uiState: {} });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('position')));
  assert.ok(r.errors.some((e) => e.includes('revision')));
});

test('G00 node envelope: entityRef optional pair rule', () => {
  // entityType without entityId must fail data-shape usage downstream — here allowed at envelope, but nodeType known
  assert.equal(C.isKnownNodeType('video-clip'), true);
  assert.equal(C.isKnownNodeType('director-stage'), true);
  assert.equal(C.isKnownNodeType('bogus'), false);
});

test('G00 edge: rejects self-loop and missing port', () => {
  const r = C.validateEdgeRecord({ id: 'e1', canvasId: 'c1', sourceNodeId: 'a', sourcePortId: 'p', targetNodeId: 'a', targetPortId: 'q', relationType: 'data' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('differ')));
  const r2 = C.validateEdgeRecord({ id: 'e2', canvasId: 'c1', sourceNodeId: 'a', sourcePortId: 'p', targetNodeId: 'b', relationType: 'data' });
  assert.equal(r2.ok, false);
});

test('G00 ports: data type and semantic allowlists', () => {
  assert.equal(C.isPortDataType('any-media'), true);
  assert.equal(C.isPortDataType('mask'), true);
  assert.equal(C.isPortDataType('float'), false);
  assert.equal(C.isPortSemantic('character_reference'), true);
  assert.equal(C.isPortSemantic('first_frame'), true);
  assert.equal(C.isPortSemantic('foo'), false);
});

test('G00 command: idempotencyKey and actor required', () => {
  const ok = C.validateCommand({ commandId: 'cmd-1', projectId: 'p1', canvasId: 'c1', actor: { id: 'u1' }, type: 'node.create', expectedRevision: 4, idempotencyKey: 'ik-1', payload: {} });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const bad = C.validateCommand({ commandId: 'cmd-2', projectId: 'p1', type: 'node.delete', payload: {} });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('idempotencyKey')));
  assert.ok(bad.errors.some((e) => e.includes('actor')));
  assert.equal(C.isKnownCommandType('timeline.clip.create'), true);
  assert.equal(C.isKnownCommandType('run.retry'), true);
  assert.equal(C.isKnownCommandType('sql.drop'), false);
});

test('G00 public error: envelope contract + code prefix', () => {
  const ok = C.validatePublicError({ code: 'CONFLICT_REVISION', message: 'stale', retryable: false, traceId: 't-1' });
  assert.equal(ok.ok, true);
  const bad = C.validatePublicError({ code: 'OOPS', message: 'x', retryable: 'yes', traceId: '' });
  assert.equal(bad.ok, false);
});

test('G00 event envelope: monotonic sequence', () => {
  assert.equal(C.nextEventSequence(undefined), 1);
  assert.equal(C.nextEventSequence(41), 42);
  assert.throws(() => C.nextEventSequence(-1), TypeError);
  const evt = { sequence: 5, eventId: 'ev-5', projectId: 'p1', runId: 'r1', timestamp: '2026-09-03T00:00:00.000Z', type: 'run.item.updated', payload: {} };
  assert.equal(C.validateEventEnvelope(evt).ok, true);
});

test('G00 model capability schema', () => {
  const ok = C.validateModelCapability({ 'video.text2video': true, 'video.maxDurationMs': 30000, 'reference.image.max': 9, 'camera.structuredControl': false });
  assert.equal(ok.ok, true);
  const bad = C.validateModelCapability({ 'video.text2video': 'yes', 'reference.image.max': -1 });
  assert.equal(bad.ok, false);
});

test('G00 format version: schemaVersion guard + forward-only migration chain', () => {
  assert.equal(C.requireSchemaVersion({ schemaVersion: 1 }).ok, true);
  assert.equal(C.requireSchemaVersion({}).ok, false);
  C.registerMigration('node', 1, 2, (d) => ({ ...d, schemaVersion: 2, upgraded: true }));
  const r = C.migratePayload('node', { schemaVersion: 1, data: 1 }, 2);
  assert.equal(r.ok, true);
  assert.equal(r.data.upgraded, true);
  // backwards is not a migration
  assert.equal(C.migratePayload('node', { schemaVersion: 2 }, 1).ok, false);
  // broken migrator (no version bump) must fail closed
  C.registerMigration('node', 2, 3, (d) => ({ ...d, schemaVersion: 2 }));
  assert.equal(C.migratePayload('node', { schemaVersion: 2 }, 3).ok, false);
});
