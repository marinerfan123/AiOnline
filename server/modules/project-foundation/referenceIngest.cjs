'use strict';
/**
 * W2-04 — Reference ingest adapters (pure, no I/O).
 *
 * Converts supported inputs (uploaded files / images / URLs / text narrative)
 * into DURABLE record payloads that the API layer persists:
 *   - project_references   (project-scoped reference, W2-03)
 *   - media asset rows     (assetFoundation authority) optionally wrapped with
 *     asset_rights provenance/origin metadata (W2-05)
 *
 * Design notes:
 *   - This module is intentionally PURE (no fs / net / db). Every function is
 *     deterministic, so the ingest matrix, provenance linking, upload retry
 *     classification and idempotency are all unit-testable with `node --test`.
 *   - A caller (route handler) performs the actual persistence. Deterministic
 *     asset/reference/idempotency ids mean a retry after a transient failure
 *     reuses the SAME primary keys, so re-running an ingest is idempotent.
 *   - Unsupported input kinds fail explicitly (code UNSUPPORTED_INPUT).
 */

const crypto = require('crypto');
const { REFERENCE_TYPES, validateReference } = require('./reference.cjs');
const { validateAssetRights, ORIGINS } = require('./assetRights.cjs');

const REFERENCE_TYPE_SET = new Set(REFERENCE_TYPES);

/** Input kinds supported by the ingest adapters. */
const INPUT_KINDS = ['image', 'video', 'audio', 'file', 'url', 'text'];
/** Kinds that materialize a media asset (plus rights + a linking reference). */
const ASSET_KINDS = ['image', 'video', 'audio', 'file', 'url'];
/** Kinds that produce a project_reference only (no asset). */
const REFERENCE_ONLY_KINDS = ['text'];

/**
 * Ingest matrix: supported input kind → produced durable record shape.
 *   assetType          media/asset type in the assetFoundation projection
 *   rightsOrigin       valid asset_rights.origin (from assetRights.cjs ORIGINS)
 *   assetOrigin        media.origin projection value (UPLOAD | IMPORT)
 *   defaultReferenceType  project_reference type when caller does not specify one
 */
const INGEST_MATRIX = Object.freeze({
  image: { assetType: 'IMAGE', rightsOrigin: 'uploaded', assetOrigin: 'UPLOAD', defaultReferenceType: 'style' },
  video: { assetType: 'VIDEO', rightsOrigin: 'uploaded', assetOrigin: 'UPLOAD', defaultReferenceType: 'motion' },
  audio: { assetType: 'AUDIO', rightsOrigin: 'uploaded', assetOrigin: 'UPLOAD', defaultReferenceType: 'audio' },
  file:  { assetType: 'OTHER', rightsOrigin: 'uploaded', assetOrigin: 'UPLOAD', defaultReferenceType: 'object' },
  url:   { assetType: 'IMAGE', rightsOrigin: 'imported', assetOrigin: 'IMPORT', defaultReferenceType: 'style' },
  // text → reference-only: no asset materialized.
  text:  { assetType: null, rightsOrigin: null, assetOrigin: null, defaultReferenceType: null },
});

/** Retry classification — transient (recoverable) errors vs permanent ones. */
const RETRYABLE_CODES = new Set([
  'NETWORK', 'TIMEOUT', 'OSS_UNAVAILABLE', 'RATE_LIMITED',
  'HTTP_5XX', 'CONNECTION_RESET', 'TRANSIENT',
]);

/** Unsupported / permanently-fatal ingest intents. */
function unsupportedInputError(kind) {
  const message = `Unsupported ingest input kind '${kind}'. Supported kinds: ${INPUT_KINDS.join(', ')}`;
  return { ok: false, error: { code: 'UNSUPPORTED_INPUT', message, retryable: false } };
}

function invalidIntentError(msg) {
  return { ok: false, error: { code: 'INVALID_INTENT', message: msg, retryable: false } };
}

function hasValidHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Normalize + validate a raw ingest intent into a canonical shape.
 * Returns { ok: true, value } or { ok: false, error }.
 */
function normalizeIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    return invalidIntentError('ingest intent must be an object');
  }
  const kind = String(intent.kind || '').trim().toLowerCase();
  if (!INPUT_KINDS.includes(kind)) return unsupportedInputError(kind || '(empty)');

  const value = {
    kind,
    projectId: String(intent.projectId || intent.project_id || '').trim(),
    name: intent.name !== undefined ? String(intent.name).trim() : undefined,
    title: intent.title !== undefined ? String(intent.title).trim() : undefined,
    role: intent.role !== undefined ? String(intent.role).trim() : undefined,
    source: intent.source !== undefined ? String(intent.source).trim() : undefined,
    referenceType: intent.referenceType !== undefined ? String(intent.referenceType).trim().toLowerCase() : undefined,
    assetType: intent.assetType !== undefined ? String(intent.assetType).trim().toUpperCase() : undefined,
    mimeType: intent.mimeType || intent.mime_type ? String(intent.mimeType || intent.mime_type).trim() : undefined,
    sizeBytes: intent.sizeBytes === undefined ? undefined : parseInt(intent.sizeBytes, 10),
    fileName: intent.fileName !== undefined ? String(intent.fileName).trim() : undefined,
    url: intent.url !== undefined ? String(intent.url).trim() : undefined,
    text: intent.text !== undefined ? String(intent.text).trim() : undefined,
    contentHash: intent.contentHash !== undefined ? String(intent.contentHash).trim().toLowerCase() : undefined,
    asReference: intent.asReference === true,
    skipReference: intent.skipReference === true,
    referenceId: intent.referenceId !== undefined ? String(intent.referenceId).trim() : undefined,
    assetId: intent.assetId !== undefined ? String(intent.assetId).trim() : undefined,
  };

  if (!value.projectId) return invalidIntentError('projectId is required');

  if (value.referenceType && !REFERENCE_TYPE_SET.has(value.referenceType)) {
    return invalidIntentError(`referenceType must be one of ${REFERENCE_TYPES.join(', ')}`);
  }

  if (kind === 'text') {
    if (!value.text) return invalidIntentError('text is required for text ingest');
    return { ok: true, value };
  }

  if (kind === 'url') {
    if (!value.url) return invalidIntentError('url is required for url ingest');
    if (!hasValidHttpUrl(value.url)) return invalidIntentError('url must be a valid http(s) URL');
    return { ok: true, value };
  }

  // File kinds (image/video/audio/file): file metadata is optional; the ingest
  // works on the declared kind alone (the actual bytes are the caller's concern).
  return { ok: true, value };
}

/** Deterministic idempotency key derived from the canonical intent. */
function computeIngestKey(intent) {
  const n = normalizeIntent(intent);
  if (!n.ok) throw new Error('cannot compute ingest key for invalid intent');
  const v = n.value;
  // contentHash wins (a content-derived dedupe); otherwise a stable set of
  // upload discriminators keeps retries producing the same logical key.
  const fileDiscriminator = v.contentHash || [v.kind, v.fileName, v.mimeType, v.sizeBytes].join('/');
  const canonical = [
    v.kind, v.projectId, v.referenceType || '', v.assetType || '',
    v.name || '', v.title || '', v.text || '', v.url || '', fileDiscriminator,
  ].join('\u0000');
  return 'ingest-' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Deterministic asset/reference primary-key ids tied to the ingest key.
 * Because retries reuse the same key, they reuse the SAME ids → idempotent upserts.
 */
function ingestIds(intent) {
  const key = computeIngestKey(intent);
  return {
    ingestKey: key,
    assetId: 'asg-' + crypto.createHash('sha256').update(key + ':asset').digest('hex').slice(0, 24),
    referenceId: 'ref-' + crypto.createHash('sha256').update(key + ':reference').digest('hex').slice(0, 24),
  };
}

const ASSET_TYPE_TO_LEGACY = { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', OTHER: 'other' };
const ASSET_TYPES = new Set(Object.keys(ASSET_TYPE_TO_LEGACY));

function referenceNameFor(intent, matrix) {
  if (intent.name) return intent.name;
  if (intent.title) return intent.title;
  if (intent.kind === 'text') {
    const t = intent.text.slice(0, 60);
    return t.length >= 60 ? t + '…' : t;
  }
  return defaultReferenceLabel(intent.referenceType || matrix.defaultReferenceType, intent.kind);
}

function defaultReferenceLabel(refType, kind) {
  const label = refType ? refType.charAt(0).toUpperCase() + refType.slice(1) : 'Reference';
  return `${label} (${kind})`;
}

/** Build the asset (media-row) payload for a materialized input. */
function buildAsset(intent, matrix, ids) {
  const assetType = intent.assetType || matrix.assetType;
  const isUrl = intent.kind === 'url';
  const url = isUrl ? intent.url : intent.url || '';
  return {
    id: ids.assetId,
    projectId: intent.projectId,
    ownerId: undefined, // populated by the API layer from sessionUser
    assetType,
    type: ASSET_TYPE_TO_LEGACY[assetType] || 'other',
    mimeType: intent.mimeType || defaultMimeFor(assetType),
    sizeBytes: intent.sizeBytes || 0,
    url,
    origin: matrix.assetOrigin,            // UPLOAD | IMPORT
    source: isUrl ? 'url' : 'upload',      // durable provenance/origin marker
    status: isUrl ? 'ready' : 'pending_upload', // pending_upload ⇒ recoverable via reaper
    kind: intent.kind,
  };
}

function defaultMimeFor(assetType) {
  switch (assetType) {
    case 'IMAGE': return 'image/png';
    case 'VIDEO': return 'video/mp4';
    case 'AUDIO': return 'audio/mpeg';
    default: return 'application/octet-stream';
  }
}

/**
 * Build + validate the asset_rights record (W2-05) carrying provenance/origin and
 * a link to the reference it grounds. Returns { ok, record, errors } style.
 */
function buildAssetRights(intent, asset, reference, ids) {
  const rights = {
    asset_id: asset.id,
    origin: matrixRightsOrigin(intent),            // 'uploaded' | 'imported' | 'generated'
    uploaded_by: undefined,                          // API layer fills from sessionUser
    provider: intent.kind === 'url' ? 'external_url' : null,
    model: null,
    generation_id: null,
    reference_assets: reference ? [reference.id] : [],
    owner: undefined,
    license: intent.commercialUsage === true ? 'commercial' : null,
    consent: intent.consent && typeof intent.consent === 'object' ? intent.consent : {},
    commercial_usage: intent.commercialUsage === true,
    // provenance/origin metadata link (read-model copy for the durable record)
    provenance: buildProvenance(intent, asset, reference, ids),
  };
  const v = validateAssetRights(rights);
  return { ok: v.ok, record: rights, errors: v.errors };
}

function matrixRightsOrigin(intent) {
  const matrix = INGEST_MATRIX[intent.kind];
  return matrix && matrix.rightsOrigin ? matrix.rightsOrigin : 'imported';
}

/**
 * Provenance / origin metadata that links an ingest to its durable outputs.
 * Pure — no timestamps; the caller stamps persistence time.
 */
function buildProvenance(intent, asset, reference, ids) {
  return {
    ingestKey: ids.ingestKey,
    inputKind: intent.kind,
    origin: matrixRightsOrigin(intent),
    source: intent.kind === 'text' ? 'narrative' : intent.kind === 'url' ? 'url' : 'upload',
    sourceUrl: intent.kind === 'url' ? intent.url : null,
    sourceId: intent.url || null,
    assetId: asset ? asset.id : null,
    referenceId: reference ? reference.id : null,
    referenceAssets: reference ? [reference.id] : [],
    referenceType: reference ? reference.type : null,
  };
}

/** Build + validate the project_references record (W2-03). */
function buildReference(intent, matrix, ids, asset) {
  const refType = intent.referenceType || matrixDefaultRefType(intent);
  const attributes = {};
  if (asset) attributes.assetId = asset.id;
  if (intent.kind === 'url') attributes.url = intent.url;
  if (intent.kind === 'text') attributes.narrative = intent.text;
  attributes.ingestKey = ids.ingestKey;

  const ref = {
    id: intent.referenceId || ids.referenceId,
    project_id: intent.projectId,
    type: refType,
    name: referenceNameFor(intent, matrix),
    role: intent.role,
    source: referenceSourceFor(intent),
    source_id: asset ? asset.id : intent.kind === 'url' ? intent.url : null,
    attributes,
  };
  const v = validateReference(ref);
  return { ok: v.ok, record: ref, errors: v.errors };
}

function matrixDefaultRefType(intent) {
  const matrix = INGEST_MATRIX[intent.kind];
  return (matrix && matrix.defaultReferenceType) || 'style';
}

function referenceSourceFor(intent) {
  if (intent.source) return intent.source;
  if (intent.kind === 'text') return 'narrative';
  if (intent.kind === 'url') return 'url';
  return 'upload';
}

/**
 * Entry point: plan a durable ingest from a supported input intent.
 *
 * Returns { ok: true, plan } where plan = {
 *   kind: 'reference' | 'asset' | 'asset+reference',
 *   ingestKey, asset, assetRights, reference, provenance,
 * }
 * or { ok: false, error: { code, message, retryable } } for unsupported/invalid input.
 */
function planIngest(intent) {
  const n = normalizeIntent(intent);
  if (!n.ok) return n;
  const v = n.value;

  if (v.kind === 'text') {
    return planTextReference(v);
  }
  if (v.kind === 'url' && v.asReference) {
    return planUrlReference(v);
  }
  if (v.kind === 'url' && v.skipReference) {
    return planAssetOnly(v);
  }
  return planAssetWithReference(v);
}

function planTextReference(intent) {
  const matrix = INGEST_MATRIX.text;
  const ids = ingestIds(intent);
  const ref = buildReference(intent, matrix, ids, null);
  if (!ref.ok) return validationFail('REFERENCE', ref.errors);
  return {
    ok: true,
    plan: {
      kind: 'reference',
      ingestKey: ids.ingestKey,
      reference: ref.record,
      asset: null,
      assetRights: null,
      provenance: buildProvenance(intent, null, ref.record, ids),
    },
  };
}

function planUrlReference(intent) {
  // URL materialized as a project_reference without a persisted asset row.
  const matrix = INGEST_MATRIX.url;
  const ids = ingestIds(intent);
  const ref = buildReference(intent, matrix, ids, null);
  if (!ref.ok) return validationFail('REFERENCE', ref.errors);
  return {
    ok: true,
    plan: {
      kind: 'reference',
      ingestKey: ids.ingestKey,
      reference: ref.record,
      asset: null,
      assetRights: null,
      provenance: buildProvenance(intent, null, ref.record, ids),
    },
  };
}

function planAssetOnly(intent) {
  const matrix = INGEST_MATRIX[intent.kind];
  const ids = ingestIds(intent);
  const asset = buildAsset(intent, matrix, ids);
  const rights = buildAssetRights(intent, asset, null, ids);
  if (!rights.ok) return validationFail('ASSET_RIGHTS', rights.errors);
  return {
    ok: true,
    plan: {
      kind: 'asset',
      ingestKey: ids.ingestKey,
      asset,
      assetRights: rights.record,
      reference: null,
      provenance: buildProvenance(intent, asset, null, ids),
    },
  };
}

function planAssetWithReference(intent) {
  const matrix = INGEST_MATRIX[intent.kind];
  if (!matrix) return unsupportedInputError(intent.kind);
  const ids = ingestIds(intent);
  const asset = buildAsset(intent, matrix, ids);
  const ref = buildReference(intent, matrix, ids, asset);
  if (!ref.ok) return validationFail('REFERENCE', ref.errors);
  const rights = buildAssetRights(intent, asset, ref.record, ids);
  if (!rights.ok) return validationFail('ASSET_RIGHTS', rights.errors);
  return {
    ok: true,
    plan: {
      kind: ASSET_KINDS.includes(intent.kind) ? 'asset+reference' : 'asset',
      ingestKey: ids.ingestKey,
      asset,
      assetRights: rights.record,
      reference: ref.record,
      provenance: buildProvenance(intent, asset, ref.record, ids),
    },
  };
}

function validationFail(which, errors) {
  return { ok: false, error: { code: 'VALIDATION', message: `${which} invalid: ${errors.join('; ')}`, retryable: false } };
}

// ── Upload retry / recoverability (pure) ────────────────────────────────────

/**
 * Classify any ingest/upload error into a retry decision.
 * Accepts an Error or a shaped { code, retryable, httpStatus, message } object.
 */
function classifyIngestError(error) {
  // Real Error instance → classify from the message text.
  if (error instanceof Error) {
    const m = String(error.message || error).toLowerCase();
    const retryable = /network|timeout|timed out|reset by peer|econn|eai_again|temporarily unavailable|rate limit|too many requests|socket hang up|osserror|5[0-9][0-9]|unavailable/.test(m);
    return { code: retryable ? 'TRANSIENT' : 'UNKNOWN', retryable, message: error.message || String(error) };
  }
  // Shaped { code, retryable, httpStatus, message } error object.
  if (error && typeof error === 'object') {
    const code = error.code !== undefined ? String(error.code) : 'HTTP_ERROR';
    const httpStatus = Number(error.httpStatus) || 0;
    if (error.retryable === true) return { code, retryable: true, message: error.message || '' };
    if (RETRYABLE_CODES.has(code)) return { code, retryable: true, message: error.message || '' };
    if (httpStatus === 429) return { code, retryable: true, message: error.message || 'rate limited' };
    if (httpStatus >= 500 && httpStatus < 600) return { code, retryable: true, message: error.message || 'server error' };
    return { code, retryable: false, message: error.message || '' };
  }
  return { code: 'UNKNOWN', retryable: false, message: String(error || '') };
}

/** Convenience predicate for "can this ingest failure be retried?" */
function isRetryableIngestError(error) {
  return classifyIngestError(error).retryable;
}

/**
 * Pure retry-policy / idempotent state machine.
 *   opts.attempts     number of attempts ALREADY made (1 = one failure so far)
 *   opts.maxAttempts  total attempts allowed before giving up (default 5)
 *   opts.baseDelayMs  first backoff (default 1000)
 *   opts.maxDelayMs   backoff ceiling (default 60000)
 *   opts.jitter       fraction [0..1) of backoff randomized (default 0.25)
 *   opts.random       injectable RNG for deterministic tests (default Math.random)
 * Returns { shouldRetry, reason, nextAttempt, backoffMs }.
 */
function buildRetryPolicy(opts = {}) {
  const attempts = Number.isFinite(opts.attempts) ? Math.max(0, opts.attempts) : 0;
  const maxAttempts = opts.maxAttempts == null ? 5 : Math.max(1, opts.maxAttempts);
  const baseDelayMs = opts.baseDelayMs == null ? 1000 : Math.max(0, opts.baseDelayMs);
  const maxDelayMs = opts.maxDelayMs == null ? 60000 : Math.max(0, opts.maxDelayMs);
  const jitter = opts.jitter == null ? 0.25 : Math.max(0, Math.min(0.95, opts.jitter));

  const shouldRetry = attempts < maxAttempts;
  const exponent = Math.min(Math.max(0, attempts - 1 /* 0-based after each failure */), 30);
  let backoffMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exponent));
  if (jitter > 0) {
    const rand = typeof opts.random === 'function' ? opts.random : Math.random;
    const range = backoffMs * jitter;
    backoffMs = Math.max(0, Math.round(backoffMs - range + rand() * (2 * range)));
  }
  return {
    shouldRetry,
    reason: shouldRetry ? 'retryable' : 'max_attempts_exhausted',
    nextAttempt: shouldRetry ? attempts + 1 : attempts,
    backoffMs,
  };
}

/** Convenience: is this classify result something the retry policy should act on? */
function ingestPlanError(plan) {
  return plan && plan.ok === false ? plan.error : null;
}

module.exports = {
  INPUT_KINDS,
  ASSET_KINDS,
  REFERENCE_ONLY_KINDS,
  REFERENCE_TYPES,
  INGEST_MATRIX,
  ORIGINS,
  normalizeIntent,
  computeIngestKey,
  ingestIds,
  planIngest,
  buildAsset,
  buildReference,
  buildAssetRights,
  buildProvenance,
  classifyIngestError,
  isRetryableIngestError,
  buildRetryPolicy,
  ingestPlanError,
};
