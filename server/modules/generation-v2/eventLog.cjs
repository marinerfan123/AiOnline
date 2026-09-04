'use strict';
/**
 * L13 — generation_events append-only event log (module).
 *
 * The table + append-only trigger are owned by migration 0061. This module only
 * APPENDS (INSERT) and READS (replay by job_id); it never UPDATEs/DELETEs,
 * mirroring the DB-side trigger guarantee (§132「追加不删改」).
 *
 * payload_hash = SHA-256 of the CANONICAL JSON serialization of payload
 * (object keys sorted recursively). Deterministic across key order, so two
 * writers emitting the same logical event compute the same hash — the basis
 * for payload_hash 校验 on replay (a stored hash that no longer matches a
 * re-computed canonical hash signals tampering / divergence).
 *
 * Factory-free flat API (matches intake.cjs convention): appendEvent / listEvents.
 */

const crypto = require('crypto');

// Canonical JSON: arrays in order, objects with sorted keys, primitives via JSON.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function computePayloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

const INSERT_SQL = `
INSERT INTO generation_events
  (event_id, job_id, attempt_id, type, source, provider_event_id, payload_hash, created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id`;

const LIST_BY_JOB_SQL = `
SELECT event_id, job_id, attempt_id, type, source, provider_event_id, payload_hash, created_at
  FROM generation_events
 WHERE job_id = $1
 ORDER BY created_at ASC, event_id ASC
 LIMIT $2`;

const LIST_ALL_SQL = `
SELECT event_id, job_id, attempt_id, type, source, provider_event_id, payload_hash, created_at
  FROM generation_events
 ORDER BY created_at ASC, event_id ASC
 LIMIT $1`;

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function err(code, message) { return { ok: false, error: { code, message } }; }

function mapRow(row) {
  return {
    eventId: row.event_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    type: row.type,
    source: row.source,
    providerEventId: row.provider_event_id,
    payloadHash: row.payload_hash,
    createdAt: row.created_at,
  };
}

/**
 * Append one generation event (idempotent on event_id, §50 at-least-once).
 * @param {{pg:object, row:{eventId:string, jobId:string, attemptId?:string,
 *   type:string, source:string, providerEventId?:string,
 *   payload?:object, payloadHash?:string}}}
 * @returns {Promise<{ok:true, eventId:string, idempotent:boolean, payloadHash:string}
 *                   |{ok:false, error:{code,message}}>}
 */
async function appendEvent({ pg, row } = {}) {
  if (!pg || typeof pg.query !== 'function') return err('INVALID_PG', 'pg with query() required');
  if (!row || typeof row !== 'object') return err('INVALID_ROW', 'row object required');
  if (!isNonEmptyString(row.eventId)) return err('INVALID_EVENT_ID', 'row.eventId (non-empty string) required');
  if (!isNonEmptyString(row.jobId)) return err('INVALID_JOB_ID', 'row.jobId (non-empty string) required');
  if (!isNonEmptyString(row.type)) return err('INVALID_TYPE', 'row.type (non-empty string) required');
  if (!isNonEmptyString(row.source)) return err('INVALID_SOURCE', 'row.source (non-empty string) required');
  if (row.payload !== undefined && (row.payload === null || typeof row.payload !== 'object')) {
    return err('INVALID_PAYLOAD', 'row.payload must be an object when provided');
  }
  const payload = row.payload === undefined ? {} : row.payload;
  const payloadHash = computePayloadHash(payload);
  // payload_hash 校验：调用方显式携带 hash 时必须与计算值一致，防篡改/不一致落库。
  if (row.payloadHash !== undefined && row.payloadHash !== payloadHash) {
    return err('PAYLOAD_HASH_MISMATCH', 'row.payloadHash does not match computed SHA-256 of payload');
  }
  const r = await pg.query(INSERT_SQL, [
    row.eventId,
    row.jobId,
    row.attemptId ?? null,
    row.type,
    row.source,
    row.providerEventId ?? null,
    payloadHash,
  ]);
  const inserted = Number(r && r.rowCount) > 0;
  return { ok: true, eventId: row.eventId, idempotent: !inserted, payloadHash };
}

/**
 * Ordered replay read — scoped to a single job when jobId is given, otherwise
 * the whole log (debug/audit). Created_at ASC then event_id ASC for determinism.
 * @param {{pg:object, jobId?:string, limit?:number}}
 * @returns {Promise<{events:Array<{eventId,jobId,attemptId,type,source,providerEventId,payloadHash,createdAt}>}
 *                   |{ok:false, error:{code,message}}>}
 */
async function listEvents({ pg, jobId, limit = 500 } = {}) {
  if (!pg || typeof pg.query !== 'function') return err('INVALID_PG', 'pg with query() required');
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 500;
  const hasJob = isNonEmptyString(jobId);
  const r = hasJob
    ? await pg.query(LIST_BY_JOB_SQL, [jobId, lim])
    : await pg.query(LIST_ALL_SQL, [lim]);
  const events = (r && r.rows || []).map(mapRow);
  return { events };
}

module.exports = { appendEvent, listEvents, computePayloadHash, canonicalize };
