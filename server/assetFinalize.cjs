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
// L29 — Media Metadata 扩展：checksum 完整性 + 元数据捕获（纯函数，落点见 outputMeta.cjs 头部裁决）。
const {
  computeSha256,
  computeMd5Hex,
  computeMd5Base64,
  verifyChecksum,
  normalizeOutputMetadata,
  probeBufferWithFfprobe,
} = require('./modules/media/outputMeta.cjs');

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

// Web ReadableStream → Buffer（L29 checksum/元数据捕获需要整字节；MAX_BYTES 上限内驻留可接受，
// 与既有 streamToPassThroughWithMd5 的「整 buffer 算 MD5」同款折衷）。
async function webStreamToBuffer(webStream) {
  const reader = webStream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
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
  const { userId, taskId, idx, providerUrl, type = 'image', prompt = '', model = '', ratio = '1:1', creditCost, pendingId, captureChecksum, expectedChecksum, probe } = opts;
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
  // L29 — checksum/元数据捕获结果（仅 captureChecksum/expectedChecksum 时计算；legacy finalizeTask 不请求 → null，向后兼容）。
  let sha256 = null;
  let md5Hex = null;
  let md5Base64 = null;
  let metaRaw = null;

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

  // ── 1.5 L29 校验和 + 元数据捕获（§82 Media Metadata / §79 VERIFY 闸）──
  // 仅当 captureChecksum 或 expectedChecksum 请求时计算（output manifest 路径恒请求；legacy 路径不请求）。
  const wantChecksum = !!(captureChecksum || expectedChecksum);
  if (wantChecksum) {
    try {
      // 流式拉取先整读成 buffer（sha256/md5 需要整字节；50MB 上限内驻留可接受）
      if (fetched.stream) {
        const buf = await webStreamToBuffer(fetched.stream);
        fetched = { buffer: buf, contentType: fetched.contentType, byteLength: buf.length, isStream: false };
      }
      const buf = fetched.buffer;
      sha256 = computeSha256(buf);
      md5Hex = computeMd5Hex(buf);
      md5Base64 = computeMd5Base64(buf);
      // 有 provider checksum 则核验（§79 VERIFY 闸）；算法不可识别（opaque etag）→ 宽容跳过，不判失败。
      if (expectedChecksum) {
        const v = verifyChecksum(buf, expectedChecksum);
        if (v.verifiable && !v.matched) {
          throw new Error(`checksum 校验失败（期望 ${expectedChecksum}，实际 sha256=${sha256}）`);
        }
      }
    } catch (e) {
      // checksum 校验失败：不落 success，写占位（reaper 重试重新拉取 + 重新校验），§79 Job 未成功。
      ossLog('warn', 'finalize', `[assetFinalize] ⚠️ checksum 校验失败 ${tag} → ${e.message}（占位入库，reaper 重试）`, { taskId, userId, error: e.message });
      await insertMedia(pgPool, { mediaId, userId, taskId, type, prompt, model, ratio, providerUrl, ossUrl, ossObjectKey, ossUploaded: false, contentType, fileSize, status: 'pending_upload', errorMessage: e.message });
      return { mediaId, pendingId: mediaId, ossUrl: providerUrl, ossObjectKey: '', ossUploaded: false, status: 'pending_upload', providerUrl, contentType, fileSize, type, sha256: null };
    }
    // 元数据探针（best-effort，宽容：probe 缺失/失败 → metaRaw=null，不炸）
    try {
      const prober = probe || probeBufferWithFfprobe;
      metaRaw = await prober(fetched.buffer);
    } catch (_e) {
      metaRaw = null;
    }
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
    return { mediaId, pendingId: mediaId, ossUrl: providerUrl, thumbnail: '', ossObjectKey: '', ossUploaded: false, status: 'success', providerUrl, contentType, fileSize, type, sha256, md5Hex, md5Base64, meta: metaRaw };
  }

  // ── 3. 写 media 表（成功/已有 OSS URL）──
  await insertMedia(pgPool, { mediaId, userId, taskId, type, prompt, model, ratio, providerUrl, thumbnail: thumbUrl, ossUrl, ossObjectKey, ossUploaded: true, contentType, fileSize, status: 'success', errorMessage: '' });

  // G08 — 生成结果版本化：落 media 行后补写 asset_versions（kind='generated', status='ready'）
  await recordAssetVersion(pgPool, { mediaId, taskId, model, storageKey: ossObjectKey, sizeBytes: fileSize });

  return { mediaId, pendingId: mediaId, ossUrl, thumbnail: thumbUrl, ossObjectKey, ossUploaded: true, status: 'success', providerUrl, contentType, fileSize, type, sha256, md5Hex, md5Base64, meta: metaRaw };
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

// ─── L27 — OutputManifest：provider 原样快照 + 归一 artifacts → 逐件拉取落库（§78-80）──────────
// 墨渊 V2.0 L27（0065 迁移段）。语义：
//   §78 Provider 返回 OutputManifest `{artifacts:[{role, media_type, source}], provider_metadata}`，
//       不再返回单一 video_url。此处把 provider manifest 原样快照落 generation_output_manifests，
//       并把 artifacts 归一为 [{url, kind, mimeType, sizeBytes, checksum?}] 再逐件拉取落 media。
//   §79 Provider Success ≠ Job Success：快照行的存在 = provider 已成功产出 manifest（仅入快照）；
//       只有当所有 artifacts 拉取落库 + media_ids 齐（无 NULL）时，Job 才成功（finalized_at 置值）。
//   §80 Finalize 独立重试：快照先于任何拉取；拉取部分失败时快照保留已落 media_ids，
//       重试从快照重放（不重新生成、不重新归一），只补拉未落库的 artifact。

// 归一：provider artifact → { url, kind, mimeType, sizeBytes, checksum }。
// 宽容映射（不同 provider 字段名不一）：source|url → url；role|kind → kind；media_type|mimeType|contentType → mimeType。
function normalizeOutputArtifact(a) {
  if (!a || typeof a !== 'object') return null;
  const url = a.source || a.url || a.oss_url || a.media_url || a.href || null;
  const kind = a.role || a.kind || a.type || 'artifact';
  const mimeType = a.media_type || a.mimeType || a.mime_type || a.contentType || a.content_type || null;
  const sizeBytes = a.size_bytes != null ? Number(a.size_bytes)
    : (a.sizeBytes != null ? Number(a.sizeBytes)
      : (a.byte_length != null ? Number(a.byte_length) : (a.size != null ? Number(a.size) : null)));
  const checksum = a.checksum || a.sha256 || a.md5 || a.etag || null;
  if (!url) return null; // 无来源地址的 artifact 无法拉取，跳过（保留在 provider_manifest 原样里）
  const norm = { url, kind: String(kind), mimeType: mimeType ? String(mimeType) : null, sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null };
  if (checksum) norm.checksum = String(checksum);
  // L29 — 重放时保留已捕获的 metadata（JSONB 宽容；快照重放不得丢元数据）
  if (a.metadata && typeof a.metadata === 'object' && Object.keys(a.metadata).length) {
    norm.metadata = a.metadata;
  }
  return norm;
}

// 从 provider OutputManifest 归一 artifacts 列表；返回数组（含 null 表示无法归一，调用方忽略）。
function normalizeOutputArtifacts(providerManifest) {
  if (!providerManifest || typeof providerManifest !== 'object') return [];
  const raw = Array.isArray(providerManifest.artifacts) ? providerManifest.artifacts : [];
  return raw.map(normalizeOutputArtifact);
}

// artifact kind/mimeType → media.type（media.type 为开放 TEXT；video/* → video，其余按 image 落库，
// audio/metadata 等特殊 kind 由 manifest 的 kind 字段承载，L29 Media Metadata 再细分）。
function deriveArtifactMediaType(kind, mimeType) {
  if (/video/i.test(String(kind || ''))) return 'video';
  if (mimeType && /^video\//i.test(String(mimeType))) return 'video';
  return 'image';
}

// ─── L28 — Finalize 独立重试（§80 续：经 snapshot retry_count 域，独立于 Job 总重试）──────────
// 语义：
//   1) 断点续拉：finalize 失败重试仅从快照重放，已落 media_ids 保留、绝不重复拉取（snapshotOutputManifest 已提供）。
//   2) 独立重试计数/退避：retry_count 只计 FINALIZE 重试（与 generation_items_v2.attempt_count 的 Job 级重试无关）；
//      达 maxRetries 上限 → job 域终态 failed（reasonCode=FINALIZE_EXHAUSTED，由接线层落 generation_items_v2），
//      snapshot 保留（media_ids 不删、finalized_at 仍 NULL）供人工重放。
//   3) 幂等（并发单拉取）：确定性 media id + 原子认领（ON CONFLICT DO NOTHING/DO UPDATE）→ 并发双 finalize 同 attempt
//      只拉取一次；loser 读回/跳过，绝不双拉/双写。
//   4) 终态后人工重放：FINALIZE_EXHAUSTED 后，人工重放（提高 maxRetries 或换新 attempt）仍可从快照续拉。
const FINALIZE_DEFAULT_MAX_RETRIES = 3;
const FINALIZE_RETRY_BASE_DELAY_MS = 1000;
const FINALIZE_RETRY_MAX_DELAY_MS = 30000;
const FINALIZE_EXHAUSTED_CODE = 'FINALIZE_EXHAUSTED';

// 确定性 media id：并发双 finalize 同 (jobId, idx) → 同 id → ON CONFLICT 幂等锚点。
// pendingId 优先（前端 id 锁定，绝不随机）；否则由 (jobId, idx) 确定性派生。
function deterministicMediaId(jobId, idx, pendingId) {
  if (pendingId) return pendingId;
  return `mf-${String(jobId)}-${idx}`;
}

// FINALIZE 退避（独立于 Job 总重试）：只由 snapshot retry_count 决定，指数退避、封顶。
function computeFinalizeBackoffMs(retryCount, baseMs, maxMs) {
  const n = Math.max(0, Number(retryCount) || 0);
  const exp = Math.min(n, 30); // 防 Math.pow 溢出
  return Math.min((Number(baseMs) || 1000) * Math.pow(2, exp), Number(maxMs) || 30000);
}

// 原子认领 media 槽位（并发单拉取核心；仅 atomicClaim 路径调用）：
//   - 无该 id 行 → INSERT 'finalizing' → 认领成功（winner，真正拉字节）。
//   - 已有 'pending_upload'/'failed'/'canceled'（前次 finalize 失败占位）→ 翻转为 'finalizing' → 认领成功（重试续传）。
//   - 已有 'finalizing'（他 worker 正在拉）或 'success'（已落库）→ 不动 → 认领失败（loser，跳过拉取 = 单拉取）。
// 返回 { claimed: bool, mediaId }。ON CONFLICT 语义保证原子（并发下仅一方 claimed）。
async function claimMediaSlot(pgPool, { mediaId, userId, taskId, type, providerUrl }) {
  const r = await pgPool.query(
    `INSERT INTO media (id, task_id, type, provider_url, user_id, category, source, status)
     VALUES ($1,$2,$3,$4,$5,'generated','user','finalizing')
     ON CONFLICT (id) DO UPDATE
       SET status = 'finalizing'
       WHERE media.status IN ('pending_upload','failed','canceled')
     RETURNING id`,
    [mediaId, taskId, type, providerUrl, userId],
  );
  return { claimed: !!(r.rows && r.rows.length), mediaId };
}

// 读回 media 槽位状态（loser 判断是「已落库」还是「他 worker 拉取中」）。
async function readMediaSlot(pgPool, mediaId) {
  const r = await pgPool.query(
    `SELECT id, status, oss_url, oss_object_key, oss_uploaded, file_size, provider_url FROM media WHERE id = $1`,
    [mediaId],
  );
  return (r.rows && r.rows[0]) || null;
}

// merge-safe 回填 media_ids：并发下 loser 不盲写覆盖 winner 已落库项（COALESCE 合并）。
async function mergeManifestMediaIds(pgPool, jobId, incoming) {
  const cur = await pgPool.query(
    `SELECT media_ids FROM generation_output_manifests WHERE job_id = $1`,
    [jobId],
  ).then((r) => (r && r.rows && r.rows[0] && r.rows[0].media_ids) || null).catch(() => null);
  if (!Array.isArray(cur) || !cur.length) return incoming.slice();
  return incoming.map((m, i) => (m != null ? m : (cur[i] != null ? cur[i] : null)));
}

// 落库/重放 provider 快照（先于任何拉取，§80）。返回重放后的快照行 + 既有 media_ids。
// opts: { jobId, attemptId, providerManifest?, artifacts? }
//   - 首次：providerManifest 必填（否则抛错）；artifacts 缺省时由 manifest 归一。
//   - 重试（同 attempt）：providerManifest 可省略 → 从既有行重放（不重新生成、不重新归一）；
//     retry_count+1，保留已落库 media_ids。
//   - 新 attempt（attempt_id 变化）：重置 retry_count=0、media_ids 清空，覆盖 manifest/artifacts。
async function snapshotOutputManifest(pgPool, opts) {
  if (!pgPool) throw new Error('数据库不可用，无法落 OutputManifest 快照');
  const { jobId, attemptId, providerManifest, artifacts: artifactsIn } = opts || {};
  if (!jobId) throw new Error('jobId 缺失');
  if (!attemptId) throw new Error('attemptId 缺失');

  const existing = await pgPool.query(
    `SELECT attempt_id, provider_manifest, artifacts, media_ids, retry_count
     FROM generation_output_manifests WHERE job_id = $1`,
    [jobId],
  ).then((r) => (r && r.rows && r.rows[0]) || null).catch(() => null);

  const isRetry = !!(existing && existing.attempt_id === attemptId);
  const isNewAttempt = !!(existing && existing.attempt_id !== attemptId);

  let manifest = providerManifest;
  if (manifest == null) {
    if (existing) manifest = existing.provider_manifest;
    else throw new Error('providerManifest 缺失且无既有快照可重放（首次必须提供原样 manifest）');
  }

  let artifacts = Array.isArray(artifactsIn) ? artifactsIn : null;
  if (!Array.isArray(artifacts) || !artifacts.length) {
    if (existing) artifacts = Array.isArray(existing.artifacts) ? existing.artifacts : [];
    else artifacts = normalizeOutputArtifacts(manifest);
  }
  artifacts = artifacts.filter(Boolean).map((a) => normalizeOutputArtifact(a) || a);

  let mediaIds = Array.isArray(existing && existing.media_ids) ? existing.media_ids.slice() : [];
  let retryCount = existing ? Number(existing.retry_count || 0) : 0;
  if (isRetry) {
    retryCount += 1;
  } else if (isNewAttempt) {
    retryCount = 0;
    mediaIds = [];
  }
  // media_ids 与 artifacts 下标对齐，未落库项 null
  mediaIds = artifacts.map((_, i) => (mediaIds[i] != null ? mediaIds[i] : null));

  await pgPool.query(
    `INSERT INTO generation_output_manifests
       (job_id, attempt_id, provider_manifest, artifacts, media_ids, retry_count)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (job_id) DO UPDATE SET
       attempt_id = EXCLUDED.attempt_id,
       provider_manifest = EXCLUDED.provider_manifest,
       artifacts = EXCLUDED.artifacts,
       media_ids = EXCLUDED.media_ids,
       retry_count = EXCLUDED.retry_count,
       updated_at = NOW()`,
    [jobId, attemptId, JSON.stringify(manifest), JSON.stringify(artifacts), mediaIds, retryCount],
  );

  return {
    jobId, attemptId,
    providerManifest: manifest,
    artifacts, mediaIds, retryCount,
    isRetry,
    replayedFromSnapshot: !providerManifest && !!existing,
  };
}

// 终态后编排：先存快照（§80 先于拉取）→ 逐件拉取落库 → 回填 media_ids/artifacts/finalized_at。
// opts: { jobId, attemptId, providerManifest?, userId, prompt?, model?, ratio?, pendingIds?,
//         maxRetries?, retryBaseDelayMs?, retryMaxDelayMs?, atomicClaim?, probe? }
// 返回 { jobId, attemptId, providerSuccess, jobSuccess, finalizeExhausted, reasonCode,
//         artifacts, mediaIds, finalizedAt, retryCount, retryAfterMs, results }。
//   - providerSuccess = true（快照已落 = provider 成功产出 manifest）。
//   - jobSuccess = true 仅当所有 artifacts 拉取落库成功 + media_ids 齐（无 NULL）；否则 false（仍 retry 域，§79）。
//   - 重试（同 attempt）可省略 providerManifest：从快照重放，只补拉未落库 artifact（§80 绝不重新生成）。
//   - L28 独立重试：retry_count 超 maxRetries → finalizeExhausted=true、reasonCode=FINALIZE_EXHAUSTED（job 域终态 failed，
//     由接线层落 generation_items_v2），snapshot 保留供人工重放；退避 retryAfterMs 仅由 retry_count 决定（独立于 Job 总重试）。
async function finalizeOutputManifest(pgPool, opts) {
  const {
    jobId, attemptId, providerManifest, userId, prompt = '', model = '', ratio = '1:1', pendingIds, probe,
    maxRetries = FINALIZE_DEFAULT_MAX_RETRIES,
    retryBaseDelayMs = FINALIZE_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = FINALIZE_RETRY_MAX_DELAY_MS,
    atomicClaim = false,
  } = opts || {};
  if (!userId) throw new Error('userId 缺失');

  // 1. 快照先于拉取（§80）：写入/重放 generation_output_manifests，拿到归一 artifacts + 既有 media_ids
  const snap = await snapshotOutputManifest(pgPool, { jobId, attemptId, providerManifest });

  const artifacts = snap.artifacts.slice();
  const mediaIds = snap.mediaIds.slice();
  const results = new Array(artifacts.length);
  let allLanded = true;

  // ── L28 独立重试上限（§80 续）：同 attempt 重放且 retry_count 超 maxRetries → job 域终态 failed。
  //    不再拉取；snapshot 保留（media_ids 不删、finalized_at 仍 NULL）供人工重放。
  if (snap.isRetry && snap.retryCount > maxRetries) {
    return {
      jobId, attemptId,
      providerSuccess: true,
      jobSuccess: false,
      finalizeExhausted: true,
      reasonCode: FINALIZE_EXHAUSTED_CODE,
      artifacts, mediaIds,
      finalizedAt: null,
      retryCount: snap.retryCount,
      retryAfterMs: null, // 终态：不再自动重试；仅人工重放
      results: artifacts.map((a, i) => ({
        ...a,
        mediaId: mediaIds[i] != null ? mediaIds[i] : null,
        landed: mediaIds[i] != null,
        replayed: mediaIds[i] != null,
        status: mediaIds[i] != null ? 'success' : 'failed',
        error: mediaIds[i] != null ? undefined : 'finalize retries exhausted',
      })),
    };
  }

  // 2. 逐件拉取落库：已落库（mediaIds[i] 非 null）跳过（快照重放），只补拉缺失项
  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i];
    if (mediaIds[i] != null) {
      results[i] = { ...a, mediaId: mediaIds[i], landed: true, replayed: true, status: 'success' };
      continue;
    }
    const type = deriveArtifactMediaType(a.kind, a.mimeType);
    // L28 确定性 media id：并发双 finalize 同 (jobId, idx) → 同 id → ON CONFLICT 幂等锚点（绝不随机）。
    const mediaId = deterministicMediaId(jobId, i, Array.isArray(pendingIds) ? pendingIds[i] : undefined);

    // L28 并发单拉取（可选原子认领）：仅 winner 真正拉字节；loser 读回已落库或跳过（ON CONFLICT 幂等）。
    if (atomicClaim) {
      const claim = await claimMediaSlot(pgPool, { mediaId, userId, taskId: jobId, type, providerUrl: a.url })
        .catch(() => ({ claimed: false }));
      if (!claim.claimed) {
        const existing = await readMediaSlot(pgPool, mediaId).catch(() => null);
        if (existing && existing.status === 'success') {
          mediaIds[i] = mediaId;
          if (existing.oss_url) a.ossUrl = existing.oss_url;
          results[i] = { ...a, mediaId, ossUrl: existing.oss_url || null, landed: true, replayed: false, claimedByOther: true, status: 'success' };
        } else {
          allLanded = false;
          results[i] = { ...a, mediaId, landed: false, replayed: false, claimedByOther: true, status: 'finalizing' };
        }
        continue;
      }
    }

    try {
      const r = await finalizeUrl(pgPool, {
        userId, taskId: jobId, idx: i, providerUrl: a.url, type,
        prompt, model, ratio, pendingId: mediaId,
        captureChecksum: true,           // L29 §82 checksum 完整性：恒计算 sha256（缺则补）
        expectedChecksum: a.checksum || undefined, // 有 provider checksum 则核验（§79 VERIFY 闸）
        probe,                            // L29 元数据探针（可注入；缺省走 ffprobe）
      });
      if (r && r.status === 'success') {
        mediaIds[i] = r.mediaId;
        a.mimeType = r.contentType || a.mimeType;
        a.sizeBytes = r.fileSize != null ? r.fileSize : a.sizeBytes;
        // L29 — checksum 回填（缺则补 sha256 计算；有则已核验通过）
        if (r.sha256) a.checksum = r.sha256;
        // L29 — 元数据回填（宽容归一；空对象不落键，保持 artifacts 干净）
        const meta = normalizeOutputMetadata(r.meta || {}, { thumbnailUrl: r.thumbnail });
        if (Object.keys(meta).length) a.metadata = meta;
        results[i] = { ...a, mediaId: r.mediaId, ossUrl: r.ossUrl, landed: true, replayed: false, status: 'success' };
      } else {
        // 拉取/落库失败：media_ids 保持 null（未落库），Job 未成功，仍处 retry 域（§79）
        allLanded = false;
        results[i] = { ...a, mediaId: r && r.mediaId ? r.mediaId : null, landed: false, replayed: false, status: (r && r.status) || 'failed' };
      }
    } catch (e) {
      allLanded = false;
      results[i] = { ...a, mediaId: null, landed: false, replayed: false, status: 'failed', error: e && e.message ? e.message : String(e) };
    }
  }

  // 3. 回填 artifacts（sizeBytes/mimeType 已拉取成功者更新）+ media_ids + finalized_at（全落才置值）。
  //    atomicClaim 并发路径走 merge-safe（loser 不盲写覆盖 winner 已落库项）；默认路径快照重放已保证单调。
  const finalizedAt = allLanded ? new Date().toISOString() : null;
  const finalMediaIds = atomicClaim ? await mergeManifestMediaIds(pgPool, jobId, mediaIds) : mediaIds.slice();
  await pgPool.query(
    `UPDATE generation_output_manifests
     SET artifacts = $2, media_ids = $3, finalized_at = $4, updated_at = NOW()
     WHERE job_id = $1`,
    [jobId, JSON.stringify(artifacts), finalMediaIds, finalizedAt ? finalizedAt : null],
  ).catch(() => ({ rows: [] }));

  const mediaIdsComplete = artifacts.length > 0 && finalMediaIds.every((m) => m != null);
  const jobSuccess = allLanded && mediaIdsComplete;
  return {
    jobId, attemptId,
    providerSuccess: true, // 快照已落 = provider 成功产出 manifest（§79 与 Job Success 严格区分）
    jobSuccess,
    finalizeExhausted: false,
    reasonCode: jobSuccess ? null : 'FINALIZE_FAILED',
    artifacts, mediaIds: finalMediaIds,
    finalizedAt: jobSuccess ? finalizedAt : null,
    retryCount: snap.retryCount,
    // L28 退避只由 FINALIZE retry_count 决定（独立于 Job 总重试 attempt_count）；成功则无需重试。
    retryAfterMs: jobSuccess ? null : computeFinalizeBackoffMs(snap.retryCount, retryBaseDelayMs, retryMaxDelayMs),
    results,
  };
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
  // L27 OutputManifest（§78-80）
  normalizeOutputArtifact,
  normalizeOutputArtifacts,
  deriveArtifactMediaType,
  snapshotOutputManifest,
  finalizeOutputManifest,
  // L28 Finalize 独立重试（§80 续）
  deterministicMediaId,
  computeFinalizeBackoffMs,
  claimMediaSlot,
  readMediaSlot,
  mergeManifestMediaIds,
};
