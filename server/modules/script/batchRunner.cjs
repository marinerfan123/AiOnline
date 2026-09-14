'use strict';
/**
 * G13 V2.0 must#4 — batch runner（batchTaskStore 之上的执行循环 / 缝）。
 *
 * 消费 batchTaskStore(0051) 落库的 image_gen 任务行，按
 *   QUEUED -> RUNNING -> SUCCEEDED / FAILED
 * 驱动一批任务。本叶是「缝」：把 store 的批任务接上 executor。provider 波尚未
 * 到达，executor 缺省时任务立即 FAILED{code:'EXECUTOR_UNCONFIGURED'}——诚实占位，
 * 绝不假造生成结果。
 *
 * 契约：
 *   createBatchRunner({ store, executor?, pollMs=1000, maxInFlight=4, onLog? })
 *     -> { start(batchId), stop(), runOnce(batchId?), state() }
 *
 *   runOnce(batchId):
 *     1. listTasks(batchId) -> 过滤 status==='QUEUED' 且未被本 runner 在途占用；
 *     2. 取前 (maxInFlight - inFlight.size) 个，先同步预留 inFlight 再 claimTask RUNNING；
 *     3. executor.run(task) -> { ok:true, resultRef? } | { ok:false, error }；
 *     4. 按结果 markTask SUCCEEDED(resultRef) / FAILED(error)；executor 抛 -> FAILED。
 *
 *   executor 契约：{ run(task) -> Promise<{ok, resultRef?}|{ok:false, error}> }。
 *
 * 单执行保证（诚实边界）：
 *   - 进程内并发 runOnce 防双跑：inFlight 集合在单线程 JS 中「同步预留」——任何
 *     await 之前先占用 (batchId,taskId) key，第二个 runOnce 过滤时即排除。
 *   - 跨进程单执行：claim 经 store.claimTask（WHERE status='QUEUED' 的严格 CAS），
 *     双 runner 并发领同一任务时只有一方成功，另一方得 ALREADY_CLAIMED 而放弃 ——
 *     消除旧 markTask(RUNNING) 允许 RUNNING→RUNNING 的跨进程双跑面。
 *   - attempt / retry 完全由 store 管（markTask.attempt、retryFailed）；runner 永不
 *     传 attempt、永不重试，只推进 QUEUED->RUNNING->终态，不越权。
 *
 * 结果形状沿用 store 约定：{ ok:true, ... } | { ok:false, error:{code,message} }。
 */

const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_IN_FLIGHT = 4;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPosInt(v) {
  return Number.isInteger(v) && v > 0;
}

function err(code, message) {
  return { ok: false, error: { code, message } };
}

/** 序列化 error 到 store 的 TEXT error 列（JSON 字符串，保留 code/message）。 */
function serializeError(e) {
  if (e == null) return JSON.stringify({ code: 'UNKNOWN', message: '' });
  if (typeof e === 'string') return JSON.stringify({ code: 'UNKNOWN', message: e });
  return JSON.stringify({
    code: (e && e.code) ? e.code : 'UNKNOWN',
    message: (e && e.message) ? e.message : '',
  });
}

/** 归一化 executor 错误 -> { code, message }（executor 抛出的 Error 也在此归一）。 */
function normalizeError(e) {
  if (e == null) return { code: 'UNKNOWN', message: '' };
  if (typeof e === 'string') return { code: 'UNKNOWN', message: e };
  if (e instanceof Error) return { code: 'EXECUTOR_THREW', message: e.message || String(e) };
  return { code: (e && e.code) ? e.code : 'UNKNOWN', message: (e && e.message) ? e.message : '' };
}

/** 缺省 executor：provider 波未到，立即失败（诚实占位，不假造结果）。 */
function defaultExecutor() {
  return {
    run: async () => err('EXECUTOR_UNCONFIGURED', 'batch executor not configured (no provider wave yet)'),
  };
}

function createBatchRunner(options) {
  const opts = options == null ? {} : options;
  const { store, executor, onLog } = opts;
  const pollMs = opts.pollMs === undefined ? DEFAULT_POLL_MS : opts.pollMs;
  const maxInFlight = opts.maxInFlight === undefined ? DEFAULT_MAX_IN_FLIGHT : opts.maxInFlight;

  if (!store || typeof store.listTasks !== 'function' || typeof store.claimTask !== 'function' || typeof store.markTask !== 'function') {
    throw new TypeError('createBatchRunner requires { store } with listTasks(), claimTask() and markTask()');
  }
  if (!isPosInt(maxInFlight)) {
    throw new TypeError('maxInFlight must be a positive integer');
  }
  if (!Number.isFinite(pollMs) || pollMs < 0) {
    throw new TypeError('pollMs must be a non-negative finite number');
  }

  let exec;
  if (executor == null) {
    exec = defaultExecutor();
  } else if (typeof executor.run !== 'function') {
    throw new TypeError('executor must provide run(task) (or be omitted)');
  } else {
    exec = executor;
  }

  const log = typeof onLog === 'function' ? onLog : () => {};

  const state = {
    stopped: false, // 初始未停：runOnce 可独立调用；stop() 置 true，start() 复位 false。
    timer: null,
    batchId: null,
  };
  const inFlight = new Set(); // 在途 (batchId \0 taskId) 集合 —— 进程内单执行锁。

  const key = (batchId, taskId) => `${batchId}\u0000${taskId}`;

  function logEvent(level, message, extra) {
    try {
      log({ level, message, ...(extra || {}) });
    } catch (_) {
      /* onLog 抛错不影响主流程 */
    }
  }

  /** 单个任务：claim(RUNNING) -> 执行 -> 终态。已在调用方同步预留 inFlight。 */
  async function executeOne(batchId, task) {
    let claimed = false;
    try {
      const claim = await store.claimTask({ batchId, taskId: task.taskId });
      if (!claim || claim.ok !== true) {
        // TASK_NOT_FOUND / ALREADY_CLAIMED（他 runner 已领）/ TERMINAL_STATE（并发跑者已终结）
        // -> 放弃，不算执行。
        const code = claim && claim.error ? claim.error.code : 'CLAIM_FAILED';
        logEvent('warn', `skip claim ${task.taskId}`, { batchId, taskId: task.taskId, code });
        return { taskId: task.taskId, claimed: false, reason: code };
      }
      claimed = true;
      logEvent('info', `claimed ${task.taskId}`, { batchId, taskId: task.taskId });

      let result;
      try {
        result = await exec.run(task);
      } catch (thrown) {
        const e = normalizeError(thrown);
        const fin = await store.markTask({
          batchId, taskId: task.taskId, status: 'FAILED', error: serializeError(e),
        });
        logEvent('error', `executor threw for ${task.taskId}`, { batchId, taskId: task.taskId, code: e.code });
        return { taskId: task.taskId, claimed: true, status: 'FAILED', error: e, finalOk: !!(fin && fin.ok) };
      }

      if (result && result.ok === true) {
        const fin = await store.markTask({
          batchId,
          taskId: task.taskId,
          status: 'SUCCEEDED',
          resultRef: result.resultRef === undefined ? null : result.resultRef,
        });
        logEvent('info', `succeeded ${task.taskId}`, { batchId, taskId: task.taskId });
        return {
          taskId: task.taskId, claimed: true, status: 'SUCCEEDED',
          resultRef: result.resultRef, finalOk: !!(fin && fin.ok),
        };
      }

      const e = result == null
        ? { code: 'EXECUTOR_INVALID_RESULT', message: 'executor returned no result' }
        : normalizeError(result.error);
      const fin = await store.markTask({
        batchId, taskId: task.taskId, status: 'FAILED', error: serializeError(e),
      });
      logEvent('warn', `failed ${task.taskId}`, { batchId, taskId: task.taskId, code: e.code });
      return { taskId: task.taskId, claimed: true, status: 'FAILED', error: e, finalOk: !!(fin && fin.ok) };
    } catch (unexpected) {
      // store/executor 意外异常兜底：已 claim 则尽力标记 FAILED，不向 runOnce 抛穿。
      const e = normalizeError(unexpected);
      logEvent('error', `unexpected in ${task.taskId}`, { batchId, taskId: task.taskId, code: e.code });
      if (claimed) {
        try {
          await store.markTask({ batchId, taskId: task.taskId, status: 'FAILED', error: serializeError(e) });
        } catch (_) { /* 终态标记尽力而为 */ }
      }
      return { taskId: task.taskId, claimed, status: 'FAILED', error: e, finalOk: false };
    }
  }

  async function runOnce(batchId) {
    const bid = (batchId === undefined || batchId === null) ? state.batchId : batchId;
    if (!isNonEmptyString(bid)) {
      return err('INVALID_BATCH_ID', 'batchId (non-empty string) required (pass as arg or via start())');
    }
    if (state.stopped) {
      return { ok: true, claimed: 0, results: [], stopped: true };
    }

    const list = await store.listTasks(bid);
    if (!list || list.ok !== true) {
      const code = (list && list.error && list.error.code) || 'LIST_FAILED';
      const message = (list && list.error && list.error.message) || 'listTasks failed';
      return err(code, message);
    }

    const tasks = Array.isArray(list.tasks) ? list.tasks : [];
    const candidates = [];
    for (const t of tasks) {
      if (state.stopped) break; // stop 后不再领
      if (t && t.status === 'QUEUED' && !inFlight.has(key(bid, t.taskId))) {
        candidates.push(t);
      }
    }

    const available = maxInFlight - inFlight.size;
    const toRun = candidates.slice(0, Math.max(0, available));

    // 同步预留（单线程原子）-> 并发 runOnce 不可能领到同一 task。
    for (const t of toRun) inFlight.add(key(bid, t.taskId));

    const executions = toRun.map((t) => executeOne(bid, t).finally(() => inFlight.delete(key(bid, t.taskId))));
    const results = await Promise.all(executions);

    return { ok: true, claimed: toRun.length, results };
  }

  function scheduleTick() {
    if (state.timer != null || state.stopped) return;
    state.timer = setTimeout(tick, pollMs);
  }

  async function tick() {
    state.timer = null;
    if (state.stopped) return;
    try {
      await runOnce(state.batchId);
    } catch (e) {
      logEvent('error', 'runOnce threw', { message: (e && e.message) ? e.message : String(e) });
    }
    if (!state.stopped) scheduleTick();
  }

  function start(batchId) {
    if (!isNonEmptyString(batchId)) {
      return err('INVALID_BATCH_ID', 'start(batchId) requires a non-empty batchId');
    }
    state.batchId = batchId;
    state.stopped = false;
    if (state.timer != null) {
      return { ok: true, alreadyRunning: true }; // 幂等：不重复起循环
    }
    scheduleTick();
    return { ok: true };
  }

  function stop() {
    state.stopped = true;
    if (state.timer != null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    return { ok: true };
  }

  function snapshot() {
    return {
      stopped: state.stopped,
      timerActive: state.timer != null,
      batchId: state.batchId,
      inFlight: inFlight.size,
      maxInFlight,
      pollMs,
    };
  }

  return { start, stop, runOnce, state: snapshot };
}

module.exports = {
  createBatchRunner,
  defaultExecutor,
  serializeError,
  normalizeError,
  DEFAULT_POLL_MS,
  DEFAULT_MAX_IN_FLIGHT,
};
