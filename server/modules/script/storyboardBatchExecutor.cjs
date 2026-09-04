'use strict';
/**
 * G13 V2.0 must#4 — storyboard image_gen batch 执行胶水（batchRunner executor 契约实现）。
 *
 * 位置：本叶夹在 batchRunner（执行循环/缝）与 provider generate（注入）之间，纯胶水：
 *   任务行 (store.listTasks 归一 camelCase) -> generate 调用 -> { ok, resultRef? } | { ok:false, error }。
 * 不触 store / DB / 计划；不改 runner / dispatcher / scriptApi 语义。
 *
 * 契约：
 *   createStoryboardBatchExecutor({ generate? })
 *     -> { run(task) -> Promise<{ ok:true, resultRef } | { ok:false, error:{code,message} }> }
 *
 *   注入 generate 形如 async ({ modelId, prompt, taskId, idempotencyKey, count }) -> 下列之一：
 *     - { ok:true, mediaId } | { ok:true, url } | { ok:true, resultRef }  成功（另容忍
 *       { ok:true, media:{mediaId|url} } 包装）
 *     - { ok:false, error }        失败（error 为 {code,message} | string | Error）
 *     - throw                       同失败面（归一 code='EXECUTOR_THREW'）
 *   generate 未注入（null/undefined/非函数）⇒ run() 恒
 *     { ok:false, error:{ code:'EXECUTOR_UNCONFIGURED', message } }
 *     —— 与 batchRunner 自身缺省占位同 code：provider 波未到时任务照旧 FAILED
 *     {code:'EXECUTOR_UNCONFIGURED'}，诚实占位、绝不假造生成结果。
 *
 * 规则：
 * R1  每个任务恰好一次 generate({ modelId, prompt, taskId: <任务行 id>,
 *      idempotencyKey: 'sb-task-' + <任务行 id>, count: 1 })。
 *     任务行 id 取 task.taskId（batchRunner 从 batchTaskStore.listTasks 得到的归一
 *     camelCase 行）；兼容直接喂 snake_case 行（task.task_id）的拼写。
 * R2  modelId 解析优先级：params.modelId → params.model（storyboardBatchPlan 落
 *     model:null = 「路由层决定」，原样透传给 generate 定夺）→ null。
 *     prompt 必须为非空字符串（params.prompt），缺失 ⇒ INVALID_TASK_PARAMS，
 *     不发起 generate（无提示词不假装生成）。
 * R3  成功 resultRef：generate ok 结果的 mediaId ?? url ?? resultRef（mediaId 优先）。
 *     ok:true 但三样皆无 ⇒ { ok:false, error:{ code:'INVALID_PROVIDER_RESULT' } }
 *     —— 没有可取 artifact 就不报成功（避免空 result_ref 的 SUCCEEDED 假产出）。
 * R4  失败面（{ok:false,error} 或抛）统一归 { ok:false, error:{code,message} }，run()
 *     自身永不 reject；抛出的 Error 归 code='EXECUTOR_THREW'（与 batchRunner
 *     normalizeError 同码，runner 标记 FAILED 时码一致）。
 *
 * 幂等边界（本叶只保证「键确定」，双跑由上层 runner claim 拦）：
 *   - 同一任务行重跑 ⇒ idempotencyKey 逐字节一致（纯函数于任务 id）⇒ provider 侧可按
 *     键去重：重试/重复投递返回已记结果，不重复扣费、不重复生成。
 *   - 同任务并发双跑由 batchRunner 防：进程内 inFlight 同步预留 + store.claimTask
 *     严格 CAS（QUEUED→RUNNING 单赢者，跨进程同锁）。executor 无状态、不做本地 memo、
 *     不回读 task.status —— 越权留给 runner/store。
 */

const SB_TASK_KEY_PREFIX = 'sb-task-';
const GENERATE_COUNT = 1;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function err(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * 归一失败面 -> {code,message}。与 batchRunner.normalizeError 同语义（同码约定），
 * 本叶自持一份避免与 runner 的循环 require。
 */
function normalizeError(e) {
  if (e == null) return { code: 'EXECUTOR_INVALID_RESULT', message: '' };
  if (typeof e === 'string') return { code: 'UNKNOWN', message: e };
  if (e instanceof Error) return { code: 'EXECUTOR_THREW', message: e.message || String(e) };
  return {
    code: (e && e.code) ? e.code : 'UNKNOWN',
    message: (e && e.message) ? e.message : '',
  };
}

/** 从 generate ok:true 结果里取可作 resultRef 的 artifact（R3；取不到返回 null）。 */
function extractResultRef(result) {
  if (result == null || typeof result !== 'object') return null;
  if (isNonEmptyString(result.mediaId)) return result.mediaId;
  if (isNonEmptyString(result.url)) return result.url;
  if (isNonEmptyString(result.resultRef)) return result.resultRef;
  const media = (result.media && typeof result.media === 'object' && !Array.isArray(result.media))
    ? result.media
    : null;
  if (media) {
    if (isNonEmptyString(media.mediaId)) return media.mediaId;
    if (isNonEmptyString(media.url)) return media.url;
  }
  return null;
}

/** 幂等键：纯函数于任务行 id —— 同任务重跑必同键（见文件头「幂等边界」）。 */
function idempotencyKeyForTask(taskId) {
  return `${SB_TASK_KEY_PREFIX}${taskId}`;
}

function createStoryboardBatchExecutor(options) {
  const opts = (options == null || typeof options !== 'object' || Array.isArray(options)) ? {} : options;
  const generate = typeof opts.generate === 'function' ? opts.generate : null;

  async function run(task) {
    // R-缺省：generate 未注入 → EXECUTOR_UNCONFIGURED（runner 占位同码，占位先行于一切校验）。
    if (generate == null) {
      return err(
        'EXECUTOR_UNCONFIGURED',
        'storyboard batch executor not configured (no generate injected; provider wave pending)',
      );
    }

    const t = (task == null || typeof task !== 'object' || Array.isArray(task)) ? {} : task;
    const params = (t.params && typeof t.params === 'object' && !Array.isArray(t.params)) ? t.params : {};
    const taskId = isNonEmptyString(t.taskId)
      ? t.taskId
      : (isNonEmptyString(t.task_id) ? t.task_id : null); // snake_case 行兜底
    if (taskId == null) {
      return err('INVALID_TASK', 'task requires taskId (or task_id)');
    }
    const prompt = isNonEmptyString(params.prompt) ? params.prompt : null;
    if (prompt == null) {
      return err('INVALID_TASK_PARAMS', 'params.prompt must be a non-empty string (no prompt ⇒ no fake generation)');
    }
    // R2 — planner 落 model:null 意为「路由层决定」：原样透传 modelId 让 generate 定夺。
    const modelId = (params.modelId !== undefined && params.modelId !== null)
      ? params.modelId
      : (params.model !== undefined ? params.model : null);

    const callArgs = {
      modelId,
      prompt,
      taskId,
      idempotencyKey: idempotencyKeyForTask(taskId), // R1
      count: GENERATE_COUNT,
    };

    let out;
    try {
      out = await generate(callArgs);
    } catch (thrown) {
      // R4 — 异常透传为失败面：run() 不 reject，runner 无需 catch 也能拿 {ok:false,error}。
      const e = normalizeError(thrown instanceof Error ? thrown : { code: 'EXECUTOR_THREW', message: String(thrown) });
      return err(e.code, e.message);
    }

    if (out == null || typeof out !== 'object' || Array.isArray(out)) {
      return err('INVALID_PROVIDER_RESULT', 'generate must return a result object');
    }
    if (out.ok === true) {
      const resultRef = extractResultRef(out); // R3 — mediaId 优先，url/resultRef 兜底
      if (resultRef == null) {
        return err(
          'INVALID_PROVIDER_RESULT',
          'generate ok:true but no mediaId/url/resultRef to record as resultRef (refusing fake success)',
        );
      }
      return { ok: true, resultRef };
    }

    // 失败面：{ok:false, error:{code,message}|string|Error}（R4）
    const e = normalizeError(out.error);
    return err(e.code, e.message);
  }

  return { run };
}

module.exports = {
  createStoryboardBatchExecutor,
  idempotencyKeyForTask,
  extractResultRef,
  normalizeError,
  SB_TASK_KEY_PREFIX,
  GENERATE_COUNT,
};
