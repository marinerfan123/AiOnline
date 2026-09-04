'use strict';

const ACCEPTS = Object.freeze({ IMAGE_SET: ['IMAGE'], SHOT: ['IMAGE', 'VIDEO'], SCENE: ['IMAGE', 'VIDEO', 'SCRIPT'] });
const p = (id, type, acceptedTypes) => Object.freeze({ id, type, ...(acceptedTypes ? { acceptedTypes: Object.freeze(acceptedTypes) } : {}) });
const schema = (version, executionKind, inputPorts, outputPorts) => Object.freeze({ version, executionKind, inputPorts: Object.freeze(inputPorts), outputPorts: Object.freeze(outputPorts) });

// Server mirror of the frozen V2 registry's graph contract. Display labels,
// parameter schemas and provider capabilities deliberately stay out: this map
// owns only persistence-integrity fields and can be injected by composition.
const DEFAULT_NODE_SCHEMAS = Object.freeze({
  prompt: schema(1, 'SOURCE', [p('text', 'TEXT')], [p('text', 'TEXT')]),
  script: schema(1, 'SOURCE', [p('text', 'TEXT')], [p('script', 'SCRIPT'), p('text', 'TEXT')]),
  character: schema(1, 'SOURCE', [p('text', 'TEXT')], [p('character', 'CHARACTER'), p('reference', 'REFERENCE')]),
  reference: schema(1, 'ASSET', [p('text', 'TEXT')], [p('reference', 'REFERENCE'), p('image', 'IMAGE')]),
  'image-generation': schema(1, 'GENERATION', [p('text', 'TEXT'), p('reference', 'REFERENCE', ['REFERENCE', 'CHARACTER']), p('image', 'IMAGE')], [p('image', 'IMAGE')]),
  'image-to-video': schema(1, 'GENERATION', [p('image', 'IMAGE'), p('text', 'TEXT'), p('reference', 'REFERENCE', ['REFERENCE', 'CHARACTER'])], [p('video', 'VIDEO')]),
  'text-to-video': schema(1, 'GENERATION', [p('text', 'TEXT'), p('reference', 'REFERENCE', ['REFERENCE', 'CHARACTER'])], [p('video', 'VIDEO')]),
  video: schema(1, 'ASSET', [p('video', 'VIDEO')], [p('video', 'VIDEO')]),
  output: schema(1, 'OUTPUT', [p('image', 'IMAGE'), p('video', 'VIDEO'), p('audio', 'AUDIO'), p('text', 'TEXT'), p('script', 'SCRIPT'), p('json', 'JSON'), p('asset', 'ASSET_REF')], []),
  frame: schema(1, 'STRUCTURAL', [], []),
  text: schema(1, 'SOURCE', [p('text', 'TEXT')], [p('text', 'TEXT')]),
  image: schema(1, 'ASSET', [p('image', 'IMAGE')], [p('image', 'IMAGE')]),
  audio: schema(1, 'ASSET', [p('audio', 'AUDIO')], [p('audio', 'AUDIO')]),
  storyboard: schema(1, 'STRUCTURAL', [p('image', 'IMAGE')], [p('image', 'IMAGE')]),
  'video-clip': schema(1, 'ASSET', [p('video', 'VIDEO')], [p('video', 'VIDEO')]),
});

function idOf(v, primary, fallback) { return String((v && (v[primary] ?? v[fallback])) ?? '').trim(); }
function nodeKindOf(n) { return String((n?.data?.nodeKind ?? n?.nodeType ?? n?.type ?? '')).trim(); }
function versionOf(n) { return Number(n?.data?.schemaVersion ?? n?.nodeSchemaVersion ?? 1); }
function edgeShape(e) {
  return {
    edgeId: idOf(e, 'edgeId', 'id'), sourceNodeId: idOf(e, 'sourceNodeId', 'source'),
    targetNodeId: idOf(e, 'targetNodeId', 'target'), sourceHandle: e?.sourceHandle ?? null,
    targetHandle: e?.targetHandle ?? null,
  };
}
function canConnect(outType, inputPort) {
  if (inputPort.acceptedTypes?.length) return inputPort.acceptedTypes.includes(outType);
  return outType === inputPort.type || (ACCEPTS[inputPort.type] || []).includes(outType);
}
function reason(code, extra = {}) { return { code, ...extra }; }
function duplicateValues(values) {
  const seen = new Set(), dup = new Set();
  for (const value of values) { if (!value) continue; if (seen.has(value)) dup.add(value); else seen.add(value); }
  return [...dup];
}
function validateOps(ops, reasons) {
  if (!ops) return;
  const nu = (ops.upsertNodes || []).map((x) => idOf(x, 'nodeId', 'id'));
  const nd = (ops.deleteNodeIds || []).map(String);
  const eu = (ops.upsertEdges || []).map((x) => idOf(x, 'edgeId', 'id'));
  const ed = (ops.deleteEdgeIds || []).map(String);
  for (const id of duplicateValues(nu)) reasons.push(reason('DUPLICATE_OP_ID', { entity: 'node', id, op: 'upsert' }));
  for (const id of duplicateValues(nd)) reasons.push(reason('DUPLICATE_OP_ID', { entity: 'node', id, op: 'delete' }));
  for (const id of duplicateValues(eu)) reasons.push(reason('DUPLICATE_OP_ID', { entity: 'edge', id, op: 'upsert' }));
  for (const id of duplicateValues(ed)) reasons.push(reason('DUPLICATE_OP_ID', { entity: 'edge', id, op: 'delete' }));
  // delete+upsert of the same id is an intentional replacement operation in
  // studioCanvasPersistence; projectCanvasGraph applies delete first.
}

function projectCanvasGraph(current = {}, ops = {}) {
  const nodes = new Map((current.nodes || []).map((n) => [idOf(n, 'nodeId', 'id'), n]));
  const edges = new Map((current.edges || []).map((e) => [idOf(e, 'edgeId', 'id'), e]));
  for (const id of ops.deleteEdgeIds || []) edges.delete(String(id));
  for (const id of ops.deleteNodeIds || []) nodes.delete(String(id));
  for (const n of ops.upsertNodes || []) nodes.set(idOf(n, 'nodeId', 'id'), n);
  for (const e of ops.upsertEdges || []) edges.set(idOf(e, 'edgeId', 'id'), e);
  // Node deletion has FK CASCADE semantics in PostgreSQL; project that before validation.
  for (const [id, raw] of edges) {
    const e = edgeShape(raw);
    if (!nodes.has(e.sourceNodeId) || !nodes.has(e.targetNodeId)) {
      if ((ops.deleteNodeIds || []).some((x) => String(x) === e.sourceNodeId || String(x) === e.targetNodeId)) edges.delete(id);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function hasDirectedCycle(nodeIds, edges) {
  const adjacency = new Map(nodeIds.map((id) => [id, []]));
  for (const raw of edges) { const e = edgeShape(raw); if (adjacency.has(e.sourceNodeId)) adjacency.get(e.sourceNodeId).push(e.targetNodeId); }
  const state = new Map();
  function visit(id) {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of adjacency.get(id) || []) if (visit(next)) return true;
    state.set(id, 2); return false;
  }
  for (const id of nodeIds) if (visit(id)) return true;
  return false;
}

function validateCanvasGraph({ nodes = [], edges = [], ops, nodeSchemas = DEFAULT_NODE_SCHEMAS } = {}) {
  const reasons = [];
  validateOps(ops, reasons);
  const nodeById = new Map();
  for (const n of nodes) {
    const nodeId = idOf(n, 'nodeId', 'id');
    if (!nodeId) { reasons.push(reason('INVALID_NODE_ID')); continue; }
    if (nodeById.has(nodeId)) reasons.push(reason('DUPLICATE_NODE_ID', { nodeId }));
    nodeById.set(nodeId, n);
    const kind = nodeKindOf(n), def = nodeSchemas && nodeSchemas[kind];
    if (!def) { reasons.push(reason('UNKNOWN_NODE_KIND', { nodeId, nodeKind: kind })); continue; }
    const version = versionOf(n);
    if (!Number.isInteger(version) || version !== def.version) reasons.push(reason('SCHEMA_VERSION_MISMATCH', { nodeId, nodeKind: kind, version, expected: def.version }));
  }
  const tupleSeen = new Set(), targetPortCount = new Map(), edgeIds = new Set();
  for (const raw of edges) {
    const e = edgeShape(raw);
    if (!e.edgeId || edgeIds.has(e.edgeId)) reasons.push(reason(e.edgeId ? 'DUPLICATE_EDGE_ID' : 'INVALID_EDGE_ID', { edgeId: e.edgeId }));
    edgeIds.add(e.edgeId);
    const source = nodeById.get(e.sourceNodeId), target = nodeById.get(e.targetNodeId);
    if (!source || !target) { reasons.push(reason('NODE_NOT_FOUND', { edgeId: e.edgeId, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId })); continue; }
    if (e.sourceNodeId === e.targetNodeId) reasons.push(reason('SELF_CONNECTION', { edgeId: e.edgeId, nodeId: e.sourceNodeId }));
    const sourceDef = nodeSchemas[nodeKindOf(source)], targetDef = nodeSchemas[nodeKindOf(target)];
    const outPort = sourceDef?.outputPorts?.find((x) => x.id === e.sourceHandle);
    const inPort = targetDef?.inputPorts?.find((x) => x.id === e.targetHandle);
    if (!outPort || !inPort) { reasons.push(reason('PORT_NOT_FOUND', { edgeId: e.edgeId, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })); continue; }
    if (!canConnect(outPort.type, inPort)) reasons.push(reason('TYPE_INCOMPATIBLE', { edgeId: e.edgeId, outType: outPort.type, inType: inPort.type }));
    const tuple = `${e.sourceNodeId}\0${e.sourceHandle}\0${e.targetNodeId}\0${e.targetHandle}`;
    if (tupleSeen.has(tuple)) reasons.push(reason('DUPLICATE_EDGE', { edgeId: e.edgeId })); else tupleSeen.add(tuple);
    const targetPort = `${e.targetNodeId}\0${e.targetHandle}`;
    targetPortCount.set(targetPort, (targetPortCount.get(targetPort) || 0) + 1);
  }
  for (const [port, count] of targetPortCount) if (count > 1) reasons.push(reason('CARDINALITY_EXCEEDED', { targetPort: port.replace('\0', ':'), count }));
  // Match the audited frontend policy: structural nodes are transparent; a path
  // through storyboard still forms a cycle. Only an all-structural component is
  // exempt, which cannot contain valid edges in the frozen schema today.
  const dataflowIds = [...nodeById].filter(([, n]) => nodeSchemas[nodeKindOf(n)]?.executionKind !== 'STRUCTURAL').map(([id]) => id);
  if (dataflowIds.length && hasDirectedCycle([...nodeById.keys()], edges)) reasons.push(reason('GRAPH_CYCLE'));
  return { ok: reasons.length === 0, reasons };
}

module.exports = { validateCanvasGraph, projectCanvasGraph, DEFAULT_NODE_SCHEMAS };
