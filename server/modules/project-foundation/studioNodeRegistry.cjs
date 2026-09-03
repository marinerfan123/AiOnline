'use strict';
/**
 * M05-D1 — Server-side Studio node registry (mirror of M05-B1/B2 application registry).
 *
 * The browser registry (src/features/studio-v2/registry.ts) is the UI schema
 * authority; this mirror is the SERVER execution authority for the DAG
 * compiler and executor registry. It declares stable node identities,
 * executionKind, and typed ports — the compiler MUST read executionKind here,
 * never infer it from node names.
 *
 * Keep in sync with the B2 registry when node contracts change.
 */

// Port-type compatibility base table (M05-A contract — must match registry.ts).
const ACCEPTS = {
  IMAGE_SET: ['IMAGE'],
  SHOT: ['IMAGE', 'VIDEO'],
  SCENE: ['IMAGE', 'VIDEO', 'SCRIPT'],
};

function canConnect(outType, inType) {
  if (outType === inType) return true;
  return (ACCEPTS[inType] || []).includes(outType);
}

function canConnectToPort(outType, inPort) {
  if (inPort.acceptedTypes && inPort.acceptedTypes.length) return inPort.acceptedTypes.includes(outType);
  return canConnect(outType, inPort.type);
}

function port(id, type, input, required = false, acceptedTypes) {
  const p = { id, type, input, required: !!required };
  if (acceptedTypes) p.acceptedTypes = acceptedTypes;
  return p;
}

const SCHEMA_VERSIONS = {
  prompt: 1, script: 1, character: 1, reference: 1,
  'image-generation': 1, 'image-to-video': 1, 'text-to-video': 1,
  video: 1, output: 1, frame: 1,
};

// Stable B2 production core node set (10 identities).
const NODE_REGISTRY = {
  prompt: {
    id: 'prompt', version: SCHEMA_VERSIONS.prompt, executionKind: 'SOURCE',
    inputPorts: [port('text', 'TEXT', true, false)],
    outputPorts: [port('text', 'TEXT', false)],
    resultOutputs: ['TEXT'],
    // Deterministic M05-D1: resolves synchronously from compiled parameters.
    executorClass: 'deterministic-source',
  },
  script: {
    id: 'script', version: SCHEMA_VERSIONS.script, executionKind: 'SOURCE',
    inputPorts: [port('text', 'TEXT', true, false)],
    outputPorts: [port('script', 'SCRIPT', false), port('text', 'TEXT', false)],
    resultOutputs: ['SCRIPT', 'TEXT'],
    executorClass: 'deterministic-source',
  },
  character: {
    id: 'character', version: SCHEMA_VERSIONS.character, executionKind: 'SOURCE',
    inputPorts: [port('text', 'TEXT', true, false)],
    outputPorts: [port('character', 'CHARACTER', false), port('reference', 'REFERENCE', false)],
    resultOutputs: ['CHARACTER', 'REFERENCE'],
    executorClass: 'deterministic-source',
  },
  reference: {
    id: 'reference', version: SCHEMA_VERSIONS.reference, executionKind: 'ASSET',
    inputPorts: [port('text', 'TEXT', true, false)],
    outputPorts: [port('reference', 'REFERENCE', false), port('image', 'IMAGE', false)],
    resultOutputs: ['REFERENCE', 'ASSET_REF'],
    executorClass: 'deterministic-asset',
  },
  'image-generation': {
    id: 'image-generation', version: SCHEMA_VERSIONS['image-generation'], executionKind: 'GENERATION',
    inputPorts: [
      port('text', 'TEXT', true, true),
      port('reference', 'REFERENCE', true, false, ['REFERENCE', 'CHARACTER']),
      port('image', 'IMAGE', true, false),
    ],
    outputPorts: [port('image', 'IMAGE', false)],
    resultOutputs: ['IMAGE', 'ASSET_REF'],
    // M05-D1: NO production executor. M05-E bridges to Generation V2.
    executorClass: 'generation-bridge-pending',
  },
  'image-to-video': {
    id: 'image-to-video', version: SCHEMA_VERSIONS['image-to-video'], executionKind: 'GENERATION',
    inputPorts: [
      port('image', 'IMAGE', true, true),
      port('text', 'TEXT', true, false),
      port('reference', 'REFERENCE', true, false, ['REFERENCE', 'CHARACTER']),
    ],
    outputPorts: [port('video', 'VIDEO', false)],
    resultOutputs: ['VIDEO', 'ASSET_REF'],
    executorClass: 'generation-bridge-pending',
  },
  'text-to-video': {
    id: 'text-to-video', version: SCHEMA_VERSIONS['text-to-video'], executionKind: 'GENERATION',
    inputPorts: [
      port('text', 'TEXT', true, true),
      port('reference', 'REFERENCE', true, false, ['REFERENCE', 'CHARACTER']),
    ],
    outputPorts: [port('video', 'VIDEO', false)],
    resultOutputs: ['VIDEO', 'ASSET_REF'],
    executorClass: 'generation-bridge-pending',
  },
  video: {
    id: 'video', version: SCHEMA_VERSIONS.video, executionKind: 'ASSET',
    inputPorts: [port('video', 'VIDEO', true, false)],
    outputPorts: [port('video', 'VIDEO', false)],
    resultOutputs: ['VIDEO', 'ASSET_REF'],
    executorClass: 'deterministic-asset',
  },
  output: {
    id: 'output', version: SCHEMA_VERSIONS.output, executionKind: 'OUTPUT',
    inputPorts: [
      port('image', 'IMAGE', true, false),
      port('video', 'VIDEO', true, false),
      port('audio', 'AUDIO', true, false),
      port('text', 'TEXT', true, false),
      port('script', 'SCRIPT', true, false),
      port('json', 'JSON', true, false),
      port('asset', 'ASSET_REF', true, false),
    ],
    outputPorts: [],
    resultOutputs: ['IMAGE', 'VIDEO', 'AUDIO', 'TEXT', 'SCRIPT', 'JSON', 'ASSET_REF'],
    // Boundary/collector: completes when required upstream results exist.
    executorClass: 'collector',
  },
  frame: {
    id: 'frame', version: SCHEMA_VERSIONS.frame, executionKind: 'STRUCTURAL',
    inputPorts: [],
    outputPorts: [],
    resultOutputs: [],
    executorClass: null,
  },
};

function getNodeDef(nodeType) {
  return NODE_REGISTRY[nodeType] || null;
}

function isKnownNodeType(nodeType) {
  return Object.prototype.hasOwnProperty.call(NODE_REGISTRY, nodeType);
}

function expectedSchemaVersion(nodeType) {
  const def = NODE_REGISTRY[nodeType];
  return def ? def.version : null;
}

module.exports = {
  NODE_REGISTRY,
  getNodeDef,
  isKnownNodeType,
  expectedSchemaVersion,
  canConnect,
  canConnectToPort,
};
