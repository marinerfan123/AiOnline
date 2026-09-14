'use strict';
/**
 * G00 — MOLING STUDIO Contract Freeze (Blueprint V2.0).
 * Canonical pure contract validators: Node/Port/Edge schema, Command envelope,
 * Public Error envelope, SSE Event envelope, Model Capability schema,
 * Project Format Version registry + migration registry stub.
 * Pure module (no I/O) — unit-testable in isolation, used by all later Gates.
 * Blueprint refs: 00 §6-8/20-21; 03 §3-7/16-22/28; 04 §1-2.
 */

const PORT_DATA_TYPES = Object.freeze([
  'text', 'image', 'video', 'audio', 'script', 'storyboard', 'mask',
  'character', 'scene', 'prop', 'style', 'camera', 'timeline', 'any-media',
]);

const PORT_SEMANTICS = Object.freeze([
  'prompt', 'reference', 'character_reference', 'scene_reference', 'prop_reference',
  'style_reference', 'lighting_reference', 'first_frame', 'last_frame',
  'audio_drive', 'source', 'mask', 'camera_reference', 'timeline_input',
]);

const NODE_TYPES_BASE = Object.freeze(['text', 'image', 'video', 'audio', 'script', 'storyboard', 'video-clip']);
const NODE_TYPES_MOLING = Object.freeze(['character', 'scene', 'prop', 'style', 'director-stage', 'frame-analysis', 'reference-board', 'timeline', 'export', 'note']);

const PUBLIC_ERROR_CODES = Object.freeze([
  'VALIDATION_', 'AUTH_', 'PERMISSION_', 'CONFLICT_REVISION', 'IDEMPOTENCY_CONFLICT',
  'GRAPH_CYCLE', 'PORT_INCOMPATIBLE', 'MODEL_UNAVAILABLE', 'MODEL_CAPABILITY_MISMATCH',
  'BILLING_', 'UPLOAD_', 'PROVIDER_', 'MEDIA_', 'ASSET_FINALIZE_', 'RUN_CANCELLED',
]);

const CAPABILITY_VIDEO_KEYS = Object.freeze([
  'video.text2video', 'video.image2video', 'video.frames2video', 'video.video2video',
  'video.audioDriven', 'video.mixedReference', 'video.nativeAudio',
  'video.segmentReshoot', 'video.rewrite',
]);

const CAPABILITY_REFERENCE_LIMIT_KEYS = Object.freeze([
  'reference.image.max', 'reference.video.max', 'reference.audio.max',
]);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v >= 0;
const isIsoTs = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/* ── Node / Edge schema (00 §6; 03 §5-6) ─────────────────────────── */

function validateNodeEnvelope(n) {
  const errs = [];
  if (!isObject(n)) return { ok: false, errors: ['node envelope must be an object'] };
  if (!isNonEmptyString(n.id)) errs.push('id required');
  if (!isNonEmptyString(n.canvasId)) errs.push('canvasId required');
  if (!isNonEmptyString(n.nodeType)) errs.push('nodeType required');
  if (n.entityType !== undefined && !isNonEmptyString(n.entityType)) errs.push('entityType must be string');
  if (n.entityId !== undefined && !isNonEmptyString(n.entityId)) errs.push('entityId must be string');
  if (n.entityType === undefined || n.entityId === undefined) { /* entityRef optional for base nodes */ }
  if (!isObject(n.position) || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y)) {
    errs.push('position {x,y} required');
  }
  if (n.size !== undefined && (!isObject(n.size) || !(n.size.width > 0) || !(n.size.height > 0))) {
    errs.push('size {width,height} must be positive');
  }
  if (!('data' in n)) errs.push('data required');
  if (!isObject(n.uiState)) errs.push('uiState must be an object');
  if (!isPosInt(n.revision)) errs.push('revision (int >=0) required');
  if (!isIsoTs(n.createdAt)) errs.push('createdAt ISO required');
  if (!isIsoTs(n.updatedAt)) errs.push('updatedAt ISO required');
  return { ok: errs.length === 0, errors: errs };
}

function isPortDataType(t) { return PORT_DATA_TYPES.includes(t); }
function isPortSemantic(s) { return PORT_SEMANTICS.includes(s); }
function isKnownNodeType(t) { return NODE_TYPES_BASE.includes(t) || NODE_TYPES_MOLING.includes(t); }

function validateEdgeRecord(e) {
  const errs = [];
  if (!isObject(e)) return { ok: false, errors: ['edge must be an object'] };
  for (const f of ['id', 'canvasId', 'sourceNodeId', 'sourcePortId', 'targetNodeId', 'targetPortId', 'relationType']) {
    if (!isNonEmptyString(e[f])) errs.push(`${f} required`);
  }
  if (e.sourceNodeId === e.targetNodeId) errs.push('sourceNodeId must differ from targetNodeId');
  if (!isPosInt(e.ordering ?? 0)) errs.push('ordering int required');
  if (e.metadataJson !== undefined && !isObject(e.metadataJson)) errs.push('metadataJson must be object');
  if (!isPosInt(e.revision ?? 0)) errs.push('revision int required');
  return { ok: errs.length === 0, errors: errs };
}

/* ── Command envelope (00 §8; 03 §18) ────────────────────────────── */

function validateCommand(cmd) {
  const errs = [];
  if (!isObject(cmd)) return { ok: false, errors: ['command must be an object'] };
  for (const f of ['commandId', 'projectId', 'type', 'idempotencyKey']) {
    if (!isNonEmptyString(cmd[f])) errs.push(`${f} required`);
  }
  if (!isObject(cmd.actor) || !isNonEmptyString(cmd.actor.id)) errs.push('actor.id required');
  if (cmd.canvasId !== undefined && !isNonEmptyString(cmd.canvasId)) errs.push('canvasId must be string');
  if (cmd.expectedRevision !== undefined && !isPosInt(cmd.expectedRevision)) errs.push('expectedRevision int required');
  if (!('payload' in cmd)) errs.push('payload required');
  if (cmd.clientTimestamp !== undefined && !isIsoTs(cmd.clientTimestamp)) errs.push('clientTimestamp ISO required');
  return { ok: errs.length === 0, errors: errs };
}

const COMMAND_TYPES = Object.freeze([
  'canvas.viewport.update', 'node.create', 'node.move', 'node.resize', 'node.update',
  'node.delete', 'edge.create', 'edge.delete', 'group.create', 'group.update',
  'group.delete', 'group.run', 'workflow.save', 'workflow.apply',
  'script.row.create', 'script.row.update', 'script.row.delete', 'script.row.reorder',
  'shot.create', 'shot.update', 'asset.bindActiveVersion',
  'director.object.create', 'director.object.update', 'director.object.delete',
  'director.camera.update', 'director.light.update',
  'timeline.clip.create', 'timeline.clip.update', 'timeline.clip.delete',
  'timeline.track.create', 'timeline.track.update', 'timeline.track.delete',
  'run.create', 'run.cancel', 'run.retry',
]);

function isKnownCommandType(t) { return COMMAND_TYPES.includes(t); }

/* ── Public Error envelope (03 §22) ──────────────────────────────── */

function validatePublicError(err) {
  const errs = [];
  if (!isObject(err)) return { ok: false, errors: ['error must be an object'] };
  if (!isNonEmptyString(err.code) || !PUBLIC_ERROR_CODES.some((p) => err.code.startsWith(p))) {
    errs.push(`code must start with one of: ${PUBLIC_ERROR_CODES.join(', ')}`);
  }
  if (!isNonEmptyString(err.message)) errs.push('message required');
  if (typeof err.retryable !== 'boolean') errs.push('retryable boolean required');
  if (!isNonEmptyString(err.traceId)) errs.push('traceId required');
  if (err.recommendedAction !== undefined && !isNonEmptyString(err.recommendedAction)) errs.push('recommendedAction must be string');
  if (err.details !== undefined && !isObject(err.details)) errs.push('details must be object');
  return { ok: errs.length === 0, errors: errs };
}

/* ── SSE Event envelope (03 §21) ─────────────────────────────────── */

function validateEventEnvelope(evt) {
  const errs = [];
  if (!isObject(evt)) return { ok: false, errors: ['event must be an object'] };
  if (!isPosInt(evt.sequence)) errs.push('sequence int required');
  if (!isNonEmptyString(evt.eventId)) errs.push('eventId required');
  if (!isNonEmptyString(evt.projectId)) errs.push('projectId required');
  if (evt.runId !== undefined && !isNonEmptyString(evt.runId)) errs.push('runId must be string');
  if (!isIsoTs(evt.timestamp)) errs.push('timestamp ISO required');
  if (!isNonEmptyString(evt.type)) errs.push('type required');
  if (!('payload' in evt)) errs.push('payload required');
  return { ok: errs.length === 0, errors: errs };
}

/** Monotonic sequence guard: next must equal last+1 (per-project). */
function nextEventSequence(last) {
  if (last === undefined || last === null) return 1;
  if (!isPosInt(last)) throw new TypeError('last must be int >= 0');
  return last + 1;
}

/* ── Model Capability schema (04 §1) ─────────────────────────────── */

function validateModelCapability(cap) {
  const errs = [];
  if (!isObject(cap)) return { ok: false, errors: ['capability must be an object'] };
  for (const k of CAPABILITY_VIDEO_KEYS) {
    if (k in cap && typeof cap[k] !== 'boolean') errs.push(`${k} must be boolean`);
  }
  if ('video.maxDurationMs' in cap && !(Number.isFinite(cap['video.maxDurationMs']) && cap['video.maxDurationMs'] > 0)) {
    errs.push('video.maxDurationMs must be positive number');
  }
  for (const k of CAPABILITY_REFERENCE_LIMIT_KEYS) {
    if (k in cap && !(Number.isInteger(cap[k]) && cap[k] >= 0)) errs.push(`${k} must be int >= 0`);
  }
  if ('camera.structuredControl' in cap && typeof cap['camera.structuredControl'] !== 'boolean') {
    errs.push('camera.structuredControl must be boolean');
  }
  return { ok: errs.length === 0, errors: errs };
}

/* ── Project Format Version (00 §21; 03 §28) ─────────────────────── */

const FORMAT_REGISTRY = Object.freeze({ node: 1, workflow: 1, directorScene: 1, backup: 1 });

/** Every persisted JSON payload must carry a numeric schemaVersion. */
function requireSchemaVersion(obj) {
  if (!isObject(obj)) return { ok: false, errors: ['payload must be object'] };
  if (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion < 1) {
    return { ok: false, errors: ['payload.schemaVersion (int >=1) required'] };
  }
  return { ok: true, errors: [] };
}

/** Migration registry (00 §21: v1→v2→v3). Register stepwise migrators. */
const _migrators = new Map(); // name -> [{from, to, fn}]
function registerMigration(kind, from, to, fn) {
  if (!(kind in FORMAT_REGISTRY)) throw new TypeError(`unknown format kind: ${kind}`);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to !== from + 1) {
    throw new TypeError('migrations must step +1');
  }
  if (typeof fn !== 'function') throw new TypeError('migrator fn required');
  const chain = _migrators.get(kind) || [];
  if (chain.some((s) => s.from === from)) throw new TypeError(`migration ${kind} ${from} already registered`);
  chain.push({ from, to, fn });
  chain.sort((a, b) => a.from - b.from);
  _migrators.set(kind, chain);
}

/** Run the full chain fromVersion→toVersion (must be strictly forward). */
function migratePayload(kind, payload, toVersion) {
  const base = requireSchemaVersion(payload);
  if (!base.ok) return base;
  const from = payload.schemaVersion;
  if (!Number.isInteger(toVersion) || toVersion < from) return { ok: false, errors: ['toVersion must be >= current'] };
  const chain = (_migrators.get(kind) || []).filter((s) => s.from >= from && s.to <= toVersion);
  let data = payload;
  for (const step of chain) {
    data = step.fn(data);
    if (!isObject(data) || data.schemaVersion !== step.to) {
      return { ok: false, errors: [`migrator ${kind} ${step.from}->${step.to} must set schemaVersion=${step.to}`] };
    }
  }
  return { ok: data.schemaVersion === toVersion, errors: data.schemaVersion === toVersion ? [] : ['chain stopped short'], data };
}

module.exports = {
  PORT_DATA_TYPES, PORT_SEMANTICS, NODE_TYPES_BASE, NODE_TYPES_MOLING,
  PUBLIC_ERROR_CODES, COMMAND_TYPES, FORMAT_REGISTRY,
  validateNodeEnvelope, isPortDataType, isPortSemantic, isKnownNodeType,
  validateEdgeRecord, validateCommand, isKnownCommandType, validatePublicError,
  validateEventEnvelope, nextEventSequence, validateModelCapability,
  requireSchemaVersion, registerMigration, migratePayload,
};
