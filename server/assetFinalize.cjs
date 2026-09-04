// server/assetFinalize.cjs — 服务端资产最终化（主流异步生成范式）
//
// 设计要点（与主流方案对齐）：
//   - 由 dispatcher 任务 done 回调调用，负责把 provider 临时 URL 的字节拉回 → 直传 OSS → 写 media 表
//   - 前端不再负责 OSS 上传、不再负责 provider→OSS 转换；waitForTask 拿到 result.images[i].ossUrl 即最终 URL
//   - 失败兜底：写一条 status='pending_upload' 的占位行（保留 provider_url 供后台 reaper 续传），
//     UI 暂用 provider_url 展示，保证积分已扣必有产物
//   - 视频、图像统一走同一个 finalizeUrl()：把"流式大文件上传"做成主流 PUT 即可（不引入 SDK）
//
// 边界条件：
//   - 50 MB 上限（与 /api/oss/ingest 一致）
//   - 30s 拉取超时（AbortController）
//   - SSRF：内网/环路地址直接拒绝（与 ingest 一致）
//   - OSS PUT 自签 headers（调用方 oss.cjs 已外露 aliyunPutHeaders/tencentCosPutHeaders）
//
// 写入字段：
//   media(id, task_id, provider_url, full_url, thumbnail, oss_url, oss_object_key, oss_uploaded, status, file_size, type, ...)

const ossMod = require('./oss.cjs');
const crypto = require('crypto');
const { Transform, PassThrough, Readable } = require('stream');

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const FETCH_TIMEOUT_MS = 30000;

function genMediaId(prefix = 'mf') {
  // 主流生成算法：prefix + 时间戳 + 16 hex 随机；保证 PG id 唯一且时间序
  const rnd = require('crypto').randomBytes(8).toString('hex');
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

function isBlockedHost(host) {
  if (!host) return true;
  const h = String(host).toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]') return true;
  if (h.startsWith('10.') || h.startsWith('192.168.')) return true;
  if (h.endsWith('.internal')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

// 从 URL/Content-Type/响应头推 MIME；落统一表（image/jpeg、video/mp4 …）
function normalizeContentType(url, responseContentType, fallback = 'image/jpeg') {
  if (responseContentType) {
    const ct = String(responseContentType).split(';')[0].trim();
    if (ct) return ct;
  }
  const u = String(url || '').toLowerCase().split('?')[0];
  const ext = u.match(/\.([a-z0-9]{2,5})$/);
  if (ext) {
    const e = ext[1];
    if (['jpg', 'jpeg'].includes(e)) return 'image/jpeg';
    if (e === 'png') return 'image/png';
    if (e === 'webp') return 'image/webp';
    if (e === 'gif') return 'image/gif';
    if (e === 'mp4') return 'video/mp4';
    if (e === 'webm') return 'video/webm';
    if (e === 'mov') return 'video/quicktime';
    if (e === 'json') return 'application/json';
  }
  return fallback;
}

async function fetchBytes(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw new Error('非法 URL'); }
  // SSRF protection: only allow http/https to public IPs
  const { asyncCheckUrl } = require('./ssrf.cjs');
  const ssrf = await asyncCheckUrl(String(url));
  if (!ssrf.ok) throw new Error(`SSRF blocked: ${ssrf.reason}`);

  // 支持 data: URI（dispatcher 把 provider 返回的 b64_json 包装成 data:image/...;base64,...）
  // 不经过 HTTP fetch，直接解码 base64 为 Buffer，供后续 OSS PUT 使用。
  if (parsed.protocol === 'data:') {
    const raw = String(url);
    const comma = raw.indexOf(',');
    if (comma === -1) throw new Error('data URI 格式错误');
    const meta = raw.slice(5, comma);
    const payload = raw.slice(comma + 1);
    const isBase64 = meta.includes(';base64');
    if (!isBase64) throw new Error('data URI 仅支持 base64 编码');
    const ct = meta.split(';')[0] || 'image/png';
    const buffer = Buffer.from(payload, 'base64');
    if (buffer.length === 0) throw new Error('空文件');
    if (buffer.length > MAX_BYTES) throw new Error('超过 50MB 上限');
    return { buffer, contentType: normalizeContentType(url, ct), byteLength: buffer.length, isStream: false };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL 协议不支持');
  if (isBlockedHost(parsed.hostname)) throw new Error('URL 指向内网，已拒绝（SSRF 防护）');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(String(url), { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`拉取失败 HTTP ${r.status}`);
  const cl = r.headers.get('content-length');
  const contentLength = cl ? parseInt(cl, 10) : 0;
  if (contentLength > MAX_BYTES) throw new Error('超过 50MB 上限');
  const ct = normalizeContentType(url, r.headers.get('content-type'));
  // 流式：不下整图进 RAM，直接把 response.body（Web ReadableStream）交给上传侧边下边传。
  // 仅当服务商返回 content-length 时才走纯流式（上传需预知长度）；否则退回整图 buffer 模式保正确性。
  if (r.body && contentLength > 0) {
    return { stream: r.body, contentType: ct, contentLength, byteLength: contentLength, isStream: true };
  }
  // 兜底：chunked 无 content-length → 整图读入（旧行为）
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length === 0) throw new Error('空文件');
  if (buf.length > MAX_BYTES) throw new Error('超过 50MB 上限');
  return { buffer: buf, contentType: ct, byteLength: buf.length, isStream: false };
}

// 探测当前 activeCfg 是否可用（Provider 鉴权/桶存在），失败则跳过 OSS 仅写占位
async function pickActiveCfg(pgPool, ossLog) {
  const { enabled, activeId, list } = await ossMod.loadOssConfigs(pgPool);
  if (!enabled) return null;
  const active = list.find((c) => c.id === activeId);
  if (!active || !active.enabled) return null;
  const local = String(active.providerType || active.provider || active.type || '') === 'local-disk';
  if (!local && (!active.accessKeyId || !active.accessKeySecret || !active.bucket)) return null;
  return active;
}

// 把 objectKey 在用户命名空间下拼接（与 /api/oss/sign-upload 命名规则一致）
function buildObjectKey(cfg, userId, fileName) {
  const prefix = (cfg.pathPrefix || 'images/').replace(/^\/+|\/+$/g, '');
  const safe = String(fileName || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${prefix}/${userId}/${Date.now()}_${safe}`;
}

// 阿里云 Content-MD5 两段式：下载流先 pipe 经过 MD5 计算并缓存到 PassThrough，
// 下载完成后用算好的 md5 做签名，再把 PassThrough 作为 PUT body 发出。
// 避免「先整图 Buffer 再算 MD5」的确定性整图驻留（仍为流缓冲，但无额外 JS 堆双拷贝）。
function makeMd5Transform() {
  const hash = crypto.createHash('md5');
  return new Transform({
    transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); },
    flush(cb) { this.md5 = hash.digest('base64'); cb(); },
  });
}
async function streamToPassThroughWithMd5(webStream) {
  // FIX: 旧实现用 pipe(md5T).pipe(pt) 等待 pt finish 才 resolve，但 pt 在返回前无人消费，
  // 背压导致整个管道死锁。改为先把 WebStream 完整读入 buffer 计算 MD5，再返回新 ReadableStream。
  // 图片/视频大小受 MAX_BYTES 50MB 限制，整图驻留内存可接受，且避免了流式 MD5 的复杂竞态。
  const reader = webStream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) throw new Error('空文件');
  if (buf.length > 50 * 1024 * 1024) throw new Error('超过 50MB 上限');
  const md5 = crypto.createHash('md5').update(buf).digest('base64');
  return { md5, stream: Readable.toWeb(Readable.from([buf])) };
}

// 单张资源 OSS PUT（用 aliyunPutHeaders / tencentCosPutHeaders 直传，浏览器等价的 PUT body 直传，
// 唯一区别是：这里 header 让服务端代发，免去 CORS 烦恼）
// fetched: { buffer?, stream?, contentType, contentLength, isStream }
//   - 腾讯云：纯流式（body 直接是下载流，零整图驻留）
//   - 阿里云：两段式算 MD5 后流式发出
//   - 无 stream（data: URI / chunked 无 content-length）：退回整图 buffer 旧路径，双兼容
async function putObject(cfg, objectKey, fetched, contentType) {
  // local-disk provider（测试/离线真链后端）：写本地存储，无签名。
  if (String(cfg.providerType || cfg.provider || cfg.type || '') === 'local-disk') {
    const store = ossMod.localStoreFor(cfg);
    let body = fetched && fetched.buffer !== undefined ? fetched.buffer : null;
    if (!body && fetched && fetched.stream) {
      const chunks = [];
      for await (const c of fetched.stream) chunks.push(c);
      body = Buffer.concat(chunks);
    }
    if (!body) body = Buffer.from('');
    if (body.length === 0) throw new Error('local-disk 空 body（拉取为空）');
    const r = await store.put({ objectKey, body });
    if (!r || !r.ok) throw new Error('local-disk 写入失败');
    return store.urlFor(r.key);
  }
  const canStream = fetched.isStream && fetched.contentLength > 0 && fetched.stream;
  let putUrl, headers, body;
  if (cfg.providerType === 'tencent-cos') {
    cfg._hostName = `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`;
    putUrl = `https://${cfg._hostName}/${objectKey}`;
    if (canStream) {
      const h = ossMod.tencentCosPutHeadersStream(cfg, objectKey, { contentType, contentLength: fetched.contentLength });
      headers = h.headers; body = fetched.stream;
    } else {
      const h = ossMod.tencentCosPutHeaders(cfg, objectKey, fetched.buffer, contentType);
      headers = h.headers; body = fetched.buffer;
    }
  } else {
    const host = ossMod.aliyunHost(cfg);
    putUrl = `https://${host}/${objectKey}`;
    if (canStream) {
      const { md5, stream } = await streamToPassThroughWithMd5(fetched.stream);
      const h = ossMod.aliyunPutHeadersStream(cfg, objectKey, { md5, contentType, contentLength: fetched.contentLength });
      headers = h.headers; body = stream;
    } else {
      const h = ossMod.aliyunPutHeaders(cfg, objectKey, fetched.buffer, contentType);
      headers = h.headers; body = fetched.buffer;
    }
  }
  const fetchOpts = { method: 'PUT', body, headers };
  // undici 硬要求：body 是 ReadableStream 时必须声明 duplex:'half'，否则直接抛错
  if (canStream) fetchOpts.duplex = 'half';
  const r = await fetch(putUrl, fetchOpts);
  if (!r.ok) {
    const msg = ossMod.diagnoseOssError(cfg.providerType, r.status, await r.text().catch(() => ''));
    throw new Error(msg);
  }
  return putUrl;
}

// 重签 GET 7d URL（不直接信任 provider 临时链接）
function buildGetUrl(cfg, objectKey) {
  return ossMod.buildOssGetUrl(cfg, objectKey).getUrl;
}

/**
 * 终结化 provider 的单个资源 URL。
 *
 * @param pgPool
 * @param {{
 *   userId: string,
 *   taskId: string,
 *   idx: number,                       // 在 result.images 数组中的下标，用于对象命名稳定
 *   providerUrl: string,               // provider 临时 URL；可能是图片 data: URL（前端 processResultImages 已在前端做了 data:→blob 的情况，后端这里要 fallback 走 fetch）
 *   type?: 'image' | 'video',
 *   prompt?: string,
 *   model?: string,
 *   ratio?: string,
 *   creditCost?: number,
 *   pendingId?: string,                // 生成任务创建时给的 placeholder id；若前端有传就保留一致，避免占位/最终 asset id 不一致
 * }} opts
 * @returns {Promise<{
 *   mediaId: string,
 *   pendingId: string,
 *   ossUrl: string,                    // 服务端重签的 7d GET 预签名 URL（OSS 已落）或 provider URL（OSS 失败兜底）
 *   ossObjectKey: string,
 *   ossUploaded: boolean,
 *   status: 'success' | 'pending_upload',
 *   providerUrl: string,
 *   contentType: string,
 *   fileSize: number,
 *   type: 'image' | 'video',
 * }>}
 */
async function finalizeUrl(pgPool, opts) {
  if (!pgPool) throw new Error('数据库不可用，无法最终化资源');
  const { userId, taskId, idx, providerUrl, type = 'image', prompt = '', model = '', ratio = '1:1', creditCost, pendingId } = opts;
  if (!userId) throw new Error('userId 缺失');
  if (!providerUrl) throw new Error('providerUrl 缺失');

  const ossLog = ossMod.log;
  const tag = `task=${taskId} idx=${idx}`;
  const mediaId = pendingId || genMediaId(type === 'video' ? 'v' : 'm');

  let ossUrl = '';
  let ossObjectKey = '';
  let ossUploaded = false;
  let thumbUrl = '';
  let contentType = normalizeContentType(providerUrl, null, type === 'video' ? 'video/mp4' : 'image/jpeg');
  let fileSize = 0;
  let status = 'pending_upload';

  // ── 1. 拉字节 ──
  let fetched = null;
  try {
    fetched = await fetchBytes(providerUrl);
    contentType = fetched.contentType;
    fileSize = fetched.byteLength || (fetched.buffer ? fetched.buffer.length : 0);
  } catch (e) {
    // 拉取即失败：写 status=pending_upload（OSS 也跳过）→ 让 reaper 后续重试
    ossLog('warn', 'finalize', `[assetFinalize] ⚠️ 拉取失败 ${tag} → ${e.message}（占位先入库，reaper 后重试）`, { taskId, userId, providerUrl: String(providerUrl).slice(0, 80), error: e.message, durationMs: 0 });
    await insertMedia(pgPool, { mediaId, userId, taskId, type, prompt, model, ratio, providerUrl, ossUrl, ossObjectKey, ossUploaded, contentType, fileSize: 0, status: 'pending_upload', errorMessage: e.message });
    return { mediaId, pendingId: mediaId, ossUrl: providerUrl, ossObjectKey: '', ossUploaded: false, status: 'pending_upload', providerUrl, contentType, fileSize: 0, type };
  }

  // ── 2. OSS 直传 ──
  const cfg = await pickActiveCfg(pgPool, ossLog);
  const t0 = Date.now();
  if (cfg) {
    try {
      const safeName = `${type === 'video' ? 'video' : 'img'}-${taskId}-${idx}.${contentType.split('/')[1] || (type === 'video' ? 'mp4' : 'jpg')}`;
      ossObjectKey = buildObjectKey(cfg, userId, safeName);
      await putObject(cfg, ossObjectKey, fetched, contentType);
      ossUrl = buildGetUrl(cfg, ossObjectKey);
      thumbUrl = '';
      if (type === 'image') {
        try { thumbUrl = ossMod.buildOssThumbUrl(cfg, ossObjectKey) || ''; } catch (_) { thumbUrl = ''; }
      } else if (type === 'video') {
        // 视频即时封面帧：OSS 边缘抽帧，无需 ffmpeg
        // [FIX 2026-08-15] Request 5：与图片 buildOssThumbUrl 同一模式
        try {
          const snap = ossMod.buildOssVideoSnapshotUrl(cfg, ossObjectKey);
          if (snap && snap.signedUrl) thumbUrl = snap.signedUrl;
        } catch (_) { thumbUrl = ''; }
      }
      ossUploaded = true;
      status = 'success';
      const providerTag = cfg.providerType === 'tencent-cos' ? 'COS' : 'OSS';
      ossLog('success', 'finalize', `[assetFinalize] [${providerTag}] ✅ 直传 ${ossObjectKey} → GET 7d（${Date.now() - t0}ms）`, { taskId, userId, providerType: cfg.providerType, bucket: cfg.bucket, objectKey: ossObjectKey, byteLength: fileSize, contentType, durationMs: Date.now() - t0 });
    } catch (e) {
      ossLog('warn', 'finalize', `[assetFinalize] ⚠️ OSS PUT 失败 ${tag} → ${e.message}（仍写占位，reaper 重试）`, { taskId, userId, objectKey: ossObjectKey, providerType: cfg && cfg.providerType, error: e.message });
      // OSS 失败：仍写占位（status=pending_upload），保留 providerUrl 供展示/重试
      await insertMedia(pgPool, { mediaId, userId, taskId, type, prompt, model, ratio, providerUrl, ossUrl, ossObjectKey, ossUploaded: false, contentType, fileSize, status: 'pending_upload', errorMessage: e.message });
      return { mediaId, pendingId: mediaId, ossUrl: providerUrl, ossObjectKey: '', ossUploaded: false, status: 'pending_upload', providerUrl, contentType, fileSize, type };
    }
  } else {
    // OSS 未开：直接用 providerUrl 作为展示 URL，写 success 状态，reaper 不再重试
    // ossUploaded=false：没有真正上传到OSS，前端不应显示OSS角标
    ossLog('info', 'finalize', `[assetFinalize] OSS 未启用，使用 providerUrl 直接展示 ${tag}`, { taskId, userId, providerUrl: String(providerUrl).slice(0, 80), byteLength: fileSize });
    await insertMedia(pgPool, { mediaId, userId, taskId, type, prompt, model, ratio, providerUrl, thumbnail: '', ossUrl: providerUrl, ossObjectKey: '', ossUploaded: false, contentType, fileSize, status: 'success', errorMessage: '' });
    // G08 — 生成结果版本化（OSS 未启用：storage_key 为空）
    await recordAssetVersion(pgPool, { mediaId, taskId, model, storageKey: '', sizeBytes: fileSize });
    return { mediaId, pendingId: mediaId, ossUrl: providerUrl, thumbnail: '', ossObjectKey: '', ossUploaded: false, status: 'success', providerUrl, contentType, fileSize, type };
  }

  // ── 3. 写 media 表（成功/已有 OSS URL）──
  await insertMedia(pgPool, { mediaId, userId, taskId, type, prompt, model, ratio, providerUrl, thumbnail: thumbUrl, ossUrl, ossObjectKey, ossUploaded: true, contentType, fileSize, status: 'success', errorMessage: '' });

  // G08 — 生成结果版本化：落 media 行后补写 asset_versions（kind='generated', status='ready'）
  await recordAssetVersion(pgPool, { mediaId, taskId, model, storageKey: ossObjectKey, sizeBytes: fileSize });

  return { mediaId, pendingId: mediaId, ossUrl, thumbnail: thumbUrl, ossObjectKey, ossUploaded: true, status: 'success', providerUrl, contentType, fileSize, type };
}

// media 表 INSERT（或幂等 UPSERT）
async function insertMedia(pgPool, row) {
  const id = row.mediaId;
  const fields = `(id, task_id, type, thumbnail, full_url, prompt, model, ratio, source, is_favorite, is_deleted, oss_url, oss_object_key, oss_uploaded, status, error_message, file_size, user_id, category, provider_url)`;
  const values = `($1,$2,$3,$4,$5,$6,$7,$8,'user',FALSE,FALSE,$9,$10,$11,$12,$13,$14,$15,'generated',$16)`;
  // 用 ON CONFLICT (id) DO UPDATE 保证幂等（重入不重复插入）
  const params = [
    id, row.taskId, row.type,
    row.thumbnail || row.ossUrl || row.providerUrl,
    row.ossUrl || row.providerUrl,
    row.prompt, row.model, row.ratio,
    row.ossUrl || '', row.ossObjectKey || '', row.ossUploaded || false,
    row.status, row.errorMessage || '', row.fileSize || 0,
    row.userId,
    row.providerUrl || '', // P0 修复：持久化 provider_url，供 reaper 续传（此前字段缺失导致 pending_upload 行永久 failed）
  ];
  await pgPool.query(
    `INSERT INTO media ${fields} VALUES ${values}
     ON CONFLICT (id) DO UPDATE SET
       task_id = EXCLUDED.task_id,
       type = EXCLUDED.type,
       full_url = EXCLUDED.full_url,
       thumbnail = EXCLUDED.thumbnail,
       prompt = EXCLUDED.prompt,
       model = EXCLUDED.model,
       ratio = EXCLUDED.ratio,
       oss_url = EXCLUDED.oss_url,
       oss_object_key = EXCLUDED.oss_object_key,
       oss_uploaded = EXCLUDED.oss_uploaded,
       status = EXCLUDED.status,
       error_message = EXCLUDED.error_message,
       file_size = EXCLUDED.file_size,
       user_id = EXCLUDED.user_id,
       category = EXCLUDED.category,
       provider_url = EXCLUDED.provider_url`,
    params,
  );
}

// ─── G08 — 生成图/视频结果版本化（asset_versions 版本化写入）──────────────────
// 生成结果（AI 生成图/视频）落 media 行后补写 asset_versions 版本行：
//   - derived 类（缩略图/proxy/waveform）已由 server.js 的 storeDerived 写 kind='derived'，
//     此处只补「生成结果」分支（kind='generated'），防重复写。
//   - asset_versions.project_id 为 NOT NULL：仅当 media 已绑定 project（media.project_id 非空）时写入；
//     未绑定项目的独立生成（/api/generate）跳过，避免 NOT NULL 违反。
//   - version_id 用 rid('av') 风格（与 server.js storeDerived 一致）；ON CONFLICT DO NOTHING 幂等。
//   - 失败不阻断资产落地（积分已扣必有产物），与 storeDerived 的 best-effort 语义一致。
async function insertAssetVersion(pgPool, row) {
  await pgPool.query(
    `INSERT INTO asset_versions (version_id, media_id, project_id, kind, status, storage_key, size_bytes, generation_id, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (version_id) DO NOTHING`,
    [
      row.versionId,
      row.mediaId,
      row.projectId,
      row.kind,
      row.status,
      row.storageKey || '',
      row.sizeBytes != null ? Number(row.sizeBytes) : 0,
      row.generationId || null,
      row.model || '',
    ],
  );
}

// finalize 成功后按 media 归属项目补写 asset_versions；返回 true=已写，false=跳过（未绑定项目/失败兜底）。
async function recordAssetVersion(pgPool, { mediaId, taskId, model, storageKey, sizeBytes }) {
  try {
    const meta = await pgPool.query(`SELECT project_id FROM media WHERE id = $1`, [mediaId]).catch(() => ({ rows: [] }));
    const projectId = meta.rows && meta.rows.length ? meta.rows[0].project_id : null;
    if (!projectId) return false;
    await insertAssetVersion(pgPool, {
      // G08 幂等键修复：version_id 由 (mediaId, taskId) 确定性派生，而非每次随机 UUID。
      // 随机 UUID 会让「重入 finalizeUrl（崩溃恢复 recoverUploadJobs 把 processing 退回 queued 后重放、
      // 或 reaper 对同一 media 续传）再次生成新 version_id → ON CONFLICT(version_id) 失效 → 同 media 重复 asset_versions 行。
      // 确定性键保证：同一 media+task 重放 → 同 version_id → DO NOTHING；不同 task（重新生成）→ 新版本行。
      versionId: `av-${mediaId}-${taskId || 'gen'}`,
      mediaId,
      projectId,
      kind: 'generated',
      status: 'ready',
      storageKey: storageKey || '',
      sizeBytes: sizeBytes || 0,
      generationId: taskId || null,
      model: model || '',
    });
    return true;
  } catch (e) {
    try { ossMod.log && ossMod.log('warn', 'finalize', `[assetFinalize] asset_versions 写入失败 media=${mediaId} → ${e.message}`); } catch (_) {}
    return false;
  }
}

// 入口：批量终结化（dispatcher 任务 done 回调里调用）
// ctx: { userId, taskId, prompt, model, ratio, contentType, count, pendingIds }
// pendingIds 与前端 /api/generate 提交时的 placeholder id 一一对应：
//   服务端用 pendingId 作 media.id，让最终资产行与前端占位「id 锁定」——
//   onGenerate 在前端按 id 找占位并替换，绝不丢图。
async function finalizeTask(pgPool, ctx, providerImages, providerVideoUrl) {
  const out = { images: [], video: null, errors: [] };
  const userId = ctx.userId;
  const taskId = ctx.taskId;
  const prompt = ctx.prompt || '';
  const model = ctx.model || '';
  const ratio = ctx.ratio || '1:1';
  const pendingIds = Array.isArray(ctx.pendingIds) ? ctx.pendingIds : [];

  // 图片：并行终结化（注意：OSS PUT 是写同一 namespace 不同 objectKey，互不阻塞）
  const imgTasks = (providerImages || []).filter(Boolean);
  if (imgTasks.length) {
    const settled = await Promise.allSettled(imgTasks.map((u, i) => finalizeUrl(pgPool, {
      userId, taskId, idx: i, providerUrl: u, type: 'image', prompt, model, ratio,
      pendingId: pendingIds[i] || undefined,
    })));
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') out.images.push(r.value);
      else {
        const e = r.reason;
        out.errors.push(`image[${i}]: ${e && e.message ? e.message : String(e)}`);
        // 失败兜底：构造一个 failed 占位项（不在 DB 写，由前端展示失败卡）
        out.images.push({
          mediaId: pendingIds[i] || `mf-fail-${taskId}-${i}`,
          pendingId: pendingIds[i] || `mf-fail-${taskId}-${i}`,
          ossUrl: imgTasks[i], ossObjectKey: '', ossUploaded: false, status: 'failed',
          providerUrl: imgTasks[i], contentType: 'image/jpeg', fileSize: 0, type: 'image',
        });
      }
    });
  }

  // 视频：单条
  if (providerVideoUrl) {
    try {
      out.video = await finalizeUrl(pgPool, {
        userId, taskId, idx: 0, providerUrl: providerVideoUrl, type: 'video', prompt, model, ratio,
        pendingId: pendingIds[0] || undefined,
      });
    } catch (e) {
      out.errors.push(`video: ${e && e.message ? e.message : String(e)}`);
      out.video = {
        mediaId: pendingIds[0] || `vf-fail-${taskId}-0`,
        pendingId: pendingIds[0] || `vf-fail-${taskId}-0`,
        ossUrl: providerVideoUrl, ossObjectKey: '', ossUploaded: false, status: 'failed',
        providerUrl: providerVideoUrl, contentType: 'video/mp4', fileSize: 0, type: 'video',
      };
    }
  }
  return out;
}

module.exports = {
  finalizeUrl,
  finalizeTask,
  genMediaId,
  normalizeContentType,
  fetchBytes,
  putObject,
  buildObjectKey,
  buildGetUrl,
  pickActiveCfg,
  insertMedia,
  insertAssetVersion,
  recordAssetVersion,
};
