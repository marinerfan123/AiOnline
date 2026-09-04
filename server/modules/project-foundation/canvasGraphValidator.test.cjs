'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCanvasGraph, projectCanvasGraph, DEFAULT_NODE_SCHEMAS } = require('./canvasGraphValidator.cjs');

function node(nodeId, nodeKind, version = 1) {
  return { nodeId, nodeType: nodeKind, nodeSchemaVersion: version, position: { x: 0, y: 0 }, data: { nodeKind, nodeType: nodeKind, schemaVersion: version } };
}
function edge(edgeId, sourceNodeId, sourceHandle, targetNodeId, targetHandle) {
  return { edgeId, sourceNodeId, sourceHandle, targetNodeId, targetHandle };
}

test('accepts a valid typed acyclic graph', () => {
  const r = validateCanvasGraph({
    nodes: [node('p', 'prompt'), node('g', 'image-generation'), node('o', 'output')],
    edges: [edge('e1', 'p', 'text', 'g', 'text'), edge('e2', 'g', 'image', 'o', 'image')],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test('rejects unknown node kind and schema version fail-closed', () => {
  const r = validateCanvasGraph({ nodes: [node('x', 'invented'), node('p', 'prompt', 99)], edges: [] });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'UNKNOWN_NODE_KIND' && x.nodeId === 'x'));
  assert.ok(r.reasons.some((x) => x.code === 'SCHEMA_VERSION_MISMATCH' && x.nodeId === 'p'));
});

test('rejects duplicate operation ids while allowing explicit replacement', () => {
  const n = node('p', 'prompt');
  const r = validateCanvasGraph({
    nodes: [n], edges: [],
    ops: { upsertNodes: [n, n], deleteNodeIds: ['p'], upsertEdges: [], deleteEdgeIds: ['e', 'e'] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'DUPLICATE_OP_ID' && x.entity === 'node'));
  assert.ok(r.reasons.some((x) => x.code === 'DUPLICATE_OP_ID' && x.entity === 'edge'));
  const replacement = validateCanvasGraph({ nodes: [n], edges: [], ops: { upsertNodes: [n], deleteNodeIds: ['p'] } });
  assert.equal(replacement.ok, true);
});

test('rejects dangling endpoints, missing handles and self edges', () => {
  const r = validateCanvasGraph({
    nodes: [node('p', 'prompt')],
    edges: [
      edge('dangling', 'p', 'text', 'missing', 'text'),
      edge('ports', 'p', null, 'p', null),
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'NODE_NOT_FOUND'));
  assert.ok(r.reasons.some((x) => x.code === 'SELF_CONNECTION'));
  assert.ok(r.reasons.some((x) => x.code === 'PORT_NOT_FOUND'));
});

test('rejects incompatible types, duplicate tuple and input cardinality overflow', () => {
  const nodes = [node('p1', 'prompt'), node('p2', 'prompt'), node('g', 'image-generation'), node('v', 'video')];
  const edges = [
    edge('e1', 'p1', 'text', 'g', 'text'),
    edge('e2', 'p2', 'text', 'g', 'text'),
    edge('e3', 'p1', 'text', 'g', 'text'),
    edge('e4', 'v', 'video', 'g', 'image'),
  ];
  const r = validateCanvasGraph({ nodes, edges });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'CARDINALITY_EXCEEDED'));
  assert.ok(r.reasons.some((x) => x.code === 'DUPLICATE_EDGE'));
  assert.ok(r.reasons.some((x) => x.code === 'TYPE_INCOMPATIBLE'));
});

test('rejects a directed cycle through a structural storyboard node', () => {
  const nodes = [node('g', 'image-generation'), node('s', 'storyboard')];
  const edges = [edge('e1', 'g', 'image', 's', 'image'), edge('e2', 's', 'image', 'g', 'image')];
  const r = validateCanvasGraph({ nodes, edges });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'GRAPH_CYCLE'));
});

test('projectCanvasGraph applies deletes before upserts without mutating input', () => {
  const current = { nodes: [node('p', 'prompt'), node('old', 'prompt')], edges: [edge('e0', 'p', 'text', 'old', 'text')] };
  const ops = { deleteNodeIds: ['old'], deleteEdgeIds: ['e0'], upsertNodes: [node('g', 'image-generation')], upsertEdges: [edge('e1', 'p', 'text', 'g', 'text')] };
  const out = projectCanvasGraph(current, ops);
  assert.deepEqual(out.nodes.map((n) => n.nodeId).sort(), ['g', 'p']);
  assert.deepEqual(out.edges.map((e) => e.edgeId), ['e1']);
  assert.equal(current.nodes.length, 2);
});

test('accepts injected nodeSchemas and rejects malformed schema map', () => {
  const custom = { custom: { version: 2, executionKind: 'SOURCE', inputPorts: [], outputPorts: [{ id: 'x', type: 'TEXT' }] } };
  assert.equal(validateCanvasGraph({ nodes: [node('n', 'custom', 2)], edges: [], nodeSchemas: custom }).ok, true);
  assert.equal(validateCanvasGraph({ nodes: [node('n', 'custom', 2)], edges: [], nodeSchemas: {} }).ok, false);
  assert.ok(DEFAULT_NODE_SCHEMAS.prompt);
});
