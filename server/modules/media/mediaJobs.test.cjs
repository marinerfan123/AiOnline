'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMediaMeta, mimeToKind, safeFileName, assertIntegerMs } = require('./mediaMeta.cjs');
const { enqueueJob, claimJob, completeJob, failJob, requeueJob, reclaimExpiredLeases, JOB_KINDS } = require('./jobQueue.cjs');

/** Stateful mock PG that honors the media_jobs state machine (unit-level). */
function makeJobPg() {
  const state = { jobs: [], seq: 1 };
  const find = (id) => state.jobs.find((j) => j.id === id);
  const pg = {
    async query(sql, params) {
      if (sql.includes('WHERE idempotency_key = $1')) return { rows: [] };
      if (sql.startsWith('INSERT INTO media_jobs')) {
        const job = {
          id: `mj-${state.seq++}`, asset_id: params[0], kind: params[2], status: 'queued',
          attempt_count: 0, params_json: params[3], error_code: null, error_message: null,
        };
        state.jobs.push(job);
        return { rows: [job] };
      }
      if (sql.includes('WHERE asset_id = $1 AND kind = $2')) {
        return { rows: state.jobs.filter((j) => j.asset_id === params[0] && j.kind === params[1] && (j.status === 'queued' || j.status === 'running')) };
      }
      if (sql.includes('UPDATE media_jobs m SET status=\'running\'')) {
        // claim: first queued of kind $1
        const job = state.jobs.find((j) => j.status === 'queued' && j.kind === params[0]);
        if (!job) return { rows: [] };
        job.status = 'running'; job.lease_owner = params[2]; job.attempt_count += 1;
        return { rows: [job] };
      }
      if (sql.includes('LEASE_EXPIRED_MAX_ATTEMPTS')) {
        // reclaimExpiredLeases: terminal-fail running jobs past the attempt cap
        const cap = Number(params[0]);
        const hit = state.jobs.filter((j) => j.status === 'running' && j.attempt_count >= cap);
        for (const j of hit) { j.status = 'failed'; j.error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS'; j.lease_owner = null; }
        return { rows: hit };
      }
      if (sql.includes('WHERE status=\'running\' AND lease_expires_at')) {
        // reclaimExpiredLeases: requeue remaining expired running jobs
        const hit = state.jobs.filter((j) => j.status === 'running');
        for (const j of hit) { j.status = 'queued'; j.lease_owner = null; }
        return { rows: hit };
      }
      if (sql.includes('status=\'done\'')) {
        const job = find(params[0]);
        if (!job || job.status !== 'running' || job.lease_owner !== params[1]) return { rows: [] };
        job.status = 'done'; job.result_json = params[2]; job.lease_owner = null;
        return { rows: [job] };
      }
      if (sql.includes('status=\'queued\', lease_owner=NULL')) {
        const job = find(params[0]);
        if (!job || job.status !== 'failed' || job.attempt_count >= Number(params[1])) return { rows: [] };
        job.status = 'queued';
        return { rows: [job] };
      }
      if (sql.includes('status=\'failed\'')) {
        const job = find(params[0]);
        if (!job || job.status !== 'running' || job.lease_owner !== params[1]) return { rows: [] };
        job.status = 'failed'; job.error_code = params[2]; job.lease_owner = null;
        return { rows: [job] };
      }
      if (sql.includes('WHERE id=$1 AND status=\'running\'')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT id, status, lease_owner FROM media_jobs WHERE id=$1')) {
        const job = find(params[0]);
        return { rows: job ? [job] : [] };
      }
      return { rows: [] };
    },
  };
  return pg;
}

test('G06 mediaMeta: float seconds converted to integer ms', () => {
  const m = normalizeMediaMeta({ duration: 5.25, width: 1280, height: 720, fps: 30 });
  assert.equal(m.durationMs, 5250);
  assert.ok(assertIntegerMs(m.durationMs));
});

test('G06 mediaMeta: canonical field aliases resolve', () => {
  const m = normalizeMediaMeta({ duration_seconds: '12.5', avg_frame_rate_num: 24000, avg_frame_rate_den: 1001, audio_codec: 'aac' });
  assert.equal(m.durationMs, 12500);
  assert.equal(m.fpsNum, 24000);
  assert.equal(m.fpsDen, 1001);
  assert.equal(m.audioCodec, 'aac');
});

test('G06 mediaMeta: mime sniff kind + reject unknown', () => {
  assert.deepEqual(mimeToKind('image/png'), { kind: 'image', ok: true });
  assert.deepEqual(mimeToKind('video/mp4'), { kind: 'video', ok: true });
  assert.deepEqual(mimeToKind('audio/wav'), { kind: 'audio', ok: true });
  const bad = mimeToKind('application/x-msdownload');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'UNSUPPORTED_MIME');
});

test('G06 mediaMeta: safe filenames strip traversal/control', () => {
  const a = safeFileName('../../etc/passwd.png');
  assert.ok(!a.includes('..') && !a.includes('/') && !a.includes('\\'), a);
  assert.equal(safeFileName('.hidden'), 'hidden');
  assert.equal(safeFileName(''), 'asset');
});

test('G06 jobQueue: enqueue → claim (lease CAS) → complete idempotent', async () => {
  const pg = makeJobPg({});
  const { job, created } = await enqueueJob(pg, { assetId: 'm1', kind: 'probe', idempotencyKey: 'k1' });
  assert.equal(created, true);
  assert.equal(job.status, 'queued');
  // claim by worker
  const claimed = await claimJob(pg, { kind: 'probe', workerId: 'w1' });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, 'running');
  assert.equal(claimed[0].attempt_count, 1);
  // complete
  const done = await completeJob(pg, { jobId: job.id, workerId: 'w1', result: { durationMs: 1000 } });
  assert.equal(done.changed, true);
  assert.equal(done.job.status, 'done');
  // completing again is a no-op (NOT_RUNNING)
  const again = await completeJob(pg, { jobId: job.id, workerId: 'w1' });
  assert.equal(again.changed, false);
  assert.equal(again.reason, 'NOT_RUNNING');
});

test('G06 jobQueue: fail + requeue bounded, then stays failed beyond maxRetries', async () => {
  const pg = makeJobPg({});
  const { job } = await enqueueJob(pg, { assetId: 'm1', kind: 'waveform' });
  await claimJob(pg, { kind: 'waveform', workerId: 'w1' });
  const f = await failJob(pg, { jobId: job.id, workerId: 'w1', code: 'FFMPEG_EXIT', message: 'x' });
  assert.equal(f.changed, true);
  assert.equal(f.job.status, 'failed');
  // requeue allowed (attempt 1 < 3)
  const rq = await requeueJob(pg, { jobId: job.id, maxRetries: 3 });
  assert.equal(rq.changed, true);
  assert.equal(rq.job.status, 'queued');
  // beyond maxRetries → stays failed
  const pg2 = makeJobPg({});
  const { job: j2 } = await enqueueJob(pg2, { assetId: 'm2', kind: 'thumbnail' });
  await claimJob(pg2, { kind: 'thumbnail', workerId: 'w1' });
  await failJob(pg2, { jobId: j2.id, workerId: 'w1', code: 'E1', message: 'x' });
  await requeueJob(pg2, { jobId: j2.id, maxRetries: 1 });
  await claimJob(pg2, { kind: 'thumbnail', workerId: 'w2' });
  await failJob(pg2, { jobId: j2.id, workerId: 'w2', code: 'E2', message: 'y' });
  const r2 = await requeueJob(pg2, { jobId: j2.id, maxRetries: 1 });
  assert.equal(r2.changed, false);
});

test('G06 jobQueue: rejects unknown kind', async () => {
  await assert.rejects(() => enqueueJob({}, { assetId: 'm1', kind: 'magic' }), TypeError);
  await assert.rejects(() => claimJob({}, { kind: 'magic' }), TypeError);
  assert.equal(JOB_KINDS.has('render'), true);
});

test('G06 jobQueue: reclaimExpiredLeases requeues under cap, terminal-fails past it (poison job)', async () => {
  const pg = makeJobPg({});
  const { job } = await enqueueJob(pg, { assetId: 'm1', kind: 'probe' });
  for (let i = 1; i <= 3; i++) {
    await claimJob(pg, { kind: 'probe', workerId: `w${i}` });
    assert.equal(job.attempt_count, i, `attempt_count after claim ${i}`);
    const r = await reclaimExpiredLeases(pg); // default maxAttempts=3
    if (i < 3) {
      assert.equal(r.reclaimed, 1);
      assert.equal(r.failed, 0);
      assert.equal(job.status, 'queued');
    } else {
      assert.equal(r.reclaimed, 0);
      assert.equal(r.failed, 1);
      assert.equal(job.status, 'failed');
      assert.equal(job.error_code, 'LEASE_EXPIRED_MAX_ATTEMPTS');
    }
  }
  // Terminal: a further reclaim leaves it failed (never requeued again).
  const again = await reclaimExpiredLeases(pg);
  assert.equal(again.reclaimed, 0);
  assert.equal(again.failed, 0);
  assert.equal(job.status, 'failed');
});

test('G06 jobQueue: reclaimExpiredLeases honors custom maxAttempts', async () => {
  const pg = makeJobPg({});
  const { job } = await enqueueJob(pg, { assetId: 'm2', kind: 'thumbnail' });
  await claimJob(pg, { kind: 'thumbnail', workerId: 'w1' });
  assert.equal(job.attempt_count, 1);
  const r = await reclaimExpiredLeases(pg, { maxAttempts: 1 });
  assert.equal(r.reclaimed, 0);
  assert.equal(r.failed, 1);
  assert.equal(job.status, 'failed');
  assert.equal(job.error_code, 'LEASE_EXPIRED_MAX_ATTEMPTS');
});
