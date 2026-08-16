'use strict';
/**
 * 智能路由尝试数据落地模块（ModelHub V3 · generation_jobs / generation_attempts）
 *
 * 数据模型（与现有 generation_tasks 共存，task_id 外键 1:1 关联，绝不删旧表）：
 *   generation_jobs      一次「分发单元」= 一个子任务（每张图 / 每段视频）的整轮智能路由
 *   generation_attempts  该单元内的每一次「向某 provider 实际发起的生成尝试」（含 timeout / 429 / 失败）
 *
 * 记录语义（对齐用户示例）：
 *   job_1001__0
 *   ├─ attempt_1 → Provider A → timeout
 *   ├─ attempt_2 → Provider B → 429
 *   └─ attempt_3 → Provider C → success
 *
 * 约定：
 *   - 所有写入均为 best-effort：内部吞错，绝不阻断生成主链路。
 *   - job_id = `${task_id}__${subIndex}`，attempt_no 由 recorder 在单 job 内串行自增
 *     （dispatchOne 串行尝试各账号，无并发竞态）。
 *   - task_id 在 attempts 表冗余存储，便于免 join 直查。
 *   - (job_id, attempt_no) 唯一 + ON CONFLICT DO NOTHING，使 resume 重放幂等。
 */

// 无 taskId / 无 pgPool 时的空操作 recorder（sync 测试路径 / 异常降级）
const NULL_RECORDER = {
  setRetryReason() {},
  begin() { return Promise.resolve(); },
  record() { return Promise.resolve(); },
  finish() { return Promise.resolve(); },
};

/** 归一化一次 attempt 的结果 → 入库状态 / HTTP 状态 / 错误码 */
function classify(res) {
  if (!res) return { status: 'error', httpStatus: null, code: 'PROVIDER_ERROR' };
  if (res.status === 'success') return { status: 'success', httpStatus: 200, code: null };
  if (res.status === 'timeout') return { status: 'timeout', httpStatus: null, code: 'TIMEOUT' };
  if (res.status === 'failed') return { status: 'failed', httpStatus: null, code: 'PROVIDER_FAILED' };
  if (res.rateLimited) return { status: 'rate_limited', httpStatus: 429, code: 'RATE_LIMITED' };
  return { status: 'error', httpStatus: null, code: 'PROVIDER_ERROR' };
}

async function createJob(pg, { jobId, taskId, modelId, providerId, bindingId, cost }) {
  // generation_jobs.cost 为 integer 列：billing 计算出的 cost 可能是 "0.0000" 这类字符串，
  // 直接入库会触发 "invalid input syntax for type integer" 并导致整条审计记录丢失（best-effort 下被静默吞掉）。
  // 统一规整为 integer，与 recordAttempt 的写法对齐。
  const costInt = Math.trunc(Number(cost)) || 0;
  return pg.query(
    `INSERT INTO generation_jobs (job_id, task_id, model_id, provider_id, binding_id, status, cost, attempt_count, created_at)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, 0, NOW())
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, taskId, modelId || '', providerId || null, bindingId || '', costInt],
  );
}

async function recordAttempt(pg, {
  jobId, taskId, attemptNo, modelId, bindingId, providerId,
  status, httpStatus, providerErrorCode, cost, latencyMs, startedAt, finishedAt, retryReason,
}) {
  return pg.query(
    `INSERT INTO generation_attempts
       (job_id, task_id, attempt_no, model_id, binding_id, provider_id,
        started_at, finished_at, latency_ms, status, http_status, provider_error_code, cost, retry_reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10,$11,$12,$13,$14, NOW())
     ON CONFLICT (job_id, attempt_no) DO NOTHING`,
    [
      jobId, taskId, attemptNo, modelId || '', bindingId || '', providerId || '',
      startedAt ? new Date(startedAt) : null, finishedAt ? new Date(finishedAt) : null,
      typeof latencyMs === 'number' ? latencyMs : null,
      status, typeof httpStatus === 'number' ? httpStatus : null,
      providerErrorCode || null, typeof cost === 'number' ? cost : 0,
      retryReason || null,
    ],
  );
}

async function finalizeJob(pg, { jobId, status, providerId, attemptCount, finishedAt }) {
  return pg.query(
    `UPDATE generation_jobs
        SET status = $2, attempt_count = $3, finished_at = $4, provider_id = COALESCE($5, provider_id)
      WHERE job_id = $1`,
    [jobId, status, attemptCount || 0, finishedAt ? new Date(finishedAt) : new Date(), providerId || null],
  );
}

/**
 * 为每个分发子任务创建一个 recorder。
 * 用法：begin() 建 job 行 → dispatchOne 内每次实际尝试调用 record() → finish() 收尾。
 * 任何一步失败均内部吞错，绝不影响生成主链路。
 */
function makeJobRecorder(pg, opts) {
  if (!pg || !opts || !opts.jobId || !opts.taskId) return NULL_RECORDER;
  let attemptNo = 0;
  let retryReason = null;     // 下一次尝试的「为什么重试」说明
  let broken = false;         // job 行没建成功 → 后续写 attempt 会外键失败，直接跳过
  return {
    setRetryReason(r) { retryReason = r || null; },
    async begin() {
      try {
        const r = await createJob(pg, opts);
        // INSERT ... ON CONFLICT DO NOTHING 命中冲突 / 未插成功 → rowCount 0，视为 job 未建，后续跳过 attempt 避免外键失败刷屏
        if (!r || !r.rowCount) broken = true;
      } catch (e) { broken = true; console.warn('[jobs] createJob 失败:', e.message); }
    },
    async record(a) {
      if (broken) return;
      attemptNo += 1;          // 仅「真正向 provider 发起尝试」的节点才 +1，skip（忙/冷/桶空）不计数
      try {
        await recordAttempt(pg, {
          jobId: opts.jobId, taskId: opts.taskId, attemptNo,
          modelId: a.modelId, bindingId: a.bindingId, providerId: a.providerId,
          status: a.status, httpStatus: a.httpStatus, providerErrorCode: a.providerErrorCode,
          cost: a.cost, latencyMs: a.latencyMs, startedAt: a.startedAt, finishedAt: a.finishedAt,
          retryReason: attemptNo === 1 ? null : retryReason,
        });
      } catch (e) { console.warn('[jobs] recordAttempt 失败:', e.message); }
    },
    async finish(status, providerId) {
      if (broken) return;
      try {
        await finalizeJob(pg, {
          jobId: opts.jobId, status, providerId: providerId || null,
          attemptCount: attemptNo, finishedAt: Date.now(),
        });
      } catch (e) { console.warn('[jobs] finalizeJob 失败:', e.message); }
    },
  };
}

/**
 * 崩溃/重启恢复续轮询时，补记一条 resume 任务（job + 单次 attempt），best-effort 幂等。
 */
async function recordResumeJob(pg, { taskId, providerId, modelId, bindingId, status }) {
  const jobId = `${taskId}__resume`;
  try {
    await createJob(pg, { jobId, taskId, modelId, providerId, bindingId, cost: 0 });
    const m = classify({ status });
    await recordAttempt(pg, {
      jobId, taskId, attemptNo: 1, modelId, bindingId, providerId,
      status: m.status, httpStatus: m.httpStatus, providerErrorCode: m.code,
      cost: 0, retryReason: '崩溃/重启后恢复续轮询',
    });
    await finalizeJob(pg, { jobId, status: m.status, providerId, attemptCount: 1 });
  } catch (e) { console.warn('[jobs] recordResumeJob 失败:', e.message); }
}

module.exports = {
  NULL_RECORDER,
  classify,
  createJob,
  recordAttempt,
  finalizeJob,
  makeJobRecorder,
  recordResumeJob,
};
