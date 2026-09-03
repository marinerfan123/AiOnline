'use strict';
/**
 * G06 — Media processing job queue (Blueprint 03 §24, master §15).
 * Pure CAS state machine over media_jobs: enqueue (idempotent per active
 * (asset,kind) + idempotency_key), claim (lease CAS), complete (result_json +
 * status done, idempotent finalize), fail (deterministic + bounded attempts),
 * cancel. No I/O besides pg — deterministic, unit-testable with a mock.
 * Executors (probe/thumbnail/proxy/waveform via ffmpeg/media libs) plug in
 * separately; this module owns ONLY the durable state transitions.
 */

const JOB_KINDS = new Set(['probe', 'transcode', 'proxy', 'thumbnail', 'waveform', 'frame_extract', 'render', 'stitch']);
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

function assertKind(kind) {
  if (!JOB_KINDS.has(kind)) throw new TypeError(`unknown media job kind: ${kind}`);
}

/** Enqueue; returns existing active job when one is already queued/running. */
async function enqueueJob(pg, { assetId, kind, params = {}, idempotencyKey = null, createdBy = null }) {
  assertKind(kind);
  if (!assetId) throw new TypeError('assetId required');
  if (idempotencyKey !== null) {
    const existing = await pg.query(
      `SELECT * FROM media_jobs WHERE idempotency_key = $1 AND status NOT IN ('done','cancelled','failed')`,
      [idempotencyKey],
    );
    if (existing.rows.length) return { job: existing.rows[0], created: false };
  }
  let inserted = null;
  try {
    const r = await pg.query(
      `INSERT INTO media_jobs (asset_id, project_id, kind, params_json, idempotency_key, created_by)
       VALUES ($1, NULLIF($2,'')::text, $3, $4, NULLIF($5,'')::text, NULLIF($6,'')::text)
       ON CONFLICT (asset_id, kind) WHERE status IN ('queued','running') DO NOTHING
       RETURNING *`,
      [assetId, null, kind, JSON.stringify(params), idempotencyKey, createdBy],
    );
    inserted = r.rows[0] || null;
  } catch (e) {
    // Unique idempotency_key race (uq_media_jobs_idempotency): a concurrent
    // enqueue with the same key won the INSERT. Fall through to the active-row
    // lookup instead of surfacing an uncaught 23505.
    if (!(e && e.code === '23505')) throw e;
  }
  if (inserted) return { job: inserted, created: true };
  const active = await pg.query(
    `SELECT * FROM media_jobs WHERE asset_id = $1 AND kind = $2 AND status IN ('queued','running') LIMIT 1`,
    [assetId, kind],
  );
  return { job: active.rows[0] || null, created: false };
}

/** Claim a queued job for a worker: status queued→running with lease CAS. */
async function claimJob(pg, { kind, workerId, leaseSeconds = 120, limit = 1 }) {
  assertKind(kind);
  const n = Math.max(1, Math.min(50, Number(limit) || 1));
  const r = await pg.query(
    `WITH next AS (
       SELECT id FROM media_jobs
       WHERE status = 'queued' AND kind = $1
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
       ORDER BY created_at ASC
       LIMIT $2 FOR UPDATE SKIP LOCKED
     )
     UPDATE media_jobs m SET status='running', lease_owner=$3,
       lease_expires_at=NOW() + make_interval(secs => $4), attempt_count = attempt_count + 1,
       updated_at = NOW()
     FROM next WHERE m.id = next.id
     RETURNING m.*`,
    [kind, n, workerId, Number(leaseSeconds) || 120],
  );
  return r.rows;
}

/** Complete a job (idempotent finalize): running→done with result_json. */
async function completeJob(pg, { jobId, workerId, result = {} }) {
  const r = await pg.query(
    `UPDATE media_jobs SET status='done', result_json=$3, error_code=NULL, error_message=NULL,
       lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW()
     WHERE id=$1 AND lease_owner=$2 AND status='running'
     RETURNING *`,
    [jobId, workerId, JSON.stringify(result)],
  );
  if (!r.rows.length) {
    const cur = await pg.query(`SELECT id, status, lease_owner FROM media_jobs WHERE id=$1`, [jobId]);
    return { changed: false, job: cur.rows[0] || null, reason: cur.rows[0] && cur.rows[0].status !== 'running' ? 'NOT_RUNNING' : 'LEASE_MISMATCH' };
  }
  return { changed: true, job: r.rows[0] };
}

/** Fail a job deterministically; bounded by attempt count (caller enforces maxRetries). */
async function failJob(pg, { jobId, workerId, code, message }) {
  const r = await pg.query(
    `UPDATE media_jobs SET status='failed', error_code=$3, error_message=$4,
       lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW()
     WHERE id=$1 AND lease_owner=$2 AND status='running'
     RETURNING *`,
    [jobId, workerId, code, message],
  );
  return { changed: r.rows.length === 1, job: r.rows[0] || null };
}

/** Requeue a failed job if attempts below maxRetries, else leave failed. */
async function requeueJob(pg, { jobId, maxRetries = 3 }) {
  const r = await pg.query(
    `UPDATE media_jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW()
     WHERE id=$1 AND status='failed' AND attempt_count < $2
     RETURNING *`,
    [jobId, Number(maxRetries) || 3],
  );
  return { changed: r.rows.length === 1, job: r.rows[0] || null };
}

/**
 * Reclaim stale leases: running jobs whose lease expired (worker died without
 * completing) are returned to queued so any worker can pick them up again.
 * Idempotent + safe under concurrency (plain UPDATE, re-claim goes through
 * FOR UPDATE SKIP LOCKED).
 */
async function reclaimExpiredLeases(pg) {
  const r = await pg.query(
    `UPDATE media_jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW()
     WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
     RETURNING id`,
  );
  return { reclaimed: r.rows.length, ids: r.rows.map((x) => x.id) };
}

module.exports = { JOB_KINDS, TERMINAL, enqueueJob, claimJob, completeJob, failJob, requeueJob, reclaimExpiredLeases };
