'use strict';
// jobs.cjs 单元测试：用内存假 pool 模拟 PG，不连真实库。
// 覆盖：建 job / 记 attempt（attempt_no 串行自增 + 首条 retryReason 为空）/ 收尾 / resume 幂等 / NULL_RECORDER 空操作。
const test = require('node:test');
const assert = require('node:assert');
const { makeJobRecorder, recordResumeJob, NULL_RECORDER, classify } = require('./jobs.cjs');

// ─── 内存假 pool：仅实现 jobs.cjs 用到的两条表语义 ───
function makeFakePool() {
  const jobs = new Map();      // job_id -> row
  const attempts = [];         // rows
  return {
    jobs, attempts,
    async query(sql, params = []) {
      if (/INSERT INTO generation_jobs/.test(sql)) {
        const [jobId, taskId, modelId, providerId, bindingId, cost] = params;
        if (jobs.has(jobId)) return { rowCount: 0 };
        jobs.set(jobId, {
          job_id: jobId, task_id: taskId, model_id: modelId, provider_id: providerId,
          binding_id: bindingId, status: 'running', cost, attempt_count: 0,
        });
        return { rowCount: 1 };
      }
      if (/INSERT INTO generation_attempts/.test(sql)) {
        const [jobId, taskId, attemptNo, modelId, bindingId, providerId,
          startedAt, finishedAt, latencyMs, status, httpStatus, providerErrorCode, cost, retryReason] = params;
        const dup = attempts.find((a) => a.job_id === jobId && a.attempt_no === attemptNo);
        if (dup) return { rowCount: 0 };
        attempts.push({
          job_id: jobId, task_id: taskId, attempt_no: attemptNo, model_id: modelId, binding_id: bindingId,
          provider_id: providerId, started_at: startedAt, finished_at: finishedAt, latency_ms: latencyMs,
          status, http_status: httpStatus, provider_error_code: providerErrorCode, cost, retry_reason: retryReason,
        });
        return { rowCount: 1 };
      }
      if (/UPDATE generation_jobs/.test(sql)) {
        const [jobId, status, attemptCount, finishedAt, providerId] = params;
        const j = jobs.get(jobId);
        if (!j) return { rowCount: 0 };
        j.status = status; j.attempt_count = attemptCount; j.finished_at = finishedAt;
        if (providerId != null) j.provider_id = providerId;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    },
  };
}

test('classify 归一化：success/timeout/failed/429/error', () => {
  assert.deepStrictEqual(classify({ status: 'success' }), { status: 'success', httpStatus: 200, code: null });
  assert.deepStrictEqual(classify({ status: 'timeout' }), { status: 'timeout', httpStatus: null, code: 'TIMEOUT' });
  assert.deepStrictEqual(classify({ status: 'failed' }), { status: 'failed', httpStatus: null, code: 'PROVIDER_FAILED' });
  assert.deepStrictEqual(classify({ status: 'error', rateLimited: true }), { status: 'rate_limited', httpStatus: 429, code: 'RATE_LIMITED' });
  assert.deepStrictEqual(classify(null), { status: 'error', httpStatus: null, code: 'PROVIDER_ERROR' });
});

test('NULL_RECORDER 所有方法安全空操作', async () => {
  await assert.doesNotReject(async () => {
    NULL_RECORDER.setRetryReason('x');
    await NULL_RECORDER.begin();
    await NULL_RECORDER.record({ status: 'success' });
    await NULL_RECORDER.finish('success');
  });
});

test('makeJobRecorder：begin→两次 record→finish 推进 attempt_no 且首条 retryReason 为空', async () => {
  const pg = makeFakePool();
  const rec = makeJobRecorder(pg, { jobId: 'gt-1__0', taskId: 'gt-1', modelId: 'm1', cost: 5 });
  await rec.begin();
  assert.strictEqual(pg.jobs.size, 1, '应建 1 个 job 行');
  assert.strictEqual(pg.jobs.get('gt-1__0').status, 'running');

  // 第一次尝试（首条，retryReason 应为 null）
  rec.setRetryReason(null);
  await rec.record({ providerId: 'pA', bindingId: 'b1', modelId: 'm1', status: 'timeout', httpStatus: null, providerErrorCode: 'TIMEOUT', cost: 2, latencyMs: 1200, startedAt: 1000, finishedAt: 2200 });
  // 第二次尝试（切换原因 = Provider A 超时）
  rec.setRetryReason('provider pA 生成端超时，切换下一账号');
  await rec.record({ providerId: 'pB', bindingId: 'b1', modelId: 'm1', status: 'rate_limited', httpStatus: 429, providerErrorCode: 'RATE_LIMITED', cost: 2, latencyMs: 300, startedAt: 2300, finishedAt: 2600 });

  assert.strictEqual(pg.attempts.length, 2);
  assert.strictEqual(pg.attempts[0].attempt_no, 1);
  assert.strictEqual(pg.attempts[0].retry_reason, null);
  assert.strictEqual(pg.attempts[1].attempt_no, 2);
  assert.strictEqual(pg.attempts[1].retry_reason, 'provider pA 生成端超时，切换下一账号');

  await rec.finish('success', 'pC');
  const j = pg.jobs.get('gt-1__0');
  assert.strictEqual(j.status, 'success');
  assert.strictEqual(j.attempt_count, 2);
  assert.strictEqual(j.provider_id, 'pC');
});

test('makeJobRecorder：job 未建成功时不写 attempt（避免外键刷屏）', async () => {
  const pg = makeFakePool();
  // 先手动占用 job_id，使 createJob 命中 ON CONFLICT DO NOTHING → broken=true
  pg.jobs.set('gt-2__0', { job_id: 'gt-2__0', task_id: 'gt-2', status: 'running' });
  const rec = makeJobRecorder(pg, { jobId: 'gt-2__0', taskId: 'gt-2', modelId: 'm1' });
  await rec.begin();
  await rec.record({ providerId: 'pA', modelId: 'm1', status: 'success' });
  await rec.finish('success');
  // 不应新增 attempt 行
  assert.strictEqual(pg.attempts.length, 0);
});

test('recordResumeJob：幂等（重复调用只留 1 条 attempt）', async () => {
  const pg = makeFakePool();
  await recordResumeJob(pg, { taskId: 'gt-3', providerId: 'pA', modelId: 'm1', bindingId: 'b1', status: 'success' });
  await recordResumeJob(pg, { taskId: 'gt-3', providerId: 'pA', modelId: 'm1', bindingId: 'b1', status: 'success' });
  assert.strictEqual(pg.jobs.size, 1);
  const jobId = 'gt-3__resume';
  assert.ok(pg.jobs.has(jobId));
  assert.strictEqual(pg.jobs.get(jobId).status, 'success');
  assert.strictEqual(pg.attempts.length, 1, 'resume 不应重复插 attempt');
  assert.strictEqual(pg.attempts[0].attempt_no, 1);
  assert.strictEqual(pg.attempts[0].retry_reason, '崩溃/重启后恢复续轮询');
});
