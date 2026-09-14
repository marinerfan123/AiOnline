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
 *   - runEventStore.appendNextRunEvent  allocates the next per-run seq and
 *     inserts in ONE advisory-locked statement (INSERT…SELECT MAX+1…
 *     RETURNING), so allocation is atomic and serialized per run across
 *     processes. This relay is a thin wrapper over it: callers (the
 *     studioRunEngine emitEvent funnel) never see or choose seqs.
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
 * CONCURRENCY (audit 2026-09-04 — previously a CRITICAL silent-drop bug):
 *   The engine is NOT single-writer per run. Multiple Studio Worker replicas
 *   (stateless, "any number may run concurrently") lease different nodes of the
 *   SAME run, and within one worker process workerTick runs up to
 *   STUDIO_WORKER_CONCURRENCY node runners in parallel — all emitting for the
 *   same run at overlapping instants. The old relay did read-last → write-last+1
 *   with a single retry (RACE_RETRY_LIMIT=1): a 3+-way race made all losers
 *   re-read the same MAX and collide again on the one allowed retry, so the
 *   relay returned SEQ_COLLISION_RETRY_EXHAUSTED and the event was silently
 *   dropped from run_events (a permanent gap in the SSE log). Seq allocation is
 *   now atomic via appendNextRunEvent (a per-run counter bumped and the event
 *   inserted in one statement — see runEventStore.cjs); the retry loop below is
 *   defence-in-depth that only fires if allocation is somehow contended — it
 *   re-allocates rather than dropping.
 *
 * NOTE on durability vs the engine transaction: the relay writes on the injected
 * pool (autocommit), NOT on the engine's transaction client — a run_events row
 * can become visible before the surrounding studio_run_events tx commits and it
 * survives a later ROLLBACK of that tx. Acceptable for an append-only event log
 * consumed by SSE. (The FK run_events.run_id → studio_runs.id from migration
 * 0043 is satisfied because every emitEvent call site runs on an already-created
 * run; ON DELETE CASCADE clears the log when a run is deleted.)
 */

const { createRunEventStore } = require('./runEventStore.cjs');

/**
 * Defence-in-depth re-allocate attempts when appendNextRunEvent reports an
 * occupied seq (idempotent:true with seq:null). Under the advisory lock this
 * never happens; a small bound guards against pathological setups.
 */
const RELAY_APPEND_RETRY_LIMIT = 3;

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

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
  const { appendNextRunEvent } = store;

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

    for (let attempt = 0; attempt <= RELAY_APPEND_RETRY_LIMIT; attempt += 1) {
      const res = await appendNextRunEvent({ runId, type, payload: body });
      if (!res || res.ok === false) {
        return {
          ok: false,
          errors: [res && res.error ? res.error : { code: 'APPEND_FAILED', message: 'appendNextRunEvent failed' }],
        };
      }
      if (res.idempotent === false) {
        return { ok: true, seq: res.seq, idempotent: false, retried: attempt > 0 };
      }
      // idempotent:true + seq:null — an occupied slot (advisory lock was a
      // no-op, or a manual insert created a gap). Re-allocate fresh.
    }

    return {
      ok: false,
      errors: [{
        code: 'SEQ_ALLOC_RETRY_EXHAUSTED',
        message: `run ${runId}: seq allocation still contended after ${RELAY_APPEND_RETRY_LIMIT + 1} attempts`,
      }],
    };
  }

  return { relayRunEvent };
}

module.exports = { createRunEventRelay, RELAY_APPEND_RETRY_LIMIT };
