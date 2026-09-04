'use strict';
/**
 * G13 V2.0 must#4 — batchTaskStore.cjs unit tests (mock pg 按 SQL 形状路由，
 * 复刻真实 PostgreSQL 的 storyboard_batch_tasks 语义：PK(batch_id,task_id)、
 * UNIQUE(script_id,shot_id,kind,batch_id)、终态 CAS 锁、retryFailed 守卫)。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBatchTaskStore } = require('./batchTaskStore.cjs');

/** 与 storyboardBatchPlan 同形的任务夹具。 */
function TASK(taskId, shotId, params) {
  return { taskId, shotId, kind: 'image_gen', params: params || { prompt: `p-${shotId}`, model: null } };
}

/**
 * 内存版 storyboard_batch_tasks。行按 snake_case 存（镜像 node-pg 返回），
 * params 存为已 parse 对象；INSERT 收到 JSON 字符串则 JSON.parse 后落库。
 */
function createMockPg() {
  const rowsByKey = new Map(); // `${batch_id}\u0000${task_id}` -> row
  const uniqueAnchor = new Set(); // `${script_id}\u0000${shot_id}\u0000${kind}\u0000${batch_id}`
  const calls = [];
  let createCalls = 0;
  let seq = 0;

  const key = (b, t) => `${b}\u0000${t}`;
  const now = () => new Date(Date.UTC(2026, 8, 4, 0, 0, seq++)).toISOString();
  const full = (row) => ({ ...row });

  function rowFor(batchId, taskId) {
    return rowsByKey.get(key(batchId, taskId)) || null;
  }

  function insertRow({ batch_id, task_id, script_id, shot_id, kind, params, status, attempt, max_attempts }) {
    const k = key(batch_id, task_id);
    if (rowsByKey.has(k)) {
      const e = new Error('duplicate key value violates unique constraint "storyboard_batch_tasks_pkey"');
      e.code = '23505'; e.constraint = 'storyboard_batch_tasks_pkey';
      throw e;
    }
    const anchor = `${script_id}\u0000${shot_id}\u0000${kind}\u0000${batch_id}`;
    if (uniqueAnchor.has(anchor)) {
      const e = new Error('duplicate key value violates unique constraint "storyboard_batch_tasks_script_shot_kind_batch_key"');
      e.code = '23505'; e.constraint = 'storyboard_batch_tasks_script_shot_kind_batch_key';
      throw e;
    }
    uniqueAnchor.add(anchor);
    const row = {
      batch_id, task_id, script_id, shot_id, kind,
      status, attempt, max_attempts,
      params,
      result_ref: null, error: null,
      created_at: now(), updated_at: now(),
    };
    rowsByKey.set(k, row);
    return row;
  }

  async function query(text, params = []) {
    calls.push({ text: String(text), params });
    const sql = String(text).trim();

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS storyboard_batch_tasks')) {
      createCalls += 1;
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes('INSERT INTO storyboard_batch_tasks')) {
      // 多行 VALUES：每行 6 参数 [batch, task, script, shot, kind, params_json]。
      const inserted = [];
      for (let i = 0; i < params.length; i += 6) {
        const [batch_id, task_id, script_id, shot_id, kind, paramsJson] = params.slice(i, i + 6);
        insertRow({
          batch_id, task_id, script_id, shot_id, kind,
          params: JSON.parse(paramsJson),
          status: 'QUEUED', attempt: 0, max_attempts: 3,
        });
        inserted.push({ task_id });
      }
      return { rows: inserted, rowCount: inserted.length };
    }

    if (sql.startsWith('UPDATE storyboard_batch_tasks')) {
      if (sql.includes("SET status = 'RUNNING'") && !sql.includes('$3')) {
        // claimTask 严格 CAS：仅 QUEUED → RUNNING（单赢者）。
        const [batchId, taskId] = params;
        const row = rowFor(batchId, taskId);
        if (!row || row.status !== 'QUEUED') return { rows: [], rowCount: 0 };
        row.status = 'RUNNING';
        row.updated_at = now();
        return { rows: [full(row)], rowCount: 1 };
      }
      if (sql.includes("status IN ('QUEUED', 'RUNNING')")) {
        // markTask 转移矩阵 CAS：RUNNING 目标仅从 QUEUED；终态目标仅从 QUEUED/RUNNING。
        const [batchId, taskId, status, attemptVal, resultRefVal, errorVal] = params;
        const row = rowFor(batchId, taskId);
        if (!row) return { rows: [], rowCount: 0 };
        const from = row.status;
        const allowed = (status === 'RUNNING' && from === 'QUEUED')
          || (['SUCCEEDED', 'FAILED', 'SKIPPED'].includes(status) && (from === 'QUEUED' || from === 'RUNNING'));
        if (!allowed) return { rows: [], rowCount: 0 };
        row.status = status;
        if (attemptVal !== null && attemptVal !== undefined) row.attempt = attemptVal;
        if (resultRefVal !== null && resultRefVal !== undefined) row.result_ref = resultRefVal;
        if (errorVal !== null && errorVal !== undefined) row.error = errorVal;
        row.updated_at = now();
        return { rows: [full(row)], rowCount: 1 };
      }
      if (sql.includes("status = 'FAILED'") && sql.includes('attempt < max_attempts')) {
        // retryFailed：仅 FAILED 且 attempt < max_attempts。
        const [batchId] = params;
        const reset = [];
        for (const row of rowsByKey.values()) {
          if (row.batch_id === batchId && row.status === 'FAILED' && row.attempt < row.max_attempts) {
            row.status = 'QUEUED';
            row.attempt += 1;
            row.result_ref = null;
            row.error = null;
            row.updated_at = now();
            reset.push({ task_id: row.task_id });
          }
        }
        return { rows: reset, rowCount: reset.length };
      }
      throw new Error(`mock pg: unhandled UPDATE: ${sql}`);
    }

    if (sql.includes('GROUP BY status')) {
      // progress：按状态聚合。
      const [batchId] = params;
      const counts = new Map();
      for (const row of rowsByKey.values()) {
        if (row.batch_id === batchId) {
          counts.set(row.status, (counts.get(row.status) || 0) + 1);
        }
      }
      return { rows: [...counts.entries()].map(([status, n]) => ({ status, n })), rowCount: counts.size };
    }

    if (sql.includes('SELECT status FROM storyboard_batch_tasks')) {
      // markTask 失败回查现状（单行 status）。
      const [batchId, taskId] = params;
      const row = rowFor(batchId, taskId);
      return row ? { rows: [{ status: row.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.includes('ORDER BY task_id')) {
      // listTasks：按 task_id 升序。
      const [batchId] = params;
      const rows = [...rowsByKey.values()]
        .filter((r) => r.batch_id === batchId)
        .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0))
        .map(full);
      return { rows, rowCount: rows.length };
    }

    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }

  return {
    pg: { query },
    calls,
    get createCalls() { return createCalls; },
    row: (batchId, taskId) => rowFor(batchId, taskId),
    rowsForBatch: (batchId) => [...rowsByKey.values()].filter((r) => r.batch_id === batchId),
  };
}

// ------------------------------------------------------------ 建批入行
test('createBatch enqueues every task QUEUED/attempt=0/max=3 and returns bt-prefixed batchId', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const r = await store.createBatch({
    scriptId: 'script-1',
    tasks: [TASK('s1::image_gen', 's1'), TASK('s2::image_gen', 's2')],
  });
  assert.equal(r.ok, true);
  assert.match(r.batchId, /^bt-/);
  assert.equal(r.enqueued, 2);

  const { ok, tasks } = await store.listTasks(r.batchId);
  assert.equal(ok, true);
  assert.deepEqual(tasks.map((t) => t.taskId), ['s1::image_gen', 's2::image_gen']);
  for (const t of tasks) {
    assert.equal(t.status, 'QUEUED');
    assert.equal(t.attempt, 0);
    assert.equal(t.maxAttempts, 3);
    assert.equal(t.scriptId, 'script-1');
    assert.equal(t.kind, 'image_gen');
  }
  // params round-trip 经 jsonb
  assert.equal(tasks[0].params.prompt, 'p-s1');
  assert.equal(m.createCalls, 1);
});

test('createBatch: empty tasks → valid empty batch; batchId still bt-prefixed', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const r = await store.createBatch({ scriptId: 'script-1', tasks: [] });
  assert.equal(r.ok, true);
  assert.match(r.batchId, /^bt-/);
  assert.equal(r.enqueued, 0);
  const { tasks } = await store.listTasks(r.batchId);
  assert.deepEqual(tasks, []);
});

test('createBatch validates scriptId / tasks shape / duplicate taskId', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  assert.equal((await store.createBatch({ tasks: [TASK('a', 'a')] })).error.code, 'INVALID_SCRIPT_ID');
  assert.equal((await store.createBatch({ scriptId: 's', tasks: 'nope' })).error.code, 'INVALID_TASKS');
  assert.equal((await store.createBatch({ scriptId: 's', tasks: [{ shotId: 'a', kind: 'x' }] })).error.code, 'INVALID_TASK');
  assert.equal(
    (await store.createBatch({ scriptId: 's', tasks: [TASK('dup', 'a'), TASK('dup', 'b')] })).error.code,
    'INVALID_TASK',
  );
  assert.equal((await store.createBatch({ scriptId: 's', tasks: [{ taskId: 'a', shotId: 'a', kind: 'x', params: 'str' }] })).error.code, 'INVALID_TASK');
  assert.equal(m.calls.length, 0); // 全部校验失败，未触达 SQL
});

// ------------------------------------------------------------ 正常迁移链
test('full cycle: QUEUED→RUNNING→FAILED→retryFailed→QUEUED(attempt+1)→SUCCEEDED', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({ scriptId: 's', tasks: [TASK('s1::image_gen', 's1')] });

  const run = await store.markTask({ batchId, taskId: 's1::image_gen', status: 'RUNNING' });
  assert.equal(run.ok, true);
  assert.equal(run.task.status, 'RUNNING');
  assert.equal(run.task.attempt, 0);

  const fail = await store.markTask({ batchId, taskId: 's1::image_gen', status: 'FAILED', error: 'provider timeout' });
  assert.equal(fail.ok, true);
  assert.equal(fail.task.status, 'FAILED');
  assert.equal(fail.task.error, 'provider timeout');

  const retry = await store.retryFailed(batchId);
  assert.equal(retry.ok, true);
  assert.equal(retry.reset, 1);
  assert.equal(m.row(batchId, 's1::image_gen').status, 'QUEUED');
  assert.equal(m.row(batchId, 's1::image_gen').attempt, 1);
  assert.equal(m.row(batchId, 's1::image_gen').error, null);

  const ok = await store.markTask({ batchId, taskId: 's1::image_gen', status: 'SUCCEEDED', resultRef: 'oss://x.png' });
  assert.equal(ok.ok, true);
  assert.equal(ok.task.status, 'SUCCEEDED');
  assert.equal(ok.task.resultRef, 'oss://x.png');
  assert.equal(ok.task.attempt, 1);
});

// ------------------------------------------------------------ 终态锁
test('terminal state lock: SUCCEEDED/FAILED/SKIPPED cannot be overwritten by markTask', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({
    scriptId: 's',
    tasks: [TASK('a::image_gen', 'a'), TASK('b::image_gen', 'b'), TASK('c::image_gen', 'c')],
  });
  await store.markTask({ batchId, taskId: 'a::image_gen', status: 'SUCCEEDED', resultRef: 'r' });
  await store.markTask({ batchId, taskId: 'b::image_gen', status: 'FAILED', error: 'e' });
  await store.markTask({ batchId, taskId: 'c::image_gen', status: 'SKIPPED' });

  for (const [taskId, cur] of [['a::image_gen', 'SUCCEEDED'], ['b::image_gen', 'FAILED'], ['c::image_gen', 'SKIPPED']]) {
    const r = await store.markTask({ batchId, taskId, status: 'RUNNING' });
    assert.equal(r.ok, false, `${cur} must be locked`);
    assert.equal(r.error.code, 'TERMINAL_STATE');
    assert.equal(m.row(batchId, taskId).status, cur, 'status unchanged after rejected overwrite');
  }
});

// ------------------------------------------------------------ markTask 非法迁移拒
test('markTask rejects invalid status / missing task / bad attempt', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({ scriptId: 's', tasks: [TASK('a::image_gen', 'a')] });

  assert.equal((await store.markTask({ batchId, taskId: 'a::image_gen', status: 'BOGUS' })).error.code, 'INVALID_STATUS');
  assert.equal((await store.markTask({ batchId, taskId: 'ghost::image_gen', status: 'RUNNING' })).error.code, 'TASK_NOT_FOUND');
  assert.equal((await store.markTask({ batchId, taskId: 'a::image_gen', status: 'RUNNING', attempt: -1 })).error.code, 'INVALID_ATTEMPT');
  assert.equal(m.row(batchId, 'a::image_gen').status, 'QUEUED', 'no mutation after rejected calls');
});

// ------------------------------------------------------------ claimTask 单赢者
test('claimTask: QUEUED→RUNNING 成功；二次 claim 得 ALREADY_CLAIMED（跨进程单赢者）', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({ scriptId: 's', tasks: [TASK('a::image_gen', 'a')] });

  const first = await store.claimTask({ batchId, taskId: 'a::image_gen' });
  assert.equal(first.ok, true);
  assert.equal(first.task.status, 'RUNNING');
  assert.equal(first.task.attempt, 0, 'claim 不消费重试计数');

  const second = await store.claimTask({ batchId, taskId: 'a::image_gen' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'ALREADY_CLAIMED');
  assert.equal(m.row(batchId, 'a::image_gen').status, 'RUNNING', '二次 claim 不改状态');
});

test('claimTask: 终态 → TERMINAL_STATE；不存在 → TASK_NOT_FOUND', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({
    scriptId: 's',
    tasks: [TASK('ok::image_gen', 'ok'), TASK('fail::image_gen', 'fail')],
  });
  await store.markTask({ batchId, taskId: 'ok::image_gen', status: 'SUCCEEDED', resultRef: 'r' });
  await store.markTask({ batchId, taskId: 'fail::image_gen', status: 'FAILED', error: 'e' });

  const succ = await store.claimTask({ batchId, taskId: 'ok::image_gen' });
  assert.equal(succ.ok, false);
  assert.equal(succ.error.code, 'TERMINAL_STATE');
  const fail = await store.claimTask({ batchId, taskId: 'fail::image_gen' });
  assert.equal(fail.error.code, 'TERMINAL_STATE');
  const ghost = await store.claimTask({ batchId, taskId: 'ghost::image_gen' });
  assert.equal(ghost.error.code, 'TASK_NOT_FOUND');
});

// ------------------------------------------------------------ markTask 转移矩阵（禁止双跑/降级）
test('markTask 转移矩阵：RUNNING→RUNNING 与 RUNNING→QUEUED 被拒（INVALID_TRANSITION）', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({ scriptId: 's', tasks: [TASK('a::image_gen', 'a')] });

  await store.markTask({ batchId, taskId: 'a::image_gen', status: 'RUNNING' });
  assert.equal(m.row(batchId, 'a::image_gen').status, 'RUNNING');

  // 旧实现漏洞：RUNNING→RUNNING 曾二次成功 → 双跑。现在必须被拒。
  const reRun = await store.markTask({ batchId, taskId: 'a::image_gen', status: 'RUNNING' });
  assert.equal(reRun.ok, false);
  assert.equal(reRun.error.code, 'INVALID_TRANSITION');

  // RUNNING→QUEUED 降级同样被拒（复位只走 retryFailed 专用 SQL）。
  const downgrade = await store.markTask({ batchId, taskId: 'a::image_gen', status: 'QUEUED' });
  assert.equal(downgrade.ok, false);
  assert.equal(downgrade.error.code, 'INVALID_TRANSITION');
  assert.equal(m.row(batchId, 'a::image_gen').status, 'RUNNING', '非法迁移不改状态');
});

test('markTask QUEUED→QUEUED 空转被拒（INVALID_TRANSITION），不作无谓写', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({ scriptId: 's', tasks: [TASK('a::image_gen', 'a')] });
  const r = await store.markTask({ batchId, taskId: 'a::image_gen', status: 'QUEUED' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_TRANSITION');
  assert.equal(m.row(batchId, 'a::image_gen').status, 'QUEUED');
});

// ------------------------------------------------------------ retryFailed 只重置可重试
test('retryFailed resets ONLY FAILED rows with attempt < max_attempts', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({
    scriptId: 's',
    tasks: [
      TASK('retryable::image_gen', 'retryable'),
      TASK('exhausted::image_gen', 'exhausted'),
      TASK('ok::image_gen', 'ok'),
      TASK('queued::image_gen', 'queued'),
    ],
  });
  await store.markTask({ batchId, taskId: 'retryable::image_gen', status: 'FAILED', error: 'e1' }); // attempt 0
  await store.markTask({ batchId, taskId: 'exhausted::image_gen', status: 'FAILED', error: 'e2' });
  await store.markTask({ batchId, taskId: 'exhausted::image_gen', status: 'FAILED' }); // no-op won't run (terminal)
  // 直接把 exhausted 的 attempt 打到上限，模拟已重试 3 次
  m.row(batchId, 'exhausted::image_gen').attempt = 3;
  await store.markTask({ batchId, taskId: 'ok::image_gen', status: 'SUCCEEDED', resultRef: 'r' });
  // queued 保持 QUEUED

  const r = await store.retryFailed(batchId);
  assert.equal(r.ok, true);
  assert.equal(r.reset, 1, 'only the retryable FAILED row is reset');
  assert.equal(m.row(batchId, 'retryable::image_gen').status, 'QUEUED');
  assert.equal(m.row(batchId, 'retryable::image_gen').attempt, 1);
  assert.equal(m.row(batchId, 'exhausted::image_gen').status, 'FAILED', 'attempt cap row untouched');
  assert.equal(m.row(batchId, 'ok::image_gen').status, 'SUCCEEDED');
  assert.equal(m.row(batchId, 'queued::image_gen').status, 'QUEUED');
});

// ------------------------------------------------------------ attempt 上限后不重置
test('retryFailed stops resetting once attempt reaches max_attempts', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({ scriptId: 's', tasks: [TASK('x::image_gen', 'x')] });

  // 模拟重试到 attempt=3（= max_attempts）仍失败。
  for (let i = 0; i < 3; i += 1) {
    await store.markTask({ batchId, taskId: 'x::image_gen', status: 'FAILED', error: `e${i}` });
    const r = await store.retryFailed(batchId);
    assert.equal(r.reset, 1, `retry ${i} should reset`);
  }
  // attempt 现为 3；再失败一次，retryFailed 不再复位。
  await store.markTask({ batchId, taskId: 'x::image_gen', status: 'FAILED', error: 'final' });
  const last = await store.retryFailed(batchId);
  assert.equal(last.reset, 0, 'attempt at cap must not be reset');
  assert.equal(m.row(batchId, 'x::image_gen').status, 'FAILED');
  assert.equal(m.row(batchId, 'x::image_gen').attempt, 3);
});

// ------------------------------------------------------------ progress 计数
test('progress returns total + per-status counts across all five states', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const { batchId } = await store.createBatch({
    scriptId: 's',
    tasks: [
      TASK('a::image_gen', 'a'),
      TASK('b::image_gen', 'b'),
      TASK('c::image_gen', 'c'),
      TASK('d::image_gen', 'd'),
      TASK('e::image_gen', 'e'),
    ],
  });
  await store.markTask({ batchId, taskId: 'b::image_gen', status: 'RUNNING' });
  await store.markTask({ batchId, taskId: 'c::image_gen', status: 'SUCCEEDED', resultRef: 'r' });
  await store.markTask({ batchId, taskId: 'd::image_gen', status: 'FAILED', error: 'e' });
  await store.markTask({ batchId, taskId: 'e::image_gen', status: 'SKIPPED' });

  const p = await store.progress(batchId);
  assert.equal(p.ok, true);
  assert.equal(p.total, 5);
  assert.deepEqual(p.byStatus, {
    QUEUED: 1, RUNNING: 1, SUCCEEDED: 1, FAILED: 1, SKIPPED: 1,
  });

  const empty = await store.progress('no-such-batch');
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.byStatus, { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, SKIPPED: 0 });
});

// ------------------------------------------------------------ 幂等/批隔离
test('batches are independent: same (script,shot,kind) may re-enqueue in a new batch', async () => {
  const m = createMockPg();
  const store = createBatchTaskStore({ pg: m.pg });
  const b1 = await store.createBatch({ scriptId: 's', tasks: [TASK('s1::image_gen', 's1')] });
  const b2 = await store.createBatch({ scriptId: 's', tasks: [TASK('s1::image_gen', 's1')] });
  assert.notEqual(b1.batchId, b2.batchId);
  assert.equal((await store.listTasks(b1.batchId)).tasks.length, 1);
  assert.equal((await store.listTasks(b2.batchId)).tasks.length, 1);
  // 同批内重复 taskId 已在 validateTasks 拒绝（见 createBatch 校验测试）。
});
