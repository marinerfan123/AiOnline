// server/oss.cjs — OSS 签名 + 配置加载 + 自诊断的统一模块
//
// 主流做法：
//   - 业务服务器零二进制：浏览器走 PUT 预签名直传 / 后端仅在「服务端最终化」场景拉外部 URL 后直传
//   - 不引入 OSS SDK：HMAC-SHA1 手写，少 200KB 依赖；逻辑收敛在此一处
//   - 失败诊断（diagnoseOssError）也内聚，避免 server.js / dispatcher.cjs / assetFinalize.cjs 各复制一份
//
// 调用者：
//   - server.js（管理路由 /api/oss/* 与 /api/oss/ingest）
//   - assetFinalize.cjs（dispatcher 任务 done 回调里最终化 provider 结果到 OSS）
//   - dispatcher.cjs（最终化调用入口）

const crypto = require('crypto');
const { createOssLogger } = require('./oss-logger.cjs');

// ─── 阿里云 OSS helpers ──────────────────────────────
function aliyunHost(cfg) {
  const epRaw = String(cfg.endpointExternal || '').replace(/^https?:\/\//, '');
  return epRaw.includes(cfg.bucket) ? epRaw : `${cfg.bucket}.${epRaw}`;
}
// 缩略图处理参数：长边缩到 480px，转 WebP（兼容性最优），质量 70。
// 想要更激进压缩可改 format,avif（所有现代浏览器已支持，但旧客户端会破图）。
const THUMB_PROCESS = 'image/resize,w_480/format,webp/quality,q_70';
// 视频封面帧：OSS 服务端在 t=1000ms 抽帧 → jpg，w_480 实测 1280×704 原生视频产出 ~43KB jpg
// 无需 ffmpeg，复用 aliyunBuildSignedUrls 签名链（V1 签名：原始值进串、编码值进 URL）
const VIDEO_SNAPSHOT_PROCESS = 'video/snapshot,t_1000,f_jpg,w_480';

function aliyunBuildSignedUrls(cfg, objectKey, process) {
  const host = aliyunHost(cfg);
  const rawUrl = `https://${host}/${objectKey}`;
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  let getSignStr = `GET\n\n\n${expires}\n/${cfg.bucket}/${objectKey}`;
  let signedUrl = `${rawUrl}?Expires=${expires}&OSSAccessKeyId=${encodeURIComponent(cfg.accessKeyId)}`;
  if (process) {
    const encP = encodeURIComponent(process);
    // V1 签名规范：CanonicalizedResource 用「原始值」，URL 用「编码值」
    getSignStr += `?x-oss-process=${process}`;
    signedUrl += `&x-oss-process=${encP}`;
  }
  const getSig = crypto.createHmac('sha1', cfg.accessKeySecret).update(getSignStr).digest('base64');
  return { rawUrl, signedUrl: `${signedUrl}&Signature=${encodeURIComponent(getSig)}`, expires };
}
function aliyunPutHeaders(cfg, objectKey, buffer, contentType) {
  const md5 = crypto.createHash('md5').update(buffer).digest('base64');
  const date = new Date().toUTCString();
  const signStr = `PUT\n${md5}\n${contentType}\n${date}\n/${cfg.bucket}/${objectKey}`;
  const sig = crypto.createHmac('sha1', cfg.accessKeySecret).update(signStr).digest('base64');
  return {
    md5, date,
    headers: {
      'Authorization': `OSS ${cfg.accessKeyId}:${sig}`,
      'Content-Type': contentType,
      'Content-MD5': md5,
      'Date': date,
    },
  };
}
// 浏览器直传专用：query-string 形式 PUT 预签名（不依赖 forbidden header）
// 阿里云 OSS 的 header 签名依赖 Date/Content-MD5（浏览器无法手动设置），
// 故直传必须走 URL 签名。
function aliyunPutSignUrl(cfg, objectKey, contentType) {
  const host = aliyunHost(cfg);
  const rawUrl = `https://${host}/${objectKey}`;
  const expires = Math.floor(Date.now() / 1000) + 3600; // PUT 预签名 1h 足够
  const putSignStr = `PUT\n\n${contentType}\n${expires}\n/${cfg.bucket}/${objectKey}`;
  const putSig = crypto.createHmac('sha1', cfg.accessKeySecret).update(putSignStr).digest('base64');
  const putUrl = `${rawUrl}?OSSAccessKeyId=${encodeURIComponent(cfg.accessKeyId)}&Expires=${expires}&Signature=${encodeURIComponent(putSig)}`;
  const { signedUrl, expires: getExpires } = aliyunBuildSignedUrls(cfg, objectKey);
  return { rawUrl, putUrl, getUrl: signedUrl, expires: getExpires, putExpires: expires };
}

// ─── 腾讯云 COS helpers ──────────────────────────────
// 腾讯云对象存储签名：SecretId（accessKeyId）/ SecretKey（accessKeySecret）
// Header 签名依赖 Host（浏览器会覆写），故直传走 URL 签名，与阿里云一致。
function tencentCosHost(cfg) {
  const region = cfg.region || 'ap-shanghai';
  const appId = cfg.appId || '';
  const hostName = `${cfg.bucket}${appId ? '-' + appId : ''}.cos.${region}.myqcloud.com`;
  return `https://${hostName}`;
}
function tencentCosPutHeaders(cfg, _objectKey, buffer, contentType) {
  const secretId = cfg.accessKeyId;
  const secretKey = cfg.accessKeySecret;
  const qKeyTime = `${Math.floor(Date.now() / 1000)};${Math.floor(Date.now() / 1000) + 7 * 24 * 3600}`;
  const signKey = crypto.createHmac('sha1', secretKey).update(qKeyTime).digest();
  const httpString = `put\n/${_objectKey}\n\nhost=${cfg._hostName || ''}\n`;
  const stringToSign = `sha1\n${qKeyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`;
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const signatureHeader = `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${qKeyTime}&q-key-time=${qKeyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
  return {
    headers: {
      'Authorization': signatureHeader,
      'Host': cfg._hostName || '',
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': String(buffer.length),
    },
  };
}
function tencentCosSignUrl(cfg, objectKey) {
  const hostName = cfg._hostName || `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`;
  const secretId = cfg.accessKeyId;
  const secretKey = cfg.accessKeySecret;
  const qKeyTime = `${Math.floor(Date.now() / 1000)};${Math.floor(Date.now() / 1000) + 7 * 24 * 3600}`;
  const signKey = crypto.createHmac('sha1', secretKey).update(qKeyTime).digest();
  const httpString = `get\n/${objectKey}\n\nhost=${hostName}\n`;
  const stringToSign = `sha1\n${qKeyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`;
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const host = `https://${hostName}`;
  return {
    rawUrl: `${host}/${objectKey}`,
    signedUrl: `${host}/${objectKey}?q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${qKeyTime}&q-key-time=${qKeyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`,
    expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  };
}
function tencentCosPutSignUrl(cfg, objectKey, contentType) {
  const hostName = cfg._hostName || `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`;
  const host = `https://${hostName}`;
  const secretId = cfg.accessKeyId;
  const secretKey = cfg.accessKeySecret;
  const qKeyTime = `${Math.floor(Date.now() / 1000)};${Math.floor(Date.now() / 1000) + 3600}`;
  const signKey = crypto.createHmac('sha1', secretKey).update(qKeyTime).digest();
  const httpString = `put\n/${objectKey}\n\nhost=${hostName}\n`;
  const stringToSign = `sha1\n${qKeyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`;
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const putUrl = `${host}/${objectKey}?q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${qKeyTime}&q-key-time=${qKeyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
  const { signedUrl, expires } = tencentCosSignUrl(cfg, objectKey);
  return { rawUrl: `${host}/${objectKey}`, putUrl, getUrl: signedUrl, expires, putExpires: Math.floor(Date.now() / 1000) + 3600 };
}

// 按 provider 重签 GET（下载）预签名 URL —— 供服务端最终化场景使用，
// 杜绝信任客户端传来的 oss_url（避免前端篡改或伪造 URL）
function buildOssGetUrl(cfg, objectKey) {
  if (cfg.providerType === 'tencent-cos') {
    const { signedUrl, expires } = tencentCosSignUrl(cfg, objectKey);
    return { getUrl: signedUrl, expires };
  }
  const { signedUrl, expires } = aliyunBuildSignedUrls(cfg, objectKey);
  return { getUrl: signedUrl, expires };
}

// 缩略图签名链：仅 aliyun 支持 x-oss-process；tencent 返回 null（调用方回退全图）
function buildOssThumbUrl(cfg, objectKey) {
  if (cfg.providerType === 'tencent-cos') return null;
  return aliyunBuildSignedUrls(cfg, objectKey, THUMB_PROCESS).signedUrl;
}

// 视频封面帧：给视频对象生成「OSS 边缘抽帧」的签名链
// 返回 { signedUrl, expires }；tencent-cos 暂无视频快照能力 → 返回 null（前端 fallback 用 video 元素自身）
function buildOssVideoSnapshotUrl(cfg, objectKey) {
  if (cfg.providerType === 'tencent-cos') return null;
  return aliyunBuildSignedUrls(cfg, objectKey, VIDEO_SNAPSHOT_PROCESS);
}

// 用户的 OSS 命名空间前缀，用于隔离校验（与 sign-upload 的 objectKey 构造保持一致）
function userOssNamespace(cfg, userId) {
  const prefix = (cfg?.pathPrefix || 'images/').replace(/^\/+|\/+$/g, '');
  return `${prefix}/${userId}/`;
}

// ─── oss_config / oss_configs 行 snake→camel ──────────────────────────
// 用本地映射替代 server.js 的全局 SNAKE_MAP，避免把 server.js 全局状态拽过来
const OSS_ROW_SNAKE_MAP = {
  access_point_name: 'accessPointName',
  endpoint_external: 'endpointExternal',
  endpoint_internal: 'endpointInternal',
  access_key_id: 'accessKeyId',
  access_key_secret: 'accessKeySecret',
  path_prefix: 'pathPrefix',
  custom_domain: 'customDomain',
  region_label: 'regionLabel',
  provider_type: 'providerType',
  display_name: 'displayName',
  app_id: 'appId',
  created_at: 'createdAt',
};
function fromSnake(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) {
    const camel = OSS_ROW_SNAKE_MAP[k] || k;
    out[camel] = row[k];
  }
  return out;
}

// 公共：从 oss_configs 拉所有（或单条）
async function loadOssConfigs(pgPool) {
  if (pgPool) {
    const [cfg, list] = await Promise.all([
      pgPool.query('SELECT * FROM oss_config WHERE id=1'),
      pgPool.query('SELECT * FROM oss_configs ORDER BY created_at'),
    ]);
    return { enabled: cfg.rows[0]?.enabled !== false, activeId: cfg.rows[0]?.active_id || '', list: list.rows.map(fromSnake) };
  }
  // 仅在 pgPool 不可用时降级（按 PG 铁律，正常不会跑到这里）
  return { enabled: false, activeId: '', list: [] };
}

// ─── 错误诊断 ──────────────────────────
function diagnoseOssError(providerType, status, body) {
  const text = String(body || '').slice(0, 200);
  if (providerType === 'aliyun-oss') {
    if (text.includes('NoSuchBucket')) return 'Bucket 不存在，请检查 Bucket 名称';
    if (text.includes('SignatureDoesNotMatch')) return '签名错误，请检查 AccessKey 或 Bucket';
    if (text.includes('AccessDenied')) return '访问被拒绝，请检查 AccessKey 权限';
    return `阿里云 OSS PUT HTTP ${status}: ${text}`;
  }
  if (text.includes('NoSuchBucket') || text.includes('NoSuchResource')) return 'Bucket 不存在或 AppId/Region/Bucket 组合错';
  if (text.includes('SignatureDoesNotMatch') || text.includes('AuthFailure')) return '签名失败，请检查 SecretId/SecretKey/AppId/Region';
  if (text.includes('AccessDenied')) return '访问被拒绝，请检查 CAM 权限（putObject）';
  return `腾讯云 COS PUT HTTP ${status}: ${text}`;
}

// ─── Logger 单例（oss-logger.cjs 是工厂；这里统一管理）─────────────────
let _loggerInstance = null;
function getLogger() {
  if (!_loggerInstance) _loggerInstance = createOssLogger();
  return _loggerInstance;
}
function setLogger(instance) {
  _loggerInstance = instance;
}
// 便捷包装：兼容 server.js 的 `ossLogger[level](action, message, details)` 与 `ossLog(level, ...)`
function log(level, action, message, details) {
  const lg = getLogger();
  if (typeof lg[level] === 'function') return lg[level](action, message, details);
  return lg.record(level, action, message, details);
}

// 探测：服务端在「最终化 provider 资源到 OSS」之前要确保可写、可拉
async function probeConnectivity(cfg, buffer = Buffer.alloc(1), contentType = 'application/octet-stream') {
  const t0 = Date.now();
  let url2put, headers;
  if (cfg.providerType === 'tencent-cos') {
    cfg._hostName = `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`;
    url2put = `https://${cfg._hostName}/__probe_${Date.now()}`;
    const h = tencentCosPutHeaders(cfg, `__probe_${Date.now()}.bin`, buffer, contentType);
    headers = h.headers;
  } else {
    const host = cfg.endpointExternal?.includes(cfg.bucket) ? cfg.endpointExternal : `${cfg.bucket}.${cfg.endpointExternal}`;
    url2put = `https://${host}/__probe_${Date.now()}`;
    const h = aliyunPutHeaders(cfg, `__probe_${Date.now()}`, buffer, contentType);
    headers = h.headers;
  }
  const r = await fetch(url2put, { method: 'PUT', headers, body: buffer });
  const dur = Date.now() - t0;
  return { ok: r.status === 200, status: r.status, durMs: dur };
}

module.exports = {
  // 签名（业务服务器自上传场景用；浏览器直传走 aliyunPutSignUrl/tencentCosPutSignUrl）
  aliyunHost,
  aliyunBuildSignedUrls,
  aliyunPutHeaders,
  aliyunPutSignUrl,
  tencentCosHost,
  tencentCosPutHeaders,
  tencentCosSignUrl,
  tencentCosPutSignUrl,
  // 辅助
  buildOssGetUrl,
  buildOssThumbUrl,
  buildOssVideoSnapshotUrl,
  userOssNamespace,
  loadOssConfigs,
  diagnoseOssError,
  // 日志
  getLogger,
  setLogger,
  log,
  // 探测
  probeConnectivity,
};
