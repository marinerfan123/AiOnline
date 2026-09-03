'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { durableNodeData, validateAuthoritativeBindings } = require('./studioCanvasPersistence.cjs');

test('durableNodeData persists authoritative shotId/structureNodeId binding', () => {
  const d = durableNodeData({ nodeKind: 'shot', title: 'A', shotId: 'shot-1', structureNodeId: 'sn-1', parameters: {} });
  assert.equal(d.shotId, 'shot-1');
  assert.equal(d.structureNodeId, 'sn-1');
  assert.equal(d.nodeKind, 'shot');
});

test('durableNodeData strips forbidden binding values (non-string ignored, no crash)', () => {
  const d = durableNodeData({ nodeKind: 'node', shotId: 42, parameters: {} });
  // numeric shotId should not be preserved (must be string|null)
  assert.equal(d.shotId, undefined);
});

test('valid binding passes validation', () => {
  const nodes = [{ nodeId: 'n1', data: { shotId: 's1', structureNodeId: 'sn1' } }];
  const r = validateAuthoritativeBindings(nodes, { shotIds: ['s1'], structureNodeIds: ['sn1'] });
  assert.equal(r.ok, true);
});

test('invalid shotId / structureNodeId rejected (must reference authoritative project objects)', () => {
  const nodes = [{ nodeId: 'n1', data: { shotId: 'bogus', structureNodeId: 'sn1' } }];
  const r = validateAuthoritativeBindings(nodes, { shotIds: ['s1'], structureNodeIds: ['sn1'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('shotId bogus')));
});

test('nodes without binding pass (no constraint)', () => {
  const r = validateAuthoritativeBindings([{ nodeId: 'n1', data: {} }]);
  assert.equal(r.ok, true);
});

test('W2-07: shot binding survives snapshot->restore JSON round-trip', () => {
  // Simulate: a node saved (durableNodeData), serialized to a version snapshot, then restored.
  const raw = { nodeKind: 'shot', title: 'A', shotId: 'shot-9', structureNodeId: 'sn-9', parameters: {} };
  const durable = durableNodeData(raw);
  const snapshotNode = JSON.parse(JSON.stringify(durable)); // what snapshot_json stores
  const restored = durableNodeData(snapshotNode); // what restore re-normalizes into
  assert.equal(restored.shotId, 'shot-9');
  assert.equal(restored.structureNodeId, 'sn-9');
});
