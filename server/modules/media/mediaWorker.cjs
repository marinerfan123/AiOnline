'use strict';
/**
 * G06 — Media job worker poll loop (Blueprint 03 §24).
 * Polls claimJob for a queued media job of `kind`, runs the matching executor,
 * and drives the jobQueue state machine (complete / fail + bounded requeue).
 * The module owns no SQL of its own — all durable transitions go through
 * jobQueue.cjs (claimJob/completeJob/failJob/requeueJob) so the unit mock only
 * has to mirror those four statements' real shapes.
 *
 * createMediaWorker({ pg, executors, kind, workerId, pollMs, maxRetries,
 *                      reclaim=true, resolveSource, onProbeMeta, onArtifact }) ->
 *   { runOnce(pgDep, kindOverride), stop(), started }
 *
 * executors: { probe: async (ctx) => ({ ok: true, result }) | ({ ok: false, code, message }) }
 * ctx = { jobId, assetId, kind, params, job, pg, source }  (params parsed from params_json)
 *
 * Optional injected hooks (server wiring):
 *   resolveSource(params)  async — turn an OSS objectKey into a signed GET url
 *                            (or null); used when params has no local `source`.
 *   onProbeMeta(meta)      async — persist probe metadata (width/height/duration)
 *                            back onto the media row after a successful probe.
 *   onArtifact(artifact)   async — persist/store executor outputs (thumbnail/
 *                            proxy/waveform) after success ({kind, assetId,
 *                            jobId, file, result}).
 *   reclaim=true (default) — when this worker's kind is 'probe' it acts as
 *                            housekeeper: reclaims expired running leases each tick.
 */
const { claimJob, completeJob, failJob, requeueJob, reclaimExpiredLeases } = require('./jobQueue.cjs');

const EXCEPTION_CODE = 'MEDIA_EXECUTOR_EXCEPTION';

function parseParams(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  return raw;
}

/**
 * Single poll round — no sleep. Used by the poll loop and exposed for tests.
 * @param {object} [pgDep] override pg (defaults to the worker's pg)
 * @param {string} [kindOverride] override kind (defaults to worker's kind)
 * @returns {Promise<{claimed:boolean, jobId?:string, status?:string, requeued?:boolean}>}
 */
function createMediaWorker({ pg, executors = {}, kind, workerId, pollMs = 500, maxRetries = 3, reclaim = true, resolveSource = null, onProbeMeta = null, onArtifact = null }) {
  if (!pg) throw new TypeError('pg required');
  if (!kind) throw new TypeError('kind required');
  if (!workerId) throw new TypeError('workerId required');

  let stopped = false;
  let timer = null;
  let lastError = null;

  async function runOnce(pgDep, kindOverride) {
    const db = pgDep || pg;
    const runKind = kindOverride || kind;
    const rows = await claimJob(db, { kind: runKind, workerId, leaseSeconds: 60, limit: 1 });
    if (!rows || !rows.length) return { claimed: false };
    const job = rows[0];

    const ctx = {
      jobId: job.id,
      assetId: job.asset_id,
      kind: job.kind,
      params: parseParams(job.params_json),
      job,
      pg: db,
    };
    // Executors read ctx.source (executors.cjs guards MEDIA_SOURCE_MISSING).
    // Map it from job params: an explicit `source` (URL or local path) wins;
    // otherwise resolve the OSS objectKey to a signed GET url via the injected
    // resolver (real deployments) — never feed a bare objectKey to ffmpeg.
    const p = ctx.params || {};
    if (p.source) {
      ctx.source = p.source;
    } else if (p.objectKey && typeof resolveSource === 'function') {
      ctx.source = (await resolveSource(p)) || null;
    } else {
      ctx.source = p.objectKey || null;
    }

    const fn = executors[kindOverride || kind] || executors[job.kind];
    let outcome;
    try {
      outcome = await fn(ctx);
    } catch (err) {
      outcome = {
        ok: false,
        code: EXCEPTION_CODE,
        message: err && err.message != null ? String(err.message) : String(err),
      };
    }

    const ok = !!(outcome && outcome.ok === true);
    if (ok) {
      const result = outcome && outcome.result !== undefined ? outcome.result : {};
      const res = await completeJob(db, { jobId: job.id, workerId, result });
      // Post-success side effects (best-effort, never fail the job on hook error).
      try {
        if (job.kind === 'probe' && result && result.meta && typeof onProbeMeta === 'function') {
          await onProbeMeta({ db, assetId: job.asset_id, meta: result.meta });
        }
        if (job.kind !== 'probe' && result && (result.output || result.outputFile) && typeof onArtifact === 'function') {
          await onArtifact({ db, kind: job.kind, assetId: job.asset_id, jobId: job.id, file: result.output || result.outputFile, result });
        }
      } catch (_e) { /* side-effect failure must not flip a completed job */ }
      return { claimed: true, jobId: job.id, status: 'done', requeued: false, changed: res.changed };
    }

    const code = outcome && outcome.code != null ? String(outcome.code) : EXCEPTION_CODE;
    const message =
      outcome && outcome.message != null
        ? String(outcome.message)
        : 'executor did not return a result';
    await failJob(db, { jobId: job.id, workerId, code, message });

    let requeued = false;
    if (Number(job.attempt_count) < Number(maxRetries)) {
      const rq = await requeueJob(db, { jobId: job.id, maxRetries });
      requeued = rq.changed === true;
    }
    return { claimed: true, jobId: job.id, status: requeued ? 'queued' : 'failed', requeued };
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(tick, delay);
  }

  /** One poll iteration: claim+execute, then re-arm (idle → pollMs, busy → 0). */
  async function tick() {
    if (stopped) return;
    let claimed = false;
    try {
      // Housekeeping: the probe worker also reclaims expired running leases so
      // a crashed worker's jobs return to queued instead of being stuck forever.
      if (reclaim && kind === 'probe') {
        await reclaimExpiredLeases(pg).catch(() => {});
      }
      claimed = (await runOnce()).claimed === true;
    } catch (err) {
      lastError = err; // transient DB error: keep polling
    }
    if (stopped) return;
    schedule(claimed ? 0 : pollMs);
  }

  schedule(0);

  function stop() {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return {
    runOnce,
    stop,
    get started() {
      return !stopped;
    },
  };
}

module.exports = { createMediaWorker };
