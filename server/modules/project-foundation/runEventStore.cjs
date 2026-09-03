'use strict';
/**
 * G21 — Run event store: durable per-run SSE event log with monotonic
 * per-run sequence numbers, idempotent append and ordered replay reads.
 *
 * Gap analysis (audit 2026-09-03):
 *   - server/modules/project-foundation/studioRunEngine.cjs persists a durable
 *     trail into `studio_run_events` (migration 0015: id IDENTITY, run_id,
 *     run_node_id, event_type, payload) but NOTHING ever reads it back — there
 *     is no replay/resume reader anywhere in server/ (only the migration test
 *     touches that table). No server-side SSE event id / Last-Event-ID support
 *     exists (see Q6-HA-AUDIT.md P0-2).
 *   - Canonical SSE envelope lives in server/modules/studio-contracts/
 *     envelopes.cjs (§03.21): { sequence:int>=0, eventId, projectId, runId?,
 *     timestamp ISO, type, payload } with monotonic guard nextEventSequence()
 *     (starts at 1). Its sequence field is our per-run `seq`.
 *   - This module is a NEW run-scoped log (own table `run_events`, PK
 *     (run_id, seq)) that does NOT touch the existing `studio_run_events`
 *     table — gap-fill, no conflict with studioRunEngine's writer.
 *
 * Wire shape chosen (run-scoped slice of the canonical envelope):
 *   { runId, seq, type, payload }           ← stored row / listRunEvents item
 *   eventId = `${runId}:${seq}`             ← when bridging to the envelope
 *   type    = dotted convention ('run.started', 'run.node.started', ...)
 *   seq     = monotonic positive int, 1-based, per run (envelope.sequence)
 *
 * append is idempotent: a repeated (run_id, seq) is ignored and reported as
 * { ok:true, idempotent:true } (ON CONFLICT DO NOTHING → rowCount 0), so
 * at-least-once delivery / resume re-append never double-writes.
 *
 * Factory-injected pg ({ query }) — mirrors mediaWorker.cjs / continuityStore.cjs.
 */

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, seq)
)`;

// Per-run allocation counter. seq allocation MUST NOT read MAX(seq) over
// run_events: under READ COMMITTED a blocked statement keeps the snapshot it
// took before blocking, so a MAX(seq)+1 read sees a STALE value and two
// concurrent writers still collide (this is why an advisory-lock-alone fix
// failed a real-PG concurrency test — the lock serialized execution but not
// the snapshot). An atomic counter (INSERT … ON CONFLICT DO UPDATE … RETURNING)
// re-reads the latest committed row after acquiring the row lock, which is
// exactly the read-modify-write semantics allocation needs.
const CREATE_COUNTER_SQL = `
CREATE TABLE IF NOT EXISTS run_event_counters (
  run_id TEXT PRIMARY KEY,
  seq BIGINT NOT NULL
)`;

const INSERT_SQL = `
INSERT INTO run_events (run_id, seq, type, payload_json, created_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (run_id, seq) DO NOTHING`;

// Atomic seq allocation (audit 2026-09-04): read-last → write-last+1 is NOT
// atomic across concurrent writers (multiple Studio Worker replicas, and up to
// STUDIO_WORKER_CONCURRENCY parallel node runners within one process, emit for
// the SAME run simultaneously). A read-then-write allocator loses N-way races
// and drops events. This single statement atomically bumps a per-run counter
// and inserts the event in the same transaction:
//   - the counter's INSERT … ON CONFLICT (run_id) DO UPDATE SET seq = seq + 1
//     … RETURNING is a read-modify-write serialized by the counter row lock,
//     so concurrent writers each get a DISTINCT, contiguous seq (no snapshot
//     staleness — unlike a MAX(seq)+1 read under READ COMMITTED).
//   - the event INSERT and the counter bump commit together (one statement),
//     so a failed event insert never leaves a counter gap.
//   - ON CONFLICT (run_id, seq) DO NOTHING is belt-and-suspenders; with the
//     counter it is unreachable (seqs are unique per increment).
const APPEND_NEXT_SQL = `
WITH next AS (
  INSERT INTO run_event_counters (run_id, seq)
  VALUES ($1, 1)
  ON CONFLICT (run_id) DO UPDATE SET seq = run_event_counters.seq + 1
  RETURNING seq
)
INSERT INTO run_events (run_id, seq, type, payload_json, created_at)
SELECT $1, next.seq, $2, $3::jsonb, NOW()
FROM next
ON CONFLICT (run_id, seq) DO NOTHING
RETURNING seq`;

const LIST_SQL = `
SELECT run_id, seq, type, payload_json
  FROM run_events
 WHERE run_id = $1 AND seq > $2
 ORDER BY seq ASC
 LIMIT $3`;

const LAST_SEQ_SQL = `
SELECT COALESCE(MAX(seq), 0)::bigint AS seq
  FROM run_events
 WHERE run_id = $1`;

function isPosInt(v) { return Number.isInteger(v) && v > 0; }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function err(code, message) { return { ok: false, error: { code, message } }; }

function parsePayloadJson(v) {
  // node-pg returns jsonb already parsed; mocks may hand back strings.
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
  return v === undefined || v === null ? {} : v;
}

function createRunEventStore({ pg }) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createRunEventStore: { pg } with query() required');
  }

  // Memoized once per store instance so concurrent first appends share one CREATE.
  let schemaReady = null;
  function ensureSchema() {
    if (!schemaReady) schemaReady = pg.query(CREATE_TABLE_SQL).then(() => true);
    return schemaReady;
  }
  // The counter table is only needed by appendNextRunEvent (auto-seq) — kept
  // separate so callers that only use appendRunEvent / lastSequence /
  // listRunEvents never create it.
  let counterReady = null;
  function ensureCounterSchema() {
    if (!counterReady) counterReady = pg.query(CREATE_COUNTER_SQL).then(() => true);
    return counterReady;
  }

  /**
   * Append one run event.
   * @param {{runId:string, type:string, payload?:object, seq:number}}
   * @returns {Promise<{ok:true, idempotent:boolean, seq:number}
   *                   |{ok:false, error:{code,message}}>}
   */
  async function appendRunEvent({ runId, type, payload, seq } = {}) {
    if (!isNonEmptyString(runId)) return err('INVALID_RUN_ID', 'runId (non-empty string) required');
    if (!isNonEmptyString(type)) return err('INVALID_TYPE', 'type (non-empty string) required');
    if (!isPosInt(seq)) return err('INVALID_SEQ', `seq must be a positive integer, got ${JSON.stringify(seq)}`);
    let body = payload;
    if (body !== undefined && body !== null && typeof body !== 'object') {
      return err('INVALID_PAYLOAD', 'payload must be an object');
    }
    body = body === undefined ? {} : body;
    await ensureSchema();
    const r = await pg.query(INSERT_SQL, [runId, seq, type, JSON.stringify(body)]);
    const inserted = Number(r && r.rowCount) > 0;
    return { ok: true, idempotent: !inserted, seq };
  }

  /**
   * Append one run event with an atomically allocated next seq.
   * Replaces the racy read-last → write-last+1 sequence with a single
   * statement that bumps a per-run counter and inserts the event in the same
   * transaction (see APPEND_NEXT_SQL): no concurrent writer can allocate the
   * same seq, so N-way races cannot drop events and seq stays contiguous.
   * @param {{runId:string, type:string, payload?:object}}
   * @returns {Promise<{ok:true, idempotent:boolean, seq:(number|null)}
   *                   |{ok:false, error:{code,message}}>}
   *   idempotent:false + seq=n   → allocated and inserted at seq n.
   *   idempotent:true  + seq=null→ the computed seq was already occupied
   *     (unreachable with the atomic counter; only if a manual insert created
   *     a gap). Caller should re-allocate, not drop.
   */
  async function appendNextRunEvent({ runId, type, payload } = {}) {
    if (!isNonEmptyString(runId)) return err('INVALID_RUN_ID', 'runId (non-empty string) required');
    if (!isNonEmptyString(type)) return err('INVALID_TYPE', 'type (non-empty string) required');
    let body = payload;
    if (body !== undefined && body !== null && typeof body !== 'object') {
      return err('INVALID_PAYLOAD', 'payload must be an object');
    }
    body = body === undefined ? {} : body;
    await ensureSchema();
    await ensureCounterSchema();
    const r = await pg.query(APPEND_NEXT_SQL, [runId, type, JSON.stringify(body)]);
    const row = r && r.rows && r.rows[0];
    if (Number(r && r.rowCount) > 0 && row && row.seq != null) {
      return { ok: true, idempotent: false, seq: Number(row.seq) };
    }
    return { ok: true, idempotent: true, seq: null };
  }

  /**
   * Ordered replay slice — resume point is `afterSeq` (exclusive), mirroring
   * EventSource Last-Event-ID semantics at the run level.
   * @param {{runId:string, afterSeq?:number, limit?:number}}
   * @returns {Promise<{events:Array<{runId,seq,type,payload}>}>}
   */
  async function listRunEvents({ runId, afterSeq = 0, limit = 500 } = {}) {
    if (!isNonEmptyString(runId)) return err('INVALID_RUN_ID', 'runId (non-empty string) required');
    const after = Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 500;
    const r = await pg.query(LIST_SQL, [runId, after, lim]);
    const events = (r && r.rows || []).map((row) => ({
      runId: row.run_id,
      seq: Number(row.seq),
      type: row.type,
      payload: parsePayloadJson(row.payload_json),
    }));
    return { events };
  }

  /**
   * Highest seq persisted for a run (0 when the run has no events yet).
   * @param {{runId:string}}
   * @returns {Promise<{seq:number}>}
   */
  async function lastSequence({ runId } = {}) {
    if (!isNonEmptyString(runId)) return err('INVALID_RUN_ID', 'runId (non-empty string) required');
    const r = await pg.query(LAST_SEQ_SQL, [runId]);
    const row = r && r.rows && r.rows[0];
    return { seq: Number(row && row.seq) || 0 };
  }

  return { appendRunEvent, appendNextRunEvent, listRunEvents, lastSequence };
}

module.exports = {
  createRunEventStore,
  SQL: { CREATE_TABLE_SQL, CREATE_COUNTER_SQL, INSERT_SQL, APPEND_NEXT_SQL, LIST_SQL, LAST_SEQ_SQL },
};
