'use strict';
/**
 * G13 V2.0 must#4 — storyboardBatchExecutor.cjs unit tests + 与真实 batchRunner 的集成缝。
 * 注入假 generate：成功（参数/幂等键透传）、失败、缺省 unconfigured、异常透传，
 * 全部经真实调用实测（无 mock 库；假 generate 只注入行为，不替换被测模块逻辑）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStoryboardBatchExecutor, SB_TASK_KEY_PREFIX, GENERATE_COUNT } = require('./storyboardBatchExecutor.cjs');
const { createBatchRunner } = require('./batchRunner.cjs');

const CAMEL_TASK = {
  batchId: 'b1',
  taskId: 's1::image_gen',
  scriptId: 'script-1',
  shotId: 's1',
  kind: 'image_gen',
  status: 'QUEUED',
  attempt: 0,
  maxAttempts: 3,
  params: { prompt: '[close-up] action, hero', model: null },
  resultRef: null,
  error: null,
};

/** 记录每次 generate 调用的 args。 */
function captureGenerate(returns) {
  const calls = [];
  const generate = async (args) => {
    calls.push(args);
    return typeof returns === 'function' ? returns(args) : returns;
  };
  return { calls, generate };
}

// ------------------------------------------------------------ 成功 + 参数透传
test('成功：generate 收到 {modelId,prompt,taskId,idempotencyKey,count}，mediaId 作 resultRef', async () => {
  const { calls, generate } = captureGenerate({ ok: true, mediaId: 'media-abc', url: 'https://cdn/x.png' });
  const exec = createStoryboardBatchExecutor({ generate });

  const r = await exec.run(CAMEL_TASK);
  assert.equal(r.ok, true);
  assert.equal(r.resultRef, 'media-abc', 'mediaId 优先于 url 作 resultRef');

  assert.equal(calls.length, 1);
  const arg = calls[0];
  assert.equal(arg.modelId, null, 'params.model=null 原样透传（路由层决定），planner 语义');
  assert.equal(arg.prompt, '[close-up] action, hero');
  assert.equal(arg.taskId, 's1::image_gen');
  assert.equal(arg.idempotencyKey, `${SB_TASK_KEY_PREFIX}s1::image_gen`);
  assert.equal(arg.count, GENERATE_COUNT);
  assert.deepEqual(Object.keys(arg).sort(), ['count', 'idempotencyKey', 'modelId', 'prompt', 'taskId']);
});

test('成功：url / resultRef 兜底；modelId 显式透传；snake_case 行兜底同键', async () => {
  // url 兜底
  const urlExec = createStoryboardBatchExecutor({ generate: async () => ({ ok: true, url: 'https://cdn/x.png' }) });
  assert.deepEqual(await urlExec.run(CAMEL_TASK), { ok: true, resultRef: 'https://cdn/x.png' });

  // resultRef 直通
  const refExec = createStoryboardBatchExecutor({ generate: async () => ({ ok: true, resultRef: 'oss://bucket/s1.png' }) });
  assert.deepEqual(await refExec.run(CAMEL_TASK), { ok: true, resultRef: 'oss://bucket/s1.png' });

  // modelId 显式（params.modelId 优先于 params.model）+ snake_case 行拼写
  const { calls, generate } = captureGenerate({ ok: true, mediaId: 'm1' });
  const snake = createStoryboardBatchExecutor({ generate });
  const snakeTask = { task_id: 's1::image_gen', params: { prompt: 'p', modelId: 'flux-pro', model: 'ignored' } };
  const r = await snake.run(snakeTask);
  assert.equal(r.ok, true);
  assert.equal(calls[0].modelId, 'flux-pro');
  assert.equal(calls[0].idempotencyKey, 'sb-task-s1::image_gen', 'snake_case 行与 camelCase 行幂等键一致');
});

test('幂等键确定性：同任务重跑 generate 收到逐字节相同 idempotencyKey', async () => {
  const { calls, generate } = captureGenerate({ ok: true, mediaId: 'm1' });
  const exec = createStoryboardBatchExecutor({ generate });

  await exec.run(CAMEL_TASK);
  await exec.run(CAMEL_TASK);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.equal(calls[1].idempotencyKey, `sb-task-${CAMEL_TASK.taskId}`);
  // 双跑由上层 runner claim（inFlight + claimTask CAS）拦，本叶不做本地 memo：
  // 两次 run 都触达 generate，仅键保持一致供 provider 去重。
});

// ------------------------------------------------------------ 失败面
test('失败：generate 返 {ok:false,error:{code,message}} → 同码透传', async () => {
  const exec = createStoryboardBatchExecutor({
    generate: async () => ({ ok: false, error: { code: 'PROVIDER_TIMEOUT', message: 'upstream dead' } }),
  });
  const r = await exec.run(CAMEL_TASK);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PROVIDER_TIMEOUT');
  assert.equal(r.error.message, 'upstream dead');
});

test('失败：error 为 string / Error / 缺省 error → 归一 {code,message}，不 reject', async () => {
  const strExec = createStoryboardBatchExecutor({ generate: async () => ({ ok: false, error: 'nope' }) });
  const r1 = await strExec.run(CAMEL_TASK);
  assert.equal(r1.ok, false);
  assert.equal(r1.error.message, 'nope');
  assert.equal(r1.error.code, 'UNKNOWN');

  const errExec = createStoryboardBatchExecutor({ generate: async () => ({ ok: false, error: new Error('bad upstream') }) });
  const r2 = await errExec.run(CAMEL_TASK);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'EXECUTOR_THREW');
  assert.equal(r2.error.message, 'bad upstream');

  const bareExec = createStoryboardBatchExecutor({ generate: async () => ({ ok: false }) });
  const r3 = await bareExec.run(CAMEL_TASK);
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, 'EXECUTOR_INVALID_RESULT', 'bare {ok:false} 无 error 字段 = invalid result（与 runner “no result” 归一同码）');
});

// ------------------------------------------------------------ 缺省 unconfigured
test('缺省 generate（null/undefined/非函数/无参）→ EXECUTOR_UNCONFIGURED，不碰生成面', async () => {
  for (const opts of [{}, { generate: null }, { generate: undefined }, { generate: 42 }, null, undefined]) {
    const exec = createStoryboardBatchExecutor(opts);
    const r = await exec.run(CAMEL_TASK);
    assert.equal(r.ok, false, `opts=${JSON.stringify(opts)} must fail closed`);
    assert.equal(r.error.code, 'EXECUTOR_UNCONFIGURED');
  }
});

// ------------------------------------------------------------ 异常透传
test('异常透传：generate throw → run() 返回 {ok:false, EXECUTOR_THREW}（不 reject、不吞）', async () => {
  const exec = createStoryboardBatchExecutor({
    generate: async () => { throw new Error('boom'); },
  });
  let r;
  await assert.doesNotReject(async () => { r = await exec.run(CAMEL_TASK); });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'EXECUTOR_THREW');
  assert.ok(r.error.message.includes('boom'));
});

// ------------------------------------------------------------ 输入校验（不假造）
test('校验：无 taskId / 无 params.prompt → INVALID_*，generate 不被调用', async () => {
  const { calls, generate } = captureGenerate({ ok: true, mediaId: 'm1' });
  const exec = createStoryboardBatchExecutor({ generate });

  const noId = await exec.run({ task_id: null, params: { prompt: 'p' } });
  assert.equal(noId.ok, false);
  assert.equal(noId.error.code, 'INVALID_TASK');

  const noPrompt = await exec.run({ taskId: 's1::image_gen', params: { modelId: 'm' } });
  assert.equal(noPrompt.ok, false);
  assert.equal(noPrompt.error.code, 'INVALID_TASK_PARAMS');

  const blankPrompt = await exec.run({ taskId: 's1::image_gen', params: { prompt: '   ' } });
  assert.equal(blankPrompt.ok, false);
  assert.equal(blankPrompt.error.code, 'INVALID_TASK_PARAMS');

  assert.equal(calls.length, 0, 'generate must not be called for invalid tasks');
});

test('fail-closed：generate ok:true 却无 mediaId/url/resultRef → INVALID_PROVIDER_RESULT（拒空 result_ref 假成功）', async () => {
  const exec = createStoryboardBatchExecutor({ generate: async () => ({ ok: true, status: 'done' }) });
  const r = await exec.run(CAMEL_TASK);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_PROVIDER_RESULT');
});

// ------------------------------------------------------------ 集成缝（真实 batchRunner）
/** 极简 fake store（单任务够用），与 batchRunner 期望的 listTasks/claimTask/markTask 同契约。 */
function createMiniFakeStore(def) {
  let row = {
    batch_id: def.batchId,
    task_id: def.taskId,
    script_id: def.scriptId || 's',
    shot_id: def.shotId || def.taskId,
    kind: def.kind || 'image_gen',
    status: 'QUEUED',
    attempt: 0,
    max_attempts: 3,
    params: def.params || { prompt: 'p', model: null },
    result_ref: null,
    error: null,
  };
  const norm = () => ({
    batchId: row.batch_id, taskId: row.task_id, scriptId: row.script_id, shotId: row.shot_id,
    kind: row.kind, status: row.status, attempt: row.attempt, maxAttempts: row.max_attempts,
    params: row.params, resultRef: row.result_ref, error: row.error,
  });
  return {
    row: () => ({ ...row }),
    async listTasks() { return { ok: true, tasks: [norm()] }; },
    async claimTask() {
      if (row.status !== 'QUEUED') return { ok: false, error: { code: row.status === 'RUNNING' ? 'ALREADY_CLAIMED' : 'TERMINAL_STATE', message: '' } };
      row.status = 'RUNNING';
      return { ok: true, task: norm() };
    },
    async markTask({ status, resultRef, error }) {
      if (['SUCCEEDED', 'FAILED', 'SKIPPED'].includes(row.status)) return { ok: false, error: { code: 'TERMINAL_STATE', message: '' } };
      row.status = status;
      if (resultRef !== undefined && resultRef !== null) row.result_ref = resultRef;
      if (error !== undefined && error !== null) row.error = error;
      return { ok: true, task: norm() };
    },
  };
}

test('集成缝：runner + 注入 generate 成功 → 行 SUCCEEDED，result_ref=mediaId，generate 收到幂等键', async () => {
  const store = createMiniFakeStore({ batchId: 'b1', taskId: 's1::image_gen', shotId: 's1', params: { prompt: '[wide] action, hero', model: null } });
  const { calls, generate } = captureGenerate({ ok: true, mediaId: 'media-abc' });
  const runner = createBatchRunner({ store, executor: createStoryboardBatchExecutor({ generate }) });

  const r = await runner.runOnce('b1');
  assert.equal(r.ok, true);
  assert.equal(r.claimed, 1);
  assert.equal(r.results[0].status, 'SUCCEEDED');
  assert.equal(store.row().status, 'SUCCEEDED');
  assert.equal(store.row().result_ref, 'media-abc');
  assert.equal(calls[0].idempotencyKey, 'sb-task-s1::image_gen');
  assert.equal(calls[0].count, 1);
});

test('集成缝：executor 缺省 generate → runner 标记 FAILED EXECUTOR_UNCONFIGURED（占位语义保持）', async () => {
  const store = createMiniFakeStore({ batchId: 'b1', taskId: 's1::image_gen' });
  const runner = createBatchRunner({ store, executor: createStoryboardBatchExecutor({ generate: null }) });

  const r = await runner.runOnce('b1');
  assert.equal(r.ok, true);
  assert.equal(r.results[0].status, 'FAILED');
  assert.equal(r.results[0].error.code, 'EXECUTOR_UNCONFIGURED');
  assert.equal(store.row().status, 'FAILED');
  assert.equal(JSON.parse(store.row().error).code, 'EXECUTOR_UNCONFIGURED');
});

test('集成缝：executor 抛出的 generate 异常 → runner FAILED EXECUTOR_THREW（不挂 runOnce）', async () => {
  const store = createMiniFakeStore({ batchId: 'b1', taskId: 's1::image_gen' });
  const runner = createBatchRunner({
    store,
    executor: createStoryboardBatchExecutor({ generate: async () => { throw new Error('provider exploded'); } }),
  });
  const r = await runner.runOnce('b1');
  assert.equal(r.ok, true);
  assert.equal(r.results[0].status, 'FAILED');
  assert.equal(r.results[0].error.code, 'EXECUTOR_THREW');
  assert.equal(store.row().status, 'FAILED');
});
