'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelayGenerationService } = require('./relayGeneration.cjs');

function makePool() {
  const tasks = new Map();
  const uploadJobs = [];
  const pool = {
    tasks,
    uploadJobs,
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO generation_tasks')) {
        tasks.set(params[0], {
          task_id: params[0], status: 'running', model: params[1], model_id: params[2], prompt: params[3],
          count: params[4], content_type: params[5], pending_ids: params[6], client_meta: params[7],
          user_id: params[8], idempotency_key: params[9], cost: params[10], cost_pool: params[11], resume_meta: JSON.parse(params[12]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE generation_tasks') && sql.includes('resume_meta')) {
        const row = tasks.get(params[0]);
        Object.assign(row.resume_meta, JSON.parse(params[1]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT * FROM generation_tasks')) {
        return { rows: tasks.has(params[0]) ? [tasks.get(params[0])] : [] };
      }
      if (sql.includes('INSERT INTO asset_upload_jobs')) {
        uploadJobs.push(JSON.parse(params[2]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status='finalizing'")) {
        const row = tasks.get(params[0]);
        row.status = 'finalizing'; row.result = JSON.parse(params[1]); row.error = '';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status='failed'")) {
        const row = tasks.get(params[0]);
        row.status = 'failed'; row.error = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status='canceled'")) {
        const row = tasks.get(params[0]);
        row.status = 'canceled'; row.error = params[1];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        query: (...args) => pool.query(...args),
        release() {},
      };
    },
  };
  return pool;
}

function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('condition timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('relay generation settles billing once and hands provider URLs to the upload queue', async () => {
  const pool = makePool();
  const commits = [];
  const releases = [];
  const events = [];
  const relayClient = {
    async createGeneration() { return { status: 'pending', taskId: 'remote-1' }; },
    async getTask() { return { taskId: 'remote-1', state: 'done', result: { images: ['https://cdn.example/image.png'] } }; },
    async cancelTask() { return { state: 'canceled' }; },
  };
  const service = createRelayGenerationService({
    relayClient,
    billing: {
      async commitCredits(_pg, userId, amount, ref) { commits.push({ userId, amount, ref }); },
      async releaseCredits(_pg, userId, amount, ref) { releases.push({ userId, amount, ref }); },
    },
    accounting: { async recordConsumption() {} },
    uploadQueue: {
      async enqueueFinalize(_pg, job) {
        pool.uploadJobs.push(job);
      },
    },
    realtime: { emitTaskUpdate(_userId, event) { events.push(event); } },
    pollIntervalMs: 0,
    maxPolls: 2,
  });

  const result = await service.create({
    pgPool: pool,
    userId: 'user-1',
    generation: {
      model: 'flux-1', modelId: 'flux-1', displayModelName: 'Flux', prompt: 'lighthouse',
      count: 1, contentType: 'image', pendingIds: ['pending-1'], idempotencyKey: 'idem-1', cost: 3, costPool: 'reward',
      providerApiKey: 'must-not-cross-boundary', clientMeta: { ratio: '1:1' },
    },
  });
  assert.match(result.taskId, /^gt-relay-/);
  await waitFor(() => pool.uploadJobs.length === 1);
  assert.deepEqual(commits, [{ userId: 'user-1', amount: 3, ref: 'idem-1' }]);
  assert.equal(releases.length, 0);
  assert.equal(pool.tasks.get(result.taskId).status, 'finalizing');
  assert.equal(pool.uploadJobs[0].providerImages[0], 'https://cdn.example/image.png');
  assert.equal(pool.uploadJobs[0].ctx.pendingIds[0], 'pending-1');
  assert.equal(pool.tasks.get(result.taskId).resume_meta.request.providerApiKey, undefined);
  assert.equal(events.length, 0);

  const canceled = await service.cancel({ pgPool: pool, userId: 'user-1', taskId: result.taskId });
  assert.equal(canceled.handled, true);
  assert.equal(canceled.code, 409);
  assert.equal(releases.length, 0);
});

test('resume does not touch historical relay tasks when credentials are unavailable', async () => {
  let queried = false;
  const service = createRelayGenerationService({
    relayClient: { isConfigured: () => false },
    billing: { async commitCredits() {}, async releaseCredits() {} },
    uploadQueue: { async enqueueFinalize() {} },
    realtime: { emitTaskUpdate() {} },
  });
  const result = await service.resume({
    async query() {
      queried = true;
      throw new Error('resume query should be skipped');
    },
  });
  assert.deepEqual(result, { resumed: 0, skipped: 'relay_not_configured' });
  assert.equal(queried, false);
});
