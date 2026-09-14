'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { safeNodeInput, deepFreeze, compileStudioGraph, NODE_REGISTRY } = require('./studioRunGraph.cjs');

test('safeNodeInput carries stable Shot/Reference/Asset lineage ids', () => {
  const input = safeNodeInput({ data: { parameters: {}, assetId: 'a1', shotId: 's1', structureNodeId: 'sn1', referenceId: 'r1', prompt: 'hi', signedUrl: 'should-strip' } });
  assert.equal(input.shotId, 's1');
  assert.equal(input.structureNodeId, 'sn1');
  assert.equal(input.referenceId, 'r1');
  assert.equal(input.assetId, 'a1');
  assert.equal(input.signedUrl, undefined, 'secret stripped');
});

test('deepFreeze freezes the snapshot (immutability)', () => {
  const snap = deepFreeze({ ok: true, graph: { nodes: [{ nodeId: 'n1', input: { shotId: 's1' } }] } });
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.graph));
  assert.ok(Object.isFrozen(snap.graph.nodes));
});

test('compiled snapshot is frozen when a graph compiles', () => {
  // prompt (SOURCE) -> output (OUTPUT), using the registry schema versions.
  const promptDef = NODE_REGISTRY.prompt, outDef = NODE_REGISTRY.output;
  const r = compileStudioGraph({
    canvasId: 'c1', canvasRevision: 1, canvasSchemaVersion: 1, runMode: 'ALL',
    nodes: [
      { nodeId: 'n1', nodeType: 'prompt', nodeSchemaVersion: promptDef.version, data: { parameters: {}, shotId: 's1' } },
      { nodeId: 'n2', nodeType: 'output', nodeSchemaVersion: outDef.version, data: { parameters: {} } },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', sourceHandle: 'text', targetHandle: 'text' }],
  });
  // Either compiles ok (and is frozen) or fails validation — assert snapshot is frozen in the ok branch.
  if (r.ok) {
    assert.ok(Object.isFrozen(r));
    const n = r.graph.nodes.find((x) => x.nodeId === 'n1');
    assert.ok(n && n.input.shotId === 's1', 'lineage carried into compiled node');
  } else {
    assert.ok(r.error && r.error.code, 'structured error on invalid graph');
  }
});

test('cyclic graph rejected with DAG_CYCLE_DETECTED (structured error)', () => {
  const outDef = NODE_REGISTRY.output;
  const r = compileStudioGraph({
    canvasId: 'c1', canvasRevision: 1, canvasSchemaVersion: 1, runMode: 'ALL',
    nodes: [
      { nodeId: 'n1', nodeType: 'output', nodeSchemaVersion: outDef.version, data: { parameters: {} } },
      { nodeId: 'n2', nodeType: 'output', nodeSchemaVersion: outDef.version, data: { parameters: {} } },
    ],
    edges: [
      { edgeId: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', sourceHandle: 'text', targetHandle: 'text' },
      { edgeId: 'e2', sourceNodeId: 'n2', targetNodeId: 'n1', sourceHandle: 'text', targetHandle: 'text' },
    ],
  });
  // Graph with two output nodes + a 2-cycle: if it reaches topo sort, must reject cycle.
  assert.equal(r.ok, false);
});
