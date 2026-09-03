'use strict';
/**
 * G21 — Run event relay: the seq-allocating writer in front of runEventStore.
 *
 * Roles (see also runEventStore.cjs header):
 *   - runEventStore.appendRunEvent  requires a caller-supplied `seq`; it never
 *     allocates. Its (run_id, seq) PK + `ON CONFLICT DO NOTHING` make a
 *     repeated append at an existing seq a no-op reported as
 *     { ok:true, idempotent:true } — i.e. the store is idempotent but does
 *     NOT hand out sequence numbers.
 *   - this relay is the single seq allocator: seq = lastSequence(runId) + 1,
 *     then appendRunEvent. Callers (studioRunEngine's emitEvent funnel, etc.)
 *     never see or choose seqs.
 *
 * Event shape (bridged from studioRunEngine.emitEvent):
 *   engine : emitEvent(client, runId, runNodeId, eventType, payload)
 *            → durable `studio_run_events` row  (run_id, run_node_id, event_type, payload)
 *   relay  : relayRunEvent({ runId, type, payload })
 *            → durable `run_events` row         (run_id, seq, type, payload_json)
 *   type   = the engine eventType verbatim ('studio.run.started',
 *            'studio.run_node.started', ...) — relay treats it as opaque.
 *   payload = engine payload object; when bridging, fold runNodeId in as
 *            { ...(runNodeId ? { run_node_id: runNodeId } : {}), ...payload }
 *            so replayed events carry node identity like studio_run_events does.
 *
 * SEQ ALLOCATION RACE (read-last → write-last+1 is not atomic):
 *   Two concurrent relays can read the same lastSequence and both attempt the
 *   same next seq. The loser's INSERT hits the (run_id, seq) PK conflict and
 *   appendRunEvent returns idempotent:true. The relay then distinguishes:
 *     - the row already at that seq IS our event (same type + deep-equal
 *       payload) → duplicate delivery of one logical event; store idempotency
 *       absorbs it. We return { ok:true, seq, idempotent:true } WITHOUT
 *       allocating a new seq (spec: repeated same (runId, seq) handled by the
 *       store).
 *     - a DIFFERENT event won the slot (true race) → re-read lastSequence and
 *       retry the allocate+append cycle (bounded: RACE_RETRY_LIMIT extra
 *       attempts — spec: PK conflict → retry once). No event is dropped.
 *   A still-contended slot after the bounded retries is reported as an error
 *   rather than silently dropped from the log.
 *
 * NOTE for the eventual SSE wiring: this relay writes on the injected pool
 * (autocommit), NOT on the engine's transaction client — a run_events row can
 * become visible before the surrounding studio_run_events tx commits, and it
 * survives a later ROLLBACK of that tx. Acceptable for an append-only event
 * log consumed by SSE; if atomicity with the engine tx is ever required, the
 * store needs a client-transactional append variant (out of scope here).
 */

const { createRunEventStore } = require('./runEventStore.cjs');

/** Spec: on a (run_id, seq) PK conflict caused by a different event, retry once. */
const RACE_RETRY_LIMIT = 1;

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Order-insensitive object / ordered-array deep equality (for payload dedup). */
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * @param {{pg?: {query:Function}, store?: object}} deps
 *   `pg` is required unless a pre-built runEventStore `store` is injected
 *   (test seam / DI). Production shape is createRunEventRelay({ pg }).
 * @returns {{ relayRunEvent: Function }}
 */
function createRunEventRelay({ pg, store } = {}) {
  if (!store) {
    if (!pg || typeof pg.query !== 'function') {
      throw new TypeError('createRunEventRelay: { pg } with query() required (or inject a { store })');
    }
    store = createRunEventStore({ pg });
  }
  const { appendRunEvent, lastSequence, listRunEvents } = store;

  /** Read the row occupying `seq` and decide whether it is OUR event. */
  async function occupantIsOurs({ runId, seq, type, payload }) {
    try {
      const res = await listRunEvents({ runId, afterSeq: seq - 1, limit: 1 });
      if (!res || res.ok === false || res.error || !Array.isArray(res.events)) return null;
      const row = res.events[0];
      if (!row || row.seq !== seq) return null; // row vanished → unresolved
      return row.type === type && deepEqual(row.payload, payload);
    } catch (_) {
      return null; // unresolved — caller must not silently drop the event
    }
  }

  /**
   * Persist one run event with the next monotonic per-run seq.
   * @param {{runId:string, type:string, payload?:object}}
   * @returns {Promise<{ok:true, seq:number, idempotent?:boolean, retried?:boolean}
   *                   |{ok:false, errors:Array<{code:string,message:string}>}>}
   */
  async function relayRunEvent({ runId, type, payload } = {}) {
    const errors = [];
    if (!isNonEmptyString(runId)) errors.push({ code: 'INVALID_RUN_ID', message: 'runId (non-empty string) required' });
    if (!isNonEmptyString(type)) errors.push({ code: 'INVALID_TYPE', message: 'type (non-empty string) required' });
    let body = payload;
    if (body !== undefined && body !== null && !isRecord(body)) {
      errors.push({ code: 'INVALID_PAYLOAD', message: 'payload must be an object' });
    }
    if (errors.length) return { ok: false, errors };
    body = body === undefined ? {} : body;

    for (let attempt = 0; attempt <= RACE_RETRY_LIMIT; attempt += 1) {
      const last = await lastSequence({ runId });
      if (!last || last.ok === false || last.error) {
        return {
          ok: false,
          errors: [last && last.error ? last.error : { code: 'LAST_SEQ_FAILED', message: 'lastSequence read failed' }],
        };
      }
      const seq = Number(last.seq) + 1;
      const res = await appendRunEvent({ runId, type, payload: body, seq });
      if (!res || res.ok === false) {
        return { ok: false, errors: [res && res.error ? res.error : { code: 'APPEND_FAILED', message: 'appendRunEvent failed' }] };
      }
      if (res.idempotent === false) return { ok: true, seq, idempotent: false, retried: attempt > 0 };

      // PK conflict at `seq`: same logical event re-delivered, or a lost race.
      const ours = await occupantIsOurs({ runId, seq, type, payload: body });
      if (ours === true) return { ok: true, seq, idempotent: true, retried: attempt > 0 }; // store dedup won
      if (ours === null) {
        return {
          ok: false,
          errors: [{ code: 'SEQ_CONFLICT_UNRESOLVED', message: `run ${runId}: seq ${seq} is occupied by an unverifiable row` }],
        };
      }
      // A different event won the slot → loop retries with a fresh seq.
    }

    return {
      ok: false,
      errors: [{
        code: 'SEQ_COLLISION_RETRY_EXHAUSTED',
        message: `run ${runId}: seq slot still contended after ${RACE_RETRY_LIMIT + 1} allocate attempts`,
      }],
    };
  }

  return { relayRunEvent };
}

module.exports = { createRunEventRelay, RACE_RETRY_LIMIT };
