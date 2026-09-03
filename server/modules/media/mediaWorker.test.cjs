'use strict';
/**
 * G06 — mediaWorker poll-loop unit tests.
 * Fake pg mirrors the REAL SQL of jobQueue.cjs (claim/complete/fail/requeue),
 * including the requeue guard `attempt_count < maxRetries`, so the mock's
 * behavior matches the durable state machine the module runs against.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaWorker } = require('./mediaWorker.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal stateful pg mock dispatched on jobQueue.cjs SQL keywords. */
function makePg() {
  const state = { jobs: [], seq: 1, calls: { claim: 0, complete: 0, fail: 0, requeue: 0 } };
  const find = (id) => state.jobs.find((j) => j.id === id) || null;
  const pg = {
    _state: state,
    async query(sql, params) {
      // claimJob: UPDATE ... SET status='running', lease_owner=$3 ... [kind,n,workerId,leaseSeconds]
      if (sql.includes("SET status='running'")) {
        state.calls.claim += 1;
        const job = state.jobs.find((j) => j.status === 'queued' && j.kind === params[0]);
        if (!job) return { rows: [] };
        job.status = 'running';
        job.lease_owner = params[2];
        job.attempt_count = (job.attempt_count || 0) + 1;
        return { rows: [job] };
      }
      // completeJob: UPDATE ... SET status='done', result_json=$3 ... [jobId,workerId,resultJson]
      if (sql.includes("SET status='done'")) {
        state.calls.complete += 1;
        const job = find(params[0]);
        if (!job || job.status !== 'running' || job.lease_owner !== params[1]) return { rows: [] };
        job.status = 'done';
        job.result_json = params[2];
        job.lease_owner = null;
        job.lease_expires_at = null;
        return { rows: [job] };
      }
      // requeueJob: UPDATE ... SET status='queued' ... WHERE ... attempt_count < $2
      if (sql.includes("SET status='queued'")) {
        state.calls.requeue += 1;
        const job = find(params[0]);
        if (!job || job.status !== 'failed' || job.attempt_count >= Number(params[1])) return { rows: [] };
        job.status = 'queued';
        job.lease_owner = null;
        job.lease_expires_at = null;
        return { rows: [job] };
      }
      // failJob: UPDATE ... SET status='failed', error_code=$3 ... [jobId,workerId,code,message]
      if (sql.includes("SET status='failed'")) {
        state.calls.fail += 1;
        const job = find(params[0]);
        if (!job || job.status !== 'running' || job.lease_owner !== params[1]) return { rows: [] };
        job.status = 'failed';
        job.error_code = params[2];
        job.error_message = params[3];
        job.lease_owner = null;
        job.lease_expires_at = null;
        return { rows: [job] };
      }
      // completeJob fallback current-state probe
      if (sql.includes('SELECT id, status, lease_owner FROM media_jobs WHERE id=$1')) {
        const job = find(params[0]);
        return { rows: job ? [job] : [] };
      }
      return { rows: [] };
    },
  };
  return pg;
}

/** Seed a queued job row the way enqueueJob leaves it (attempt_count 0 unless overridden). */
function seedJob(pg, { kind, id = `mj-${pg._state.seq++}`, params = {}, attemptCount = 0 } = {}) {
  const job = {
    id,
    asset_id: `asset-${id}`,
    project_id: null,
    kind,
    status: 'queued',
    attempt_count: attemptCount,
    lease_owner: null,
    lease_expires_at: null,
    params_json: params,
    result_json: null,
    error_code: null,
    error_message: null,
  };
  pg._state.jobs.push(job);
  return job;
}

const jobById = (pg, id) => pg._state.jobs.find((j) => j.id === id);

/** Worker handle whose background poll is halted; tests drive rounds via runOnce. */
function makeWorker(opts) {
  const w = createMediaWorker(opts);
  w.stop(); // synchronous, before any timer can fire → loop never claims
  return w;
}

async function waitFor(pred, timeoutMs = 2000, stepMs = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
    await sleep(stepMs);
  }
  throw new Error('waitFor: condition not met within timeout');
}

test('mediaWorker ① success round: queued → claim(running, attempt 1) → executor ok → done', async () => {
  const pg = makePg();
  const job = seedJob(pg, { kind: 'probe', params: { source: '/tmp/a.mp4' } });
  let ctxSeen = null;
  const executors = {
    probe: async (ctx) => {
      ctxSeen = ctx;
      return { ok: true, result: { durationMs: 1200, codec: 'h264' } };
    },
  };
  const w = makeWorker({ pg, executors, kind: 'probe', workerId: 'w1', maxRetries: 3 });

  const res = await w.runOnce(pg); // explicit pgDep; default kind
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'done');
  assert.equal(res.requeued, false);

  const cur = jobById(pg, job.id);
  assert.equal(cur.status, 'done');
  assert.equal(cur.attempt_count, 1);
  assert.equal(cur.lease_owner, null);
  assert.deepEqual(JSON.parse(cur.result_json), { durationMs: 1200, codec: 'h264' });

  assert.equal(ctxSeen.jobId, job.id);
  assert.equal(ctxSeen.assetId, job.asset_id);
  assert.equal(ctxSeen.kind, 'probe');
  assert.deepEqual(ctxSeen.params, { source: '/tmp/a.mp4' });
  assert.equal(ctxSeen.pg, pg);
  assert.equal(ctxSeen.job, cur); // same row object that transitions

  assert.equal(pg._state.calls.claim, 1);
  assert.equal(pg._state.calls.complete, 1);
  assert.equal(pg._state.calls.fail, 0);
  assert.equal(pg._state.calls.requeue, 0);
});

test('mediaWorker ② failure with attempts left: failed → requeued → queued', async () => {
  const pg = makePg();
  const job = seedJob(pg, { kind: 'waveform', params: { src: '/tmp/w.wav' } });
  const executors = {
    waveform: async () => ({ ok: false, code: 'FFMPEG_EXIT', message: 'boom' }),
  };
  // worker kind differs ('probe') → exercise kindOverride + pgDep injection
  const w = makeWorker({ pg, executors, kind: 'probe', workerId: 'w1', maxRetries: 3 });

  const res = await w.runOnce(pg, 'waveform');
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'queued'); // requeued for another attempt
  assert.equal(res.requeued, true);

  const cur = jobById(pg, job.id);
  assert.equal(cur.status, 'queued');
  assert.equal(cur.attempt_count, 1);
  assert.equal(cur.lease_owner, null);
  assert.equal(cur.error_code, 'FFMPEG_EXIT');
  assert.equal(cur.error_message, 'boom');

  assert.equal(pg._state.calls.fail, 1);
  assert.equal(pg._state.calls.requeue, 1);
  assert.equal(pg._state.calls.complete, 0);
});

test('mediaWorker ③ failure at maxRetries: stays failed, no requeue', async () => {
  const pg = makePg();
  // attempt_count already at 2 → claim makes it 3 = maxRetries → no requeue allowed
  const job = seedJob(pg, { kind: 'waveform', attemptCount: 2 });
  const executors = { waveform: async () => ({ ok: false, code: 'FFMPEG_EXIT', message: 'boom' }) };
  const w = makeWorker({ pg, executors, kind: 'waveform', workerId: 'w1', maxRetries: 3 });

  const res = await w.runOnce();
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'failed');
  assert.equal(res.requeued, false);

  const cur = jobById(pg, job.id);
  assert.equal(cur.status, 'failed');
  assert.equal(cur.attempt_count, 3);
  assert.equal(cur.error_code, 'FFMPEG_EXIT');
  assert.equal(cur.lease_owner, null);

  assert.equal(pg._state.calls.fail, 1);
  assert.equal(pg._state.calls.requeue, 0);

  // nothing left queued → a further round claims nothing
  const idle = await w.runOnce();
  assert.deepEqual(idle, { claimed: false });
  assert.equal(pg._state.calls.claim, 2);
});

test('mediaWorker ④ executor throws: MEDIA_EXECUTOR_EXCEPTION → fail + requeue', async () => {
  const pg = makePg();
  const job = seedJob(pg, { kind: 'probe' });
  const executors = {
    probe: async () => {
      throw new Error('kaboom');
    },
  };
  const w = makeWorker({ pg, executors, kind: 'probe', workerId: 'w1', maxRetries: 3 });

  const res = await w.runOnce();
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'queued');
  assert.equal(res.requeued, true);

  const cur = jobById(pg, job.id);
  assert.equal(cur.status, 'queued');
  assert.equal(cur.attempt_count, 1);
  assert.equal(cur.error_code, 'MEDIA_EXECUTOR_EXCEPTION');
  assert.ok(cur.error_message.includes('kaboom'), cur.error_message);

  assert.equal(pg._state.calls.fail, 1);
  assert.equal(pg._state.calls.requeue, 1);
});

test('mediaWorker ⑤ started loop polls; stop() halts claiming (runOnce stays usable)', async () => {
  const pg = makePg();
  let execCalls = 0;
  const w = createMediaWorker({
    pg,
    executors: {
      probe: async () => {
        execCalls += 1;
        return { ok: true, result: {} };
      },
    },
    kind: 'probe',
    workerId: 'w1',
    pollMs: 10,
    maxRetries: 3,
  });
  assert.equal(w.started, true);

  try {
    // idle: loop keeps polling claimJob (no job → sleep pollMs → retry)
    await waitFor(() => pg._state.calls.claim >= 1);
    assert.equal(execCalls, 0); // nothing was claimed, executor never ran

    // seed a job: the running loop must pick it up on its own
    seedJob(pg, { kind: 'probe' });
    await waitFor(() => pg._state.jobs.some((j) => j.status === 'done'));

    const cur = pg._state.jobs.find((j) => j.status === 'done');
    assert.ok(cur);
    assert.equal(cur.attempt_count, 1);
    assert.equal(execCalls, 1);

    // stop halts the loop: no further claim queries
    w.stop();
    w.stop(); // idempotent
    assert.equal(w.started, false);
    const claimsAtStop = pg._state.calls.claim;
    await sleep(60); // several pollMs windows — loop must stay silent
    assert.equal(pg._state.calls.claim, claimsAtStop);
    assert.equal(execCalls, 1);

    // runOnce is an explicit single round, independent of the stopped loop
    const j2 = seedJob(pg, { kind: 'probe' });
    const res = await w.runOnce();
    assert.equal(res.claimed, true);
    assert.equal(jobById(pg, j2.id).status, 'done');
  } finally {
    w.stop();
  }
});

// ─── G11 stitch ctx alignment ────────────────────────────────────────────────

const STITCH_SEGMENTS = [
  { source: '/media/a.mp4', inMs: 2000, outMs: 5000 },
  { source: '/media/b.mp4', inMs: 1500, outMs: 3000 },
];

/** Fake ffmpeg spawn (EventEmitter child, exit 0) — same shape executor tests use. */
function makeFakeFfmpegSpawn() {
  const fn = (bin, args) => {
    const child = new (require('node:events').EventEmitter)();
    child.stdout = new (require('node:events').EventEmitter)();
    child.stderr = new (require('node:events').EventEmitter)();
    child.kill = () => {};
    fn.calls.push({ bin, args });
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  fn.calls = [];
  return fn;
}

test('mediaWorker ⑥ G11 stitch: params.segments/outKey reach ctx — no ctx.source forced', async () => {
  const pg = makePg();
  const params = { segments: STITCH_SEGMENTS, outKey: '/tmp/stitch.mp4' };
  const job = seedJob(pg, { kind: 'stitch', params });
  let ctxSeen = null;
  const executors = {
    stitch: async (ctx) => {
      ctxSeen = ctx;
      return { ok: true, result: { output: ctx.outKey, segments: ctx.segments.length } };
    },
  };
  const w = makeWorker({ pg, executors, kind: 'stitch', workerId: 'w1', maxRetries: 3 });

  const res = await w.runOnce();
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'done');
  assert.equal(res.requeued, false);

  assert.equal(ctxSeen.kind, 'stitch');
  assert.deepEqual(ctxSeen.segments, STITCH_SEGMENTS); // params.segments mirrored onto ctx
  assert.equal(ctxSeen.outKey, '/tmp/stitch.mp4'); // params.outKey mirrored onto ctx
  assert.equal(ctxSeen.source, null); // no params.source/objectKey → stitch runs without one
  assert.deepEqual(ctxSeen.params, params);
  assert.equal(ctxSeen.pg, pg);
  assert.equal(ctxSeen.job, jobById(pg, job.id));

  const cur = jobById(pg, job.id);
  assert.equal(cur.status, 'done');
  assert.deepEqual(JSON.parse(cur.result_json), { output: '/tmp/stitch.mp4', segments: 2 });
  assert.equal(pg._state.calls.complete, 1);
  assert.equal(pg._state.calls.fail, 0);
});

test('mediaWorker ⑦ G11 stitch: no params.outKey → job-scoped /tmp/media-jobs/<jobId>/stitch.mp4 default', async () => {
  const pg = makePg();
  const job = seedJob(pg, { kind: 'stitch', params: { segments: STITCH_SEGMENTS } });
  let ctxSeen = null;
  const executors = {
    stitch: async (ctx) => {
      ctxSeen = ctx;
      return { ok: true, result: { output: ctx.outKey } };
    },
  };
  const w = makeWorker({ pg, executors, kind: 'stitch', workerId: 'w1', maxRetries: 3 });

  const res = await w.runOnce();
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'done');
  assert.equal(ctxSeen.outKey, `/tmp/media-jobs/${job.id}/stitch.mp4`);
  assert.deepEqual(ctxSeen.segments, STITCH_SEGMENTS);
});

test('mediaWorker ⑧ G11 stitch: queued job runs the real runStitch through the worker (injected spawn) and completes', async () => {
  const pg = makePg();
  const spawn = makeFakeFfmpegSpawn();
  const job = seedJob(pg, {
    kind: 'stitch',
    params: { segments: STITCH_SEGMENTS, outKey: '/tmp/stitch-out.mp4', spawn, timeoutMs: 2000 },
  });
  // Same wiring shape as server.js: EXECUTORS.stitch delegates to runStitch.
  const executors = { stitch: (ctx) => require('./executorsStitch.cjs').runStitch(ctx) };
  const w = makeWorker({ pg, executors, kind: 'stitch', workerId: 'w1', maxRetries: 3 });

  const res = await w.runOnce();
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'done');
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  const fi = args.indexOf('-filter_complex');
  assert.ok(fi !== -1, 'args must contain -filter_complex');
  assert.ok(args[fi + 1].includes('[0:v]trim=start=2.000:end=5.000,setpts=PTS-STARTPTS[v0]'));
  assert.ok(args[fi + 1].includes('[1:v]trim=start=1.500:end=3.000,setpts=PTS-STARTPTS[v1]'));
  assert.ok(args[fi + 1].endsWith('[v0][v1]concat=n=2:v=1:a=0[v]'));
  assert.equal(args[args.length - 1], '/tmp/stitch-out.mp4');
  const cur = jobById(pg, job.id);
  assert.equal(cur.status, 'done');
  assert.deepEqual(JSON.parse(cur.result_json), { output: '/tmp/stitch-out.mp4', segments: 2 });
  assert.equal(pg._state.calls.complete, 1);
  assert.equal(pg._state.calls.fail, 0);
});

test('mediaWorker ⑨ AV kinds unchanged: extra params never leak onto ctx; ctx.source mapping intact', async () => {
  const pg = makePg();
  // A probe job carrying stitch-shaped extras must still get the exact AV ctx
  // shape — the G11 mirror is stitch-only (still walks the ctx.source gate).
  seedJob(pg, {
    kind: 'probe',
    params: { source: '/tmp/a.mp4', cols: 2, rows: 2, outKey: '/tmp/nope.mp4', segments: [STITCH_SEGMENTS[0]] },
  });
  let ctxSeen = null;
  const executors = {
    probe: async (ctx) => {
      ctxSeen = ctx;
      return { ok: true, result: {} };
    },
  };
  const w = makeWorker({ pg, executors, kind: 'probe', workerId: 'w1', maxRetries: 3 });

  const res = await w.runOnce();
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'done');
  assert.deepEqual(
    Object.keys(ctxSeen).sort(),
    ['assetId', 'job', 'jobId', 'kind', 'params', 'pg', 'source'].sort()
  );
  assert.equal(ctxSeen.source, '/tmp/a.mp4');
  assert.equal(ctxSeen.outKey, undefined);
  assert.equal(ctxSeen.segments, undefined);
  assert.equal(ctxSeen.cols, undefined);
});

test('mediaWorker ⑩ AV kinds unchanged: probe objectKey still resolved to signed source via resolveSource', async () => {
  const pg = makePg();
  seedJob(pg, { kind: 'probe', params: { objectKey: 'assets/o/a.mp4' } });
  let ctxSeen = null;
  const executors = {
    probe: async (ctx) => {
      ctxSeen = ctx;
      return { ok: true, result: {} };
    },
  };
  const w = makeWorker({
    pg,
    executors,
    kind: 'probe',
    workerId: 'w1',
    maxRetries: 3,
    resolveSource: async (params) => `https://signed.example/${params.objectKey}`,
  });

  const res = await w.runOnce();
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'done');
  assert.equal(ctxSeen.source, 'https://signed.example/assets/o/a.mp4');
  assert.equal(ctxSeen.segments, undefined);
});
