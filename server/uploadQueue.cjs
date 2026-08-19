// server/uploadQueue.cjs — 搬运与 API 解耦：终态资产上传（下载+OSS）移出请求/SSE 关键路径，
// 丢进 DB 支撑的后台队列，由 leader worker 异步处理。
//
// 设计要点（与主流异步生成范式对齐，Replicate/fal.ai 同类做法）：
//   - 请求 handler 只做轻量结算(commit credits + accounting) + 入队，立即返回，不 await OSS 上传；
//   - 后台 worker 取队列任务 → finalize(fetch→OSS→media) → 完成后才发 'done' 事件；
//   - 客户端契约不变：仍收到单个 'done' + 最终 ossUrl，只是 done 稍晚（确保资产真上传完）。
//   - DB 支撑（asset_upload_jobs 表）+ FOR UPDATE SKIP LOCKED：崩溃安全、多 worker 不重复处理。
//   - 搬运并发上限 WORKER_BATCH（默认 4）：独立于生成并发，显式限制事件循环负载——这才是解耦的核心收益。
//   - 孤儿/失败兜底：media.status='pending_upload' 行由 reaper 周期重试，补全 finalizeUrl 注释里承诺的"reaper 后续重试"（此前未实现）。
//
// 仅在 IS_LEADER（leader worker）启动，避免多 worker 重复扫库/重复续传。

const realtime = require('./realtime.cjs');
const assetFinalize = require('./assetFinalize.cjs');

const WORKER_BATCH = 4;            // 每轮最多并发处理的任务数（限制事件循环负载）
const POLL_MS = 1000;              // worker 轮询间隔
const REAPER_POLL_MS = 30000;      // pending_upload reaper 间隔
const REAPER_LIMIT = 8;            // 每轮 reaper 重试上限

let running = false;
let workerTimer = null;
let reaperTimer = null;

// ── 表结构（幂等，启动期执行一次）──
async function ensureUploadJobsTable(pgPool) {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS asset_upload_jobs (
      id BIGSERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_id TEXT,
      state TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | done | failed
      payload JSONB NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_asset_upload_jobs_state ON asset_upload_jobs(state, created_at);');
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_asset_upload_jobs_task ON asset_upload_jobs(task_id);');
}

// 崩溃恢复：leader 重启时把上轮遗留的 processing 任务退回 queued（幂等重传，finalize 内部按 media.id 幂等）
async function recoverUploadJobs(pgPool) {
  const r = await pgPool.query(
    `UPDATE asset_upload_jobs SET state='queued', updated_at=NOW() WHERE state='processing' RETURNING id`,
  );
  if (r.rowCount > 0) console.log(`[uploadQueue] 崩溃恢复：退回 ${r.rowCount} 个 processing 任务到队列`);
}

// 入队：请求 handler 调用，不阻塞（单条 INSERT）
async function enqueueFinalize(pgPool, job) {
  const payload = {
    ctx: {
      userId: job.ctx.userId,
      taskId: job.ctx.taskId,
      prompt: job.ctx.prompt || '',
      model: job.ctx.model || '',
      ratio: job.ctx.ratio || '1:1',
      contentType: job.ctx.contentType || 'image',
      pendingIds: Array.isArray(job.ctx.pendingIds) ? job.ctx.pendingIds : [],
    },
    providerImages: Array.isArray(job.providerImages) ? job.providerImages : [],
    providerVideoUrl: job.providerVideoUrl || null,
    originalResult: job.originalResult || {},
  };
  await pgPool.query(
    `INSERT INTO asset_upload_jobs (task_id, user_id, state, payload)
     VALUES ($1, $2, 'queued', $3)`,
    [job.ctx.taskId, job.ctx.userId || null, JSON.stringify(payload)],
  );
}

// 构建前端 'done' 用的 finalResult（与 dispatcher.generateAsync.then 原有逻辑一致）
function buildFinalResult(finalized, originalResult) {
  const finalImages = (finalized.images || []).map((it) => ({
    mediaId: it.mediaId,
    ossUrl: it.ossUrl,
    thumbnail: it.thumbnail || it.ossUrl,
    ossObjectKey: it.ossObjectKey || '',
    ossUploaded: !!it.ossUploaded,
    status: it.status,
    contentType: it.contentType || 'image/jpeg',
    fileSize: it.fileSize || 0,
  }));
  const finalVideo = finalized.video
    ? {
        mediaId: finalized.video.mediaId,
        ossUrl: finalized.video.ossUrl,
        ossObjectKey: finalized.video.ossObjectKey || '',
        ossUploaded: !!finalized.video.ossUploaded,
        status: finalized.video.status,
        contentType: finalized.video.contentType || 'video/mp4',
        fileSize: finalized.video.fileSize || 0,
      }
    : null;
  const fr = Object.assign({}, originalResult, {
    images: finalImages,
    videoUrl: finalVideo ? finalVideo.ossUrl : (originalResult && originalResult.videoUrl) || '',
    videoMedia: finalVideo,
    finalizeErrors: finalized.errors || [],
  });
  return fr;
}

// 兜底 finalResult：worker 完全失败（finalizeTask 抛异常）时，用 provider URL 拼 pending_upload 结果，
// 保证客户端不卡在 running、资产有兜底展示（与 finalizeUrl 失败兜底语义一致）。
function fallbackFinalResult(job, errMsg) {
  const images = (job.images || []).map((u, i) => ({
    mediaId: (job.pendingIds && job.pendingIds[i]) || `mf-fail-${job.taskId}-${i}`,
    ossUrl: u, ossObjectKey: '', ossUploaded: false, status: 'pending_upload',
    providerUrl: u, contentType: 'image/jpeg', fileSize: 0, type: 'image',
  }));
  const video = job.videoUrl ? {
    mediaId: (job.pendingIds && job.pendingIds[0]) || `vf-fail-${job.taskId}-0`,
    ossUrl: job.videoUrl, ossObjectKey: '', ossUploaded: false, status: 'pending_upload',
    providerUrl: job.videoUrl, contentType: 'video/mp4', fileSize: 0, type: 'video',
  } : null;
  return { images, videoUrl: job.videoUrl || '', videoMedia: video, finalizeErrors: [errMsg || 'finalize failed'] };
}

// 写 generation_tasks=done + 发 SSE 'done'（与 updateTaskStatus 的 CASE 语义一致）
async function markDone(pgPool, taskId, userId, finalResult, errorMsg) {
  await pgPool.query(
    `UPDATE generation_tasks SET status=$2, result=$3, error=$4,
       completed_at = CASE WHEN $2 IN ('done','failed') THEN NOW() ELSE completed_at END,
       user_id=$5 WHERE task_id=$1`,
    [taskId, 'done', JSON.stringify(finalResult), errorMsg || '', userId || null],
  );
  realtime.emitTaskUpdate(userId, { taskId, status: 'done', result: finalResult, error: errorMsg || '' });
}

// 执行 finalize 并发出 done（worker 正常路径 & 入队失败兜底共用，确保单一真相）
async function finalizeAndEmit(pgPool, { userId, taskId, ctx, providerImages, providerVideoUrl, originalResult }) {
  const finalized = await assetFinalize.finalizeTask(pgPool, ctx, providerImages, providerVideoUrl);
  const finalResult = buildFinalResult(finalized, originalResult);
  await markDone(pgPool, taskId, userId, finalResult, (originalResult && originalResult.error) || '');
  return finalized;
}

async function processOne(pgPool, jobRow) {
  const { task_id: taskId, user_id: userId, payload } = jobRow;
  const { ctx, providerImages, providerVideoUrl, originalResult } = payload;
  ctx.userId = userId; ctx.taskId = taskId;
  try {
    await finalizeAndEmit(pgPool, { userId, taskId, ctx, providerImages, providerVideoUrl, originalResult });
    return { ok: true, taskId };
  } catch (e) {
    console.warn('[uploadQueue] finalizeAndEmit 抛异常(已兜底 done):', e.message);
    const fb = fallbackFinalResult({ images: providerImages, videoUrl: providerVideoUrl, pendingIds: ctx.pendingIds, taskId, userId });
    await markDone(pgPool, taskId, userId, fb, e.message).catch(() => {});
    return { ok: false, taskId };
  }
}

// 单轮 worker：专用连接跑事务取锁，处理后释放连接再异步 finalize（锁不跨 finalize 持有）
async function workerTick(pgPool) {
  const client = await pgPool.connect();
  let rows = [];
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, task_id, user_id, payload FROM asset_upload_jobs
       WHERE state='queued' ORDER BY created_at ASC LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [WORKER_BATCH],
    );
    rows = r.rows;
    if (rows.length === 0) { await client.query('COMMIT'); client.release(); return; }
    await client.query(
      `UPDATE asset_upload_jobs SET state='processing', attempts=attempts+1, updated_at=NOW() WHERE id = ANY($1)`,
      [rows.map((x) => x.id)],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return;
  }
  client.release();

  // 并发处理本批（上限 WORKER_BATCH），受 cgroup/maxThreads 约束，不淹没事件循环
  const results = await Promise.allSettled(rows.map((row) => processOne(pgPool, row)));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const res = results[i];
    const ok = res.status === 'fulfilled' && res.value && res.value.ok;
    await pgPool.query(
      `UPDATE asset_upload_jobs SET state=$2, updated_at=NOW(), error=$3 WHERE id=$1`,
      [row.id, ok ? 'done' : 'failed', (res.reason && res.reason.message) || ''],
    ).catch(() => {});
  }
}

// media.status='pending_upload' reaper：原 finalizeUrl 注释承诺的"reaper 后续重试"，此前未实现。
// media 行已写好 providerUrl，这里重新拉取+上传，成功则把该行（按 media.id 作 pendingId）幂等更新为 success。
async function reaperTick(pgPool) {
  try {
    const r = await pgPool.query(
      `SELECT id, user_id, task_id, type, prompt, model, ratio, provider_url
       FROM media WHERE status='pending_upload' AND created_at > NOW() - INTERVAL '2 hours'
       ORDER BY created_at ASC LIMIT $1`,
      [REAPER_LIMIT],
    );
    if (r.rows.length === 0) return;
    await Promise.allSettled(r.rows.map((m) => retryOneMedia(pgPool, m)));
  } catch (e) {
    console.warn('[uploadQueue] reaper 扫描失败:', e.message);
  }
}

async function retryOneMedia(pgPool, m) {
  try {
    const finalized = await assetFinalize.finalizeUrl(pgPool, {
      userId: m.user_id,
      taskId: m.task_id || 'reaper',
      idx: 0,
      providerUrl: m.provider_url,
      type: m.type || 'image',
      prompt: m.prompt || '',
      model: m.model || '',
      ratio: m.ratio || '1:1',
      pendingId: m.id, // 用 media.id 作 pendingId → insertMedia ON CONFLICT(id) 幂等更新
    });
    if (finalized && finalized.status === 'success') {
      console.log(`[uploadQueue] reaper 补传成功 media=${m.id}`);
    } else {
      console.warn(`[uploadQueue] reaper 仍失败 media=${m.id}:`, (finalized && finalized.status));
    }
  } catch (e) {
    console.warn(`[uploadQueue] reaper 重试异常 media=${m.id}:`, e.message);
  }
}

function startUploadWorker(pgPool) {
  if (running) return;
  running = true;
  workerTimer = setInterval(() => {
    workerTick(pgPool).catch((e) => console.warn('[uploadQueue] worker tick 异常:', e.message));
  }, POLL_MS);
  reaperTimer = setInterval(() => reaperTick(pgPool), REAPER_POLL_MS);
  console.log(`[uploadQueue] 后台上传 worker 已启动（batch=${WORKER_BATCH}, poll=${POLL_MS}ms, reaper=${REAPER_POLL_MS}ms）`);
}

function stopUploadWorker() {
  if (workerTimer) clearInterval(workerTimer);
  if (reaperTimer) clearInterval(reaperTimer);
  workerTimer = reaperTimer = null;
  running = false;
}

module.exports = {
  ensureUploadJobsTable,
  recoverUploadJobs,
  enqueueFinalize,
  finalizeAndEmit,
  startUploadWorker,
  stopUploadWorker,
  _workerTick: workerTick,
  _reaperTick: reaperTick,
};
