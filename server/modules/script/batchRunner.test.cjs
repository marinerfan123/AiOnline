'use strict';
/**
 * G13 V2.0 must#4 — batchRunner.cjs unit tests（fake store 断言 + 真实 batchTaskStore
 * 集成缝 + 并发/终止/幂等）。provider 波未到：缺省 executor 诚实占位 FAILED。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBatchRunner, defaultExecutor, DEFAULT_MAX_IN_FLIGHT } = require('./batchRunner.cjs');
const { createBatchTaskStore } = require('./batchTaskStore.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ fake store
/**
 * 与 batchTaskStore 同契约的内存假 store：PK(batch_id,task_id)、终态锁 CAS。
 * 记录每次 markTask 调用（含 attempt 是否被传），供「runner 不越权」断言。
 */
function createFakeStore(taskDefs) {
  const rows = new Map(); // key -> row（snake_case，仿 node-pg）
  const calls = { markTask: [], listTasks: 0, retryFailed: 0 };
  const k = (b, t) => `${b}\u0000${t}`;

  for (const d of taskDefs) {
    rows.set(k(d.batchId, d.taskId), {
      batch_id: d.batchId,
      task_id: d.taskId,
      script_id: d.scriptId || 's',
      shot_id: d.shotId || d.taskId,
      kind: d.kind || 'image_gen',
      status: 'QUEUED',
      attempt: 0,
      max_attempts: 3,
      params: d.params || { prompt: `p-${d.taskId}`, model: null },
      result_ref: null,
      error: null,
    });
  }

  function normalize(r) {
    return {
      batchId: r.batch_id,
      taskId: r.task_id,
      scriptId: r.script_id,
      shotId: r.shot_id,
      kind: r.kind,
      status: r.status,
      attempt: r.attempt,
      maxAttempts: r.max_attempts,
      params: r.params,
      resultRef: r.result_ref,
      error: r.error,
    };
  }

  return {
    calls,
    async listTasks(batchId) {
      calls.listTasks += 1;
      const tasks = [...rows.values()]
        .filter((r) => r.batch_id === batchId)
        .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0))
        .map(normalize);
      return { ok: true, tasks };
    },
    async markTask({ batchId, taskId, status, attempt, resultRef, error }) {
      calls.markTask.push({ batchId, taskId, status, attempt, resultRef, error });
      const r = rows.get(k(batchId, taskId));
      if (!r) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'not found' } };
      if (r.status === 'SUCCEEDED' || r.status === 'FAILED' || r.status === 'SKIPPED') {
        return { ok: false, error: { code: 'TERMINAL_STATE', message: `task is ${r.status}` } };
      }
      r.status = status;
      if (attempt !== undefined && attempt !== null) r.attempt = attempt;
      if (resultRef !== undefined && resultRef !== null) r.result_ref = resultRef;
      if (error !== undefined && error !== null) r.error = error;
      return { ok: true, task: normalize(r) };
    },
    async claimTask({ batchId, taskId }) {
      calls.claimTask = (calls.claimTask || 0) + 1;
      const r = rows.get(k(batchId, taskId));
      if (!r) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'not found' } };
      if (r.status === 'SUCCEEDED' || r.status === 'FAILED' || r.status === 'SKIPPED') {
        return { ok: false, error: { code: 'TERMINAL_STATE', message: `task is ${r.status}` } };
      }
      if (r.status === 'RUNNING') {
        return { ok: false, error: { code: 'ALREADY_CLAIMED', message: 'already running' } };
      }
      r.status = 'RUNNING';
      return { ok: true, task: normalize(r) };
    },
    row: (batchId, taskId) => rows.get(k(batchId, taskId)),
    all: (batchId) => [...rows.values()].filter((r) => r.batch_id === batchId),
  };
}

function errorCode(row) {
  if (!row || row.error == null) return null;
  try { return JSON.parse(row.error).code; } catch (_) { return row.error; }
}

// ------------------------------------------------------------ 缺省 executor
test('缺省 executor：任务 QUEUED→RUNNING→FAILED，code=EXECUTOR_UNCONFIGURED', async () => {
  const store = createFakeStore([{ batchId: 'b1', taskId: 's1::image_gen' }]);
  const runner = createBatchRunner({ store }); // 无 executor

  const r = await runner.runOnce('b1');
  assert.equal(r.ok, true);
  assert.equal(r.claimed, 1);
  assert.equal(r.results[0].status, 'FAILED');
  assert.equal(r.results[0].error.code, 'EXECUTOR_UNCONFIGURED');

  const row = store.row('b1', 's1::image_gen');
  assert.equal(row.status, 'FAILED');
  assert.equal(errorCode(row), 'EXECUTOR_UNCONFIGURED');

  // 迁移链：claimTask(RUNNING) 先于 markTask(FAILED)
  assert.equal(store.calls.claimTask, 1);
  assert.deepEqual(
    store.calls.markTask.map((c) => c.status),
    ['FAILED'],
  );
});

// ------------------------------------------------------------ 注入 executor 成功路径
test('注入 executor 成功路径：mark SUCCEEDED(resultRef)，executor 收到完整 task', async () => {
  const store = createFakeStore([{ batchId: 'b1', taskId: 's1::image_gen', shotId: 's1' }]);
  const seen = [];
  const executor = {
    run: async (task) => {
      seen.push(task);
      return { ok: true, resultRef: 'oss://bucket/s1.png' };
    },
  };
  const runner = createBatchRunner({ store, executor });

  const r = await runner.runOnce('b1');
  assert.equal(r.claimed, 1);
  assert.equal(r.results[0].status, 'SUCCEEDED');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].taskId, 's1::image_gen');
  assert.equal(seen[0].kind, 'image_gen');
  assert.equal(seen[0].params.prompt, 'p-s1::image_gen');

  const row = store.row('b1', 's1::image_gen');
  assert.equal(row.status, 'SUCCEEDED');
  assert.equal(row.result_ref, 'oss://bucket/s1.png');
});

// ------------------------------------------------------------ 注入 executor 失败路径
test('注入 executor 失败路径：{ok:false,error} → mark FAILED(code 保留)', async () => {
  const store = createFakeStore([{ batchId: 'b1', taskId: 's1::image_gen' }]);
  const executor = { run: async () => ({ ok: false, error: { code: 'PROVIDER_TIMEOUT', message: 'upstream dead' } }) };
  const runner = createBatchRunner({ store, executor });

  const r = await runner.runOnce('b1');
  assert.equal(r.results[0].status, 'FAILED');
  assert.equal(r.results[0].error.code, 'PROVIDER_TIMEOUT');

  const row = store.row('b1', 's1::image_gen');
  assert.equal(row.status, 'FAILED');
  assert.equal(errorCode(row), 'PROVIDER_TIMEOUT');
});

// ------------------------------------------------------------ executor 抛异常
test('executor 抛异常 → FAILED，code=EXECUTOR_THREW', async () => {
  const store = createFakeStore([{ batchId: 'b1', taskId: 's1::image_gen' }]);
  const executor = { run: async () => { throw new Error('boom'); } };
  const runner = createBatchRunner({ store, executor });

  const r = await runner.runOnce('b1');
  assert.equal(r.results[0].status, 'FAILED');
  assert.equal(r.results[0].error.code, 'EXECUTOR_THREW');
  assert.equal(store.row('b1', 's1::image_gen').status, 'FAILED');
});

// ------------------------------------------------------------ attempt 上限由 store 管
test('runner 不越权 attempt/retry：从不传 attempt、不重试 FAILED', async () => {
  const store = createFakeStore([{ batchId: 'b1', taskId: 's1::image_gen' }]);
  const executor = { run: async () => ({ ok: false, error: { code: 'X', message: 'x' } }) };
  const runner = createBatchRunner({ store, executor });

  await runner.runOnce('b1'); // → FAILED
  // runner 不越权：claim 走 claimTask（无 attempt 参数），所有 markTask 调用都不携带 attempt。
  assert.equal(store.calls.claimTask, 1, 'runner claims via claimTask');
  for (const c of store.calls.markTask) {
    assert.equal(c.attempt, undefined, 'runner must never set attempt');
  }
  // runner 只做了 claimTask(RUNNING) + markTask(FAILED)，从不触 retryFailed（store 无该方法，runner 不引用）。
  assert.equal(store.calls.retryFailed, 0);

  // FAILED 是终态：再次 runOnce 不得重领（重试归 store.retryFailed 管）。
  const again = await runner.runOnce('b1');
  assert.equal(again.claimed, 0, 'runner must not re-claim a terminal FAILED task');
  assert.equal(store.row('b1', 's1::image_gen').status, 'FAILED');
});

// ------------------------------------------------------------ 并发 runOnce 单执行
test('并发 runOnce 单执行：N 个并发轮次只执行每 task 一次', async () => {
  const tasks = [
    { batchId: 'b1', taskId: 't1::image_gen' },
    { batchId: 'b1', taskId: 't2::image_gen' },
    { batchId: 'b1', taskId: 't3::image_gen' },
  ];
  const store = createFakeStore(tasks);
  const runs = [];
  const executor = {
    run: async (task) => {
      await sleep(5); // 制造交错，放大竞态窗口
      runs.push(task.taskId);
      return { ok: true, resultRef: `oss://${task.taskId}.png` };
    },
  };
  const runner = createBatchRunner({ store, executor, maxInFlight: 4 });

  // 三个 runOnce 并发（都能覆盖全部任务），断言单执行。
  const [a, b, c] = await Promise.all([runner.runOnce('b1'), runner.runOnce('b1'), runner.runOnce('b1')]);
  assert.equal(a.ok && b.ok && c.ok, true);

  // 每个 task 恰好执行一次（无重复、无遗漏）。
  assert.deepEqual(runs.sort(), ['t1::image_gen', 't2::image_gen', 't3::image_gen']);
  assert.equal(runs.length, 3);

  // 累计领单 = 3，无重复（三者的 claimed 总和恰好等于任务数）。
  const totalClaimed = a.claimed + b.claimed + c.claimed;
  assert.equal(totalClaimed, 3);

  // 全部终态 SUCCEEDED。
  for (const t of tasks) assert.equal(store.row('b1', t.taskId).status, 'SUCCEEDED');
});

test('跨进程双 runner：严格 claimTask 保证每 task 只被一个 runner 执行', async () => {
  const tasks = [
    { batchId: 'b1', taskId: 't1::image_gen' },
    { batchId: 'b1', taskId: 't2::image_gen' },
  ];
  const store = createFakeStore(tasks);
  const runs = [];
  const makeExecutor = () => ({
    run: async (task) => {
      await sleep(5); // 放大竞态窗口
      runs.push(task.taskId);
      return { ok: true, resultRef: `oss://${task.taskId}.png` };
    },
  });
  // 两个独立 runner 实例（模拟两个进程）共享同一 store：进程内 inFlight 互不可见，
  // 只有 store 的 claimTask 严格 CAS（QUEUED→RUNNING 单赢者）能防双跑。
  const r1 = createBatchRunner({ store, executor: makeExecutor(), maxInFlight: 4 });
  const r2 = createBatchRunner({ store, executor: makeExecutor(), maxInFlight: 4 });

  const [a, b] = await Promise.all([r1.runOnce('b1'), r2.runOnce('b1')]);
  assert.equal(a.ok && b.ok, true);

  // 每个 task 恰好执行一次（无重复、无遗漏）。
  assert.deepEqual(runs.sort(), ['t1::image_gen', 't2::image_gen']);
  assert.equal(runs.length, 2);

  // 两 runner 各尝试领 2 个候选（各自 listTasks 都看到 QUEUED），但实际只有 2 次成功，
  // 其余 2 次被 claimTask 拒（ALREADY_CLAIMED）而放弃。
  const allResults = [...a.results, ...b.results];
  assert.equal(allResults.filter((r) => r.claimed === true).length, 2, 'exactly 2 successful claims');
  assert.equal(allResults.filter((r) => r.claimed === false).length, 2, '2 loser claims skipped');
  assert.ok(
    allResults.filter((r) => r.claimed === false).every((r) => r.reason === 'ALREADY_CLAIMED'),
    'losers skipped with ALREADY_CLAIMED',
  );

  for (const t of tasks) assert.equal(store.row('b1', t.taskId).status, 'SUCCEEDED');
});

test('maxInFlight 上限：单轮只领 ≤maxInFlight，余量下一轮再领', async () => {
  const store = createFakeStore([
    { batchId: 'b1', taskId: 't1::image_gen' },
    { batchId: 'b1', taskId: 't2::image_gen' },
    { batchId: 'b1', taskId: 't3::image_gen' },
  ]);
  const executor = { run: async (t) => ({ ok: true, resultRef: `r-${t.taskId}` }) };
  const runner = createBatchRunner({ store, executor, maxInFlight: 2 });

  const first = await runner.runOnce('b1');
  assert.equal(first.claimed, 2, 'capped at maxInFlight');
  assert.equal(store.row('b1', 't3::image_gen').status, 'QUEUED', 'tail stays queued');

  const second = await runner.runOnce('b1');
  assert.equal(second.claimed, 1, 'remainder claimed next round');
  assert.equal(store.row('b1', 't3::image_gen').status, 'SUCCEEDED');
});

// ------------------------------------------------------------ stop 终止
test('stop 后不再领：runOnce 返回 claimed=0 且无 RUNNING 写入', async () => {
  const store = createFakeStore([{ batchId: 'b1', taskId: 's1::image_gen' }]);
  const executor = { run: async () => ({ ok: true, resultRef: 'r' }) };
  const runner = createBatchRunner({ store, executor });

  runner.stop();
  const r = await runner.runOnce('b1');
  assert.equal(r.ok, true);
  assert.equal(r.claimed, 0);
  assert.equal(r.stopped, true);
  assert.equal(store.calls.markTask.length, 0, 'no markTask after stop');
  assert.equal(store.row('b1', 's1::image_gen').status, 'QUEUED', 'task untouched');
});

test('start/stop 清理：timer 清除、幂等、可重启', async () => {
  const store = createFakeStore([]);
  const runner = createBatchRunner({ store, pollMs: 5 });

  assert.equal(runner.state().timerActive, false);
  assert.equal(runner.state().stopped, false);

  runner.start('b1');
  assert.equal(runner.state().timerActive, true);
  assert.equal(runner.state().stopped, false);
  assert.equal(runner.state().batchId, 'b1');

  // start 幂等：重复 start 不产生第二个循环。
  const again = runner.start('b1');
  assert.equal(again.alreadyRunning, true);

  runner.stop();
  assert.equal(runner.state().stopped, true);
  assert.equal(runner.state().timerActive, false, 'timer cleared on stop');

  runner.stop(); // stop 幂等
  assert.equal(runner.state().stopped, true);

  // 重启可用。
  runner.start('b1');
  assert.equal(runner.state().stopped, false);
  assert.equal(runner.state().timerActive, true);
  runner.stop();
});

test('start 轮询循环实际执行任务，stop 后停摆', async () => {
  const store = createFakeStore([{ batchId: 'b1', taskId: 's1::image_gen' }]);
  const runs = [];
  const executor = {
    run: async (task) => { runs.push(task.taskId); return { ok: true, resultRef: 'r' }; },
  };
  const runner = createBatchRunner({ store, executor, pollMs: 5 });

  runner.start('b1');
  await sleep(40); // 允许首轮 tick 领单执行
  assert.equal(runs.length, 1, 'poll loop claimed and executed the queued task');
  assert.equal(store.row('b1', 's1::image_gen').status, 'SUCCEEDED');

  runner.stop();
  const n = runs.length;
  await sleep(30); // 若 stop 未生效，轮询会继续（但任务已终态，不再执行）
  assert.equal(runs.length, n, 'no further executions after stop');
});

// ------------------------------------------------------------ 边界/校验
test('createBatchRunner 校验：非法 store/maxInFlight/executor 抛 TypeError', () => {
  assert.throws(() => createBatchRunner({}), TypeError);
  assert.throws(() => createBatchRunner({ store: { markTask() {} } }), TypeError); // 缺 listTasks
  assert.throws(() => createBatchRunner({ store: { listTasks() {} } }), TypeError); // 缺 markTask
  assert.throws(() => createBatchRunner({ store: { listTasks() {}, markTask() {} } }), TypeError); // 缺 claimTask
  const store = createFakeStore([]);
  assert.throws(() => createBatchRunner({ store, maxInFlight: 0 }), TypeError);
  assert.throws(() => createBatchRunner({ store, maxInFlight: 1.5 }), TypeError);
  assert.throws(() => createBatchRunner({ store, executor: {} }), TypeError); // executor 缺 run
});

test('runOnce 无 batchId → INVALID_BATCH_ID；onLog 收到结构化事件', async () => {
  const store = createFakeStore([{ batchId: 'b1', taskId: 's1::image_gen' }]);
  const logs = [];
  const runner = createBatchRunner({ store, onLog: (e) => logs.push(e) });

  const r = await runner.runOnce(); // 未 start 且无参
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_BATCH_ID');

  await runner.runOnce('b1');
  assert.ok(logs.length >= 2, 'claim + final events logged');
  assert.equal(logs[0].level, 'info');
  assert.equal(logs[0].taskId, 's1::image_gen');
});

// ------------------------------------------------------------ 集成缝（真实 store）
test('集成缝：真实 batchTaskStore 落库 → runner 缺省 executor → FAILED EXECUTOR_UNCONFIGURED', async () => {
  const { pg, row } = createMinimalPg();
  const store = createBatchTaskStore({ pg });
  const { batchId } = await store.createBatch({
    scriptId: 'script-1',
    tasks: [{ taskId: 's1::image_gen', shotId: 's1', kind: 'image_gen', params: { prompt: 'p', model: null } }],
  });

  const runner = createBatchRunner({ store }); // 缺省 executor
  const r = await runner.runOnce(batchId);
  assert.equal(r.ok, true);
  assert.equal(r.claimed, 1);

  const { tasks } = await store.listTasks(batchId);
  assert.equal(tasks[0].status, 'FAILED');
  const code = (() => { try { return JSON.parse(tasks[0].error).code; } catch (_) { return null; } })();
  assert.equal(code, 'EXECUTOR_UNCONFIGURED');
  assert.equal(row(batchId, 's1::image_gen').status, 'FAILED');
});

/**
 * 极简 mock pg：仅实现 batchTaskStore 建批 + markTask + listTasks 命中的 SQL 形状，
 * 未知 SQL 直接抛错（测试即失败），确保集成路径真实。
 */
function createMinimalPg() {
  const rows = new Map();
  const k = (b, t) => `${b}\u0000${t}`;
  const calls = [];
  return {
    get calls() { return calls; },
    row: (b, t) => rows.get(k(b, t)),
    pg: {
      async query(text, params = []) {
        calls.push(String(text));
        const sql = String(text).trim();
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS storyboard_batch_tasks')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO storyboard_batch_tasks')) {
          const inserted = [];
          for (let i = 0; i < params.length; i += 6) {
            const [batch_id, task_id, script_id, shot_id, kind, paramsJson] = params.slice(i, i + 6);
            rows.set(k(batch_id, task_id), {
              batch_id, task_id, script_id, shot_id, kind,
              status: 'QUEUED', attempt: 0, max_attempts: 3,
              params: JSON.parse(paramsJson), result_ref: null, error: null,
            });
            inserted.push({ task_id });
          }
          return { rows: inserted, rowCount: inserted.length };
        }
        if (sql.includes("SET status = 'RUNNING'") && !sql.includes('$3')) {
          // claimTask：仅 QUEUED → RUNNING。
          const [batchId, taskId] = params;
          const r = rows.get(k(batchId, taskId));
          if (!r || r.status !== 'QUEUED') return { rows: [], rowCount: 0 };
          r.status = 'RUNNING';
          return { rows: [{ ...r }], rowCount: 1 };
        }
        if (sql.includes("status IN ('QUEUED', 'RUNNING')")) {
          const [batchId, taskId, status, attemptVal, resultRefVal, errorVal] = params;
          const r = rows.get(k(batchId, taskId));
          if (!r || (r.status !== 'QUEUED' && r.status !== 'RUNNING')) {
            return { rows: [], rowCount: 0 };
          }
          r.status = status;
          if (attemptVal != null) r.attempt = attemptVal;
          if (resultRefVal != null) r.result_ref = resultRefVal;
          if (errorVal != null) r.error = errorVal;
          return { rows: [{ ...r }], rowCount: 1 };
        }
        if (sql.includes('SELECT status FROM storyboard_batch_tasks')) {
          const [batchId, taskId] = params;
          const r = rows.get(k(batchId, taskId));
          return r ? { rows: [{ status: r.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (sql.includes('ORDER BY task_id')) {
          const [batchId] = params;
          const list = [...rows.values()].filter((r) => r.batch_id === batchId)
            .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
          return { rows: list.map((r) => ({ ...r })), rowCount: list.length };
        }
        throw new Error(`minimal mock pg: unhandled SQL: ${sql}`);
      },
    },
  };
}
