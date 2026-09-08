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
const runtimeSettings = require('./runtimeSettings.cjs');
const { sanitizeGenerationResultForList } = require('./modules/media/persistenceGuard.cjs');
const { createSingleFlight } = require('./single-flight.cjs');

const DEFAULT_WORKER_BATCH = 4;   // 每轮默认并发（可被 settings.app.uploadFinalizeConcurrency 覆盖）
const POLL_MS = 1000;              // worker 轮询间隔
const REAPER_POLL_MS = 30000;      // pending_upload reaper 间隔
const REAPER_LIMIT = 8;            // 每轮 reaper 重试上限
const REAPER_MAX_RETRIES = 3;      // 单个 media 行 reaper 重试上限，超过标 failed（避免过期 URL 无限重试刷盘）
const REAPER_WINDOW_MS = 15 * 60 * 1000; // 只重试 15 分钟内创建的 pending，超窗标 failed 收敛

let running = false;
let workerTimer = null;
let reaperTimer = null;

// mediaId -> { failures, nextRetryAt }：reaper 失败退避 + 上限（进程内；重启后自然收敛）
const reaperRetries = new Map();

// ── 表结构已由迁移 0075_asset_upload_jobs.sql 管理（G1-0 MIGRATION AUTHORITY REPAIR）──
// 运行时不再建表（RUNTIME_DDL=0）；asset_upload_jobs 的唯一权威是编号迁移链。

// 崩溃恢复：leader 重启时把上轮遗留的 processing 任务退回 queued（幂等重传，finalize 内部按 media.id 幂等）
async function recoverUploadJobs(pgPool) {
  const r = await pgPool.query(
    `UPDATE asset_upload_jobs SET state='queued', updated_at=NOW() WHERE state='processing' RETURNING id`,
  );
  if (r.rowCount > 0) console.log(`[uploadQueue] 崩溃恢复：退回 ${r.rowCount} 个 processing 任务到队列`);
}

// 入队：请求 handler 调用，不阻塞（单条 INSERT）
// P0 Base64 Kill：内联 data URI 在入队前落到 managed local，绝不把 base64 写进 asset_upload_jobs.payload。
// 落盘失败抛错 → completeViaQueue 兜底回退同步 finalize（finalizeUrl 内部再 fail-closed）。
async function enqueueFinalize(pgPool, job) {
  const ctx = {
    userId: job.ctx.userId,
    taskId: job.ctx.taskId,
    prompt: job.ctx.prompt || '',
    model: job.ctx.model || '',
    ratio: job.ctx.ratio || '1:1',
    contentType: job.ctx.contentType || 'image',
    pendingIds: Array.isArray(job.ctx.pendingIds) ? job.ctx.pendingIds : [],
  };
  const rawImages = Array.isArray(job.providerImages) ? job.providerImages : [];
  const providerImages = [];
  for (let i = 0; i < rawImages.length; i++) {
    providerImages.push(await assetFinalize.materializeInlineUrl(rawImages[i], { userId: ctx.userId, taskId: ctx.taskId, idx: i }));
  }
  const providerVideoUrl = job.providerVideoUrl
    ? await assetFinalize.materializeInlineUrl(job.providerVideoUrl, { userId: ctx.userId, taskId: ctx.taskId, idx: 0 })
    : null;
  const payload = {
    ctx,
    providerImages,
    providerVideoUrl,
    originalResult: job.originalResult || {},
  };
  await pgPool.query(
    `INSERT INTO asset_upload_jobs (task_id, user_id, state, payload)
     SELECT $1, $2, 'queued', $3
      WHERE NOT EXISTS (
        SELECT 1 FROM asset_upload_jobs
         WHERE task_id=$1 AND state IN ('queued','processing','done')
      )`,
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
// P0 Base64 Kill：写库与 SSE 前统一 sanitize，杜绝内联 data URI 进 generation_tasks.result。
async function markDone(pgPool, taskId, userId, finalResult, errorMsg) {
  const safeResult = sanitizeGenerationResultForList(finalResult);
  await pgPool.query(
    `UPDATE generation_tasks SET status=$2, result=$3, error=$4,
       completed_at = CASE WHEN $2 IN ('done','failed') THEN NOW() ELSE completed_at END,
       user_id=$5 WHERE task_id=$1`,
    [taskId, 'done', JSON.stringify(safeResult), errorMsg || '', userId || null],
  );
  realtime.emitTaskUpdate(userId, { taskId, status: 'done', result: safeResult, error: errorMsg || '' });
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
  let batch = DEFAULT_WORKER_BATCH;
  try { batch = (await runtimeSettings.getRuntimeSettings(pgPool)).uploadFinalizeConcurrency; } catch (_) { /* 默认 */ }
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, task_id, user_id, payload FROM asset_upload_jobs
       WHERE state='queued' ORDER BY created_at ASC LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batch],
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
      `UPDATE asset_upload_jobs SET state=$2, updated_at=NOW(), error=$3, payload='{}'::jsonb WHERE id=$1`,
      [row.id, ok ? 'done' : 'failed', (res.reason && res.reason.message) || ''],
    ).catch(() => {});
  }
}

// media.status='pending_upload' reaper：原 finalizeUrl 注释承诺的"reaper 后续重试"，此前未实现。
// media 行已写好 providerUrl，这里重新拉取+上传，成功则把该行（按 media.id 作 pendingId）幂等更新为 success。
// 注意：OSS禁用时assetFinalize直接写success，不再产生pending_upload；此reaper仅处理临时故障。
async function reaperTick(pgPool) {
  try {
    // 超过重试窗口仍 pending 的（provider_url 大概率已过期）→ 标 failed 停止刷盘，收敛存量。
    const expired = await pgPool.query(
      `UPDATE media SET status='failed', error_message='reaper: provider_url 超过重试窗口仍未上传成功，已停止重试'
        WHERE status='pending_upload' AND created_at <= NOW() - INTERVAL '15 minutes'
        RETURNING id`,
    ).catch(() => ({ rows: [] }));
    if (expired.rows && expired.rows.length) {
      console.log(`[uploadQueue] reaper 收敛 ${expired.rows.length} 条超窗 pending → failed`);
    }

    const r = await pgPool.query(
      `SELECT id, user_id, task_id, type, prompt, model, ratio, provider_url
       FROM media WHERE status='pending_upload' AND created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY created_at ASC LIMIT $1`,
      [REAPER_LIMIT],
    );
    if (r.rows.length === 0) return;
    // 过滤掉无provider_url的记录（直接标记失败，避免无限重试）
    const validRows = r.rows.filter(m => m.provider_url);
    const nullUrlRows = r.rows.filter(m => !m.provider_url);
    if (nullUrlRows.length > 0) {
      await pgPool.query(
        `UPDATE media SET status='failed', error_message='provider_url missing, cannot upload'
         WHERE id = ANY($1)`,
        [nullUrlRows.map(m => m.id)]
      );
      console.warn(`[uploadQueue] reaper 跳过 ${nullUrlRows.length} 条无provider_url的记录`);
    }
    await Promise.allSettled(validRows.map((m) => retryOneMedia(pgPool, m)));
  } catch (e) {
    console.warn('[uploadQueue] reaper 扫描失败:', e.message);
  }
}

async function retryOneMedia(pgPool, m) {
  const now = Date.now();
  const rec = reaperRetries.get(m.id);
  if (rec && now < rec.nextRetryAt) return; // 退避中，跳过本轮，避免同一行高频重试刷盘
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
      reaperRetries.delete(m.id);
      console.log(`[uploadQueue] reaper 补传成功 media=${m.id}`);
    } else {
      const failures = (rec ? rec.failures : 0) + 1;
      if (failures >= REAPER_MAX_RETRIES) {
        await pgPool.query(
          `UPDATE media SET status='failed', error_message='reaper: 重试多次仍未上传成功，已停止' WHERE id=$1`,
          [m.id],
        ).catch(() => {});
        reaperRetries.delete(m.id);
        console.warn(`[uploadQueue] reaper 放弃 media=${m.id}（失败 ${failures}/${REAPER_MAX_RETRIES} 次）`);
      } else {
        reaperRetries.set(m.id, { failures, nextRetryAt: now + REAPER_POLL_MS * 2 });
        console.warn(`[uploadQueue] reaper 仍失败 media=${m.id}（${failures}/${REAPER_MAX_RETRIES}）:`, (finalized && finalized.status));
      }
    }
  } catch (e) {
    const failures = (rec ? rec.failures : 0) + 1;
    if (failures >= REAPER_MAX_RETRIES) {
      await pgPool.query(
        `UPDATE media SET status='failed', error_message='reaper: 重试异常，已停止' WHERE id=$1`,
        [m.id],
      ).catch(() => {});
      reaperRetries.delete(m.id);
    } else {
      reaperRetries.set(m.id, { failures, nextRetryAt: now + REAPER_POLL_MS * 2 });
    }
    console.warn(`[uploadQueue] reaper 重试异常 media=${m.id}:`, e.message);
  }
}

function startUploadWorker(pgPool) {
  if (running) return;
  running = true;
  // setInterval 不等待 Promise；如果一次下载/OSS 搬运超过间隔，旧实现会不断叠加
  // workerTick/reaperTick，形成请求与内存风暴。single-flight 保证每类后台任务最多一轮在途。
  const runWorkerTick = createSingleFlight(() => workerTick(pgPool));
  const runReaperTick = createSingleFlight(() => reaperTick(pgPool));
  workerTimer = setInterval(() => {
    runWorkerTick().catch((e) => console.warn('[uploadQueue] worker tick 异常:', e.message));
  }, POLL_MS);
  reaperTimer = setInterval(() => {
    runReaperTick().catch((e) => console.warn('[uploadQueue] reaper tick 异常:', e.message));
  }, REAPER_POLL_MS);
  console.log(`[uploadQueue] 后台上传 worker 已启动（batch=${DEFAULT_WORKER_BATCH}, poll=${POLL_MS}ms, reaper=${REAPER_POLL_MS}ms, single-flight）`);
}

function stopUploadWorker() {
  if (workerTimer) clearInterval(workerTimer);
  if (reaperTimer) clearInterval(reaperTimer);
  workerTimer = reaperTimer = null;
  running = false;
}

module.exports = {
  recoverUploadJobs,
  enqueueFinalize,
  finalizeAndEmit,
  startUploadWorker,
  stopUploadWorker,
  _workerTick: workerTick,
  _reaperTick: reaperTick,
};
