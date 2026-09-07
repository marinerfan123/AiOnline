const test = require('node:test');
const assert = require('node:assert/strict');
const dispatcher = require('../../dispatcher.cjs');

test('watchdog closes resource-starved waiting tasks and releases held credits', async () => {
  const row = {
    task_id: 'gt-waiting-stale', user_id: 'u1', cost: 4,
    cost_pool: 'recharge', idempotency_key: 'idem-1', status: 'waiting',
    error: '等待区超过安全线仍无可用资源，任务保留待复核（资源恢复后可重试）',
    provider_task_id: null,
  };
  const queries = [];
  const releases = [];
  const updates = [];
  const pgPool = {
    async query(sql) {
      queries.push(sql);
      return { rows: [row] };
    },
  };

  assert.equal(typeof dispatcher.scanStuckTasks, 'function', 'watchdog scan must be testable');
  await dispatcher.scanStuckTasks(pgPool, {
    releaseCredits: async (_pg, userId, cost, ref, pool) => releases.push({ userId, cost, ref, pool }),
    updateTaskStatus: async (_pg, taskId, status, result, error, userId) => updates.push({ taskId, status, result, error, userId }),
    emitTaskUpdate: () => {},
  });

  assert.match(queries[0], /status='waiting'/);
  assert.match(queries[0], /provider_task_id IS NULL/);
  assert.deepEqual(releases, [{ userId: 'u1', cost: 4, ref: 'idem-1', pool: 'recharge' }]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'failed');
  assert.match(updates[0].error, /资源等待超时/);
});
