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
// local-disk provider（真链无云凭据落库后端）：统一适配层把 put/url 操作映射到本模块。
// 模块内容见 localMediaStore.cjs 头部注释；createLocalMediaStore 只做磁盘 IO、零外部依赖。
const {
  createLocalMediaStore,
  MEDIA_NOT_FOUND,
  isMediaNotFound,
  decodeUrlKey,
  encodeUrlKey,
} = require('./modules/media/localMediaStore.cjs');

// ─── 阿里云 OSS helpers ──────────────────────────────
function aliyunHost(cfg) {
  const epRaw = String(cfg.endpointExternal || '').replace(/^https?:\/\//, '');
  return epRaw.includes(cfg.bucket) ? epRaw : `${cfg.bucket}.${epRaw}`;
}
function aliyunBuildSignedUrls(cfg, objectKey) {
  const host = aliyunHost(cfg);
  const rawUrl = `https://${host}/${objectKey}`;
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const qParams = `Expires=${expires}&OSSAccessKeyId=${cfg.accessKeyId}`;
  const getSignStr = `GET\n\n\n${expires}\n/${cfg.bucket}/${objectKey}`;
  const getSig = crypto.createHmac('sha1', cfg.accessKeySecret).update(getSignStr).digest('base64');
  return { rawUrl, signedUrl: `${rawUrl}?${qParams}&Signature=${encodeURIComponent(getSig)}`, expires };
}
// 生成「图片处理」签名 GET URL（省钱省流量：缩图 + 降质 + webp）。
// 关键：x-oss-process 必须算进签名串（CanonicalizedResource 带 ?x-oss-process=原始值），
// 否则阿里云返回 SignatureDoesNotMatch(403)。此格式已在生产实测验证（5.2MB -> 8.8KB webp）。
function aliyunBuildThumbUrl(cfg, objectKey, processStr) {
  const host = aliyunHost(cfg);
  const rawUrl = `https://${host}/${objectKey}`;
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const signStr = `GET\n\n\n${expires}\n/${cfg.bucket}/${objectKey}?x-oss-process=${processStr}`;
  const sig = crypto.createHmac('sha1', cfg.accessKeySecret).update(signStr).digest('base64');
  return {
    rawUrl,
    signedUrl: `${rawUrl}?Expires=${expires}&OSSAccessKeyId=${encodeURIComponent(cfg.accessKeyId)}&x-oss-process=${encodeURIComponent(processStr)}&Signature=${encodeURIComponent(sig)}`,
    expires,
  };
}
// 图片「省钱省流量」缩略图 URL。assetFinalize.cjs 按此名字调用（与 aliyunBuildThumbUrl 区分：
// 此处固定图片处理串，调用方无需关心 process 细节）。返回字符串或空串。
function buildOssThumbUrl(cfg, objectKey) {
  if (!cfg || cfg.providerType !== 'aliyun-oss') return '';
  const processStr = 'image/resize,w_1024/quality,q_80/format,webp';
  const r = aliyunBuildThumbUrl(cfg, objectKey, processStr);
  return r && r.signedUrl ? r.signedUrl : '';
}
// 视频首帧快照（边缘抽帧，无需 ffmpeg）。assetFinalize.cjs 期望返回 { signedUrl } 或 null。
function buildOssVideoSnapshotUrl(cfg, objectKey) {
  if (!cfg || cfg.providerType !== 'aliyun-oss') return null;
  const processStr = 'video/snapshot,t_1000,m_fast,format,jpg,w_400';
  const r = aliyunBuildThumbUrl(cfg, objectKey, processStr);
  return r && r.signedUrl ? { signedUrl: r.signedUrl } : null;
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

// 流式 PUT 签名（不依赖整 buffer）：调用方已算好 md5 或选择不校验。
// 用于 assetFinalize「边下边传」场景——下载流不能先整图算 MD5。
// 双兼容：旧 aliyunPutHeaders(buffer) 仍给 probeConnectivity 等服务端自签场景用。
//   - md5 为空（纯流式无法预知整 body 哈希）：签名串 Content-MD5 行留空，阿里云照样接受
//   - contentLength 缺失则不写 Content-Length（由 fetch 走 chunked）
function aliyunPutHeadersStream(cfg, objectKey, { md5, contentType, contentLength }) {
  const safeMd5 = md5 || '';
  const date = new Date().toUTCString();
  const signStr = `PUT\n${safeMd5}\n${contentType}\n${date}\n/${cfg.bucket}/${objectKey}`;
  const sig = crypto.createHmac('sha1', cfg.accessKeySecret).update(signStr).digest('base64');
  const headers = {
    'Authorization': `OSS ${cfg.accessKeyId}:${sig}`,
    'Content-Type': contentType,
    'Date': date,
  };
  if (safeMd5) headers['Content-MD5'] = safeMd5;
  if (contentLength != null) headers['Content-Length'] = String(contentLength);
  return { md5: safeMd5, date, headers };
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

// 腾讯云流式 PUT 签名：不依赖 buffer，只需 contentLength（签名基于 host+sign-time，与 body 无关）。
// 用于 assetFinalize 边下边传——body 直接是下载流，零整图驻留。
function tencentCosPutHeadersStream(cfg, _objectKey, { contentType, contentLength }) {
  const secretId = cfg.accessKeyId;
  const secretKey = cfg.accessKeySecret;
  const qKeyTime = `${Math.floor(Date.now() / 1000)};${Math.floor(Date.now() / 1000) + 7 * 24 * 3600}`;
  const signKey = crypto.createHmac('sha1', secretKey).update(qKeyTime).digest();
  const httpString = `put\n/${_objectKey}\n\nhost=${cfg._hostName || ''}\n`;
  const stringToSign = `sha1\n${qKeyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`;
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const headers = {
    'Authorization': `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${qKeyTime}&q-key-time=${qKeyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`,
    'Host': cfg._hostName || '',
    'Content-Type': contentType || 'application/octet-stream',
  };
  if (contentLength != null) headers['Content-Length'] = String(contentLength);
  return { headers };
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
// local-disk：无签名概念；返回自托管 URL（store.urlFor），getUrl 可直接入库/下发。
//   '/local-media/<enc key>' 由 server.js 挂载的本地读取路由服务（父线挂载；
//   解码侧现成工具：ossMod.decodeUrlKey / ossMod.localMediaStore.decodeUrlKey）。
function buildOssGetUrl(cfg, objectKey) {
  if (isLocalDiskProvider(cfg)) {
    const store = localStoreFor(cfg);
    return { getUrl: store.urlFor(objectKey), expires: 0, local: true };
  }
  if (cfg.providerType === 'tencent-cos') {
    const { signedUrl, expires } = tencentCosSignUrl(cfg, objectKey);
    return { getUrl: signedUrl, expires };
  }
  const { signedUrl, expires } = aliyunBuildSignedUrls(cfg, objectKey);
  return { getUrl: signedUrl, expires };
}

// 用户的 OSS 命名空间前缀，用于隔离校验（与 sign-upload 的 objectKey 构造保持一致）
function userOssNamespace(cfg, userId) {
  const prefix = (cfg?.pathPrefix || 'images/').replace(/^\/+|\/+$/g, '');
  return `${prefix}/${userId}/`;
}

// ─── local-disk provider（统一适配层）──────────────────────────────
// cfg 约定（父线 getActiveStorageConfig / DB oss_configs 行均可产出）：
//   { providerType: 'local-disk', localDir?: '/data/media' }  // localDir 可省略
// rootDir 解析顺序：cfg.localDir ?? cfg.rootDir ?? '/app/data/media'（模块缺省）。
function isLocalDiskProvider(cfg) {
  return !!(cfg && String(cfg.providerType || cfg.provider || cfg.type || '') === 'local-disk');
}
// 每次返回全新 store 实例（无状态、仅盘 IO），rootDir 以 cfg 或缺省为准。
function localStoreFor(cfg) {
  const rootDir = (cfg && (cfg.localDir || cfg.rootDir)) || undefined;
  return createLocalMediaStore(rootDir ? { rootDir } : {});
}

// 用户命名空间下的 objectKey：与云分支共用 userOssNamespace 语义
//   local-disk 不校验云凭据，但 key 同样锁在 pathPrefix/userId 下，跨用户隔离不变。

// ─── 统一预签名 PUT（signedPut 适配）────────────────────────────
// 返回契约与 aliyunPutSignUrl/tencentCosPutSignUrl 一致：{ rawUrl, putUrl, getUrl,
// expires, putExpires } —— 云分支逐字段透传原函数返回值，绝不自造签名。
// local-disk：无预签名概念（浏览器 PUT 到磁盘没有意义），返回固定契约
//   { providerType:'local-disk', local:true, putUrl:null, getUrl:'/local-media/<enc>',
//     putExpires:0, expires:0 }；
// 调用方见到 local:true 应改走服务端 uploadObject()（store.put），putUrl:null 即该信号。
function buildOssSignPutUrl(cfg, objectKey, contentType) {
  if (isLocalDiskProvider(cfg)) {
    const store = localStoreFor(cfg);
    return {
      providerType: 'local-disk', local: true, objectKey,
      rawUrl: null, putUrl: null, getUrl: store.urlFor(objectKey),
      putExpires: 0, expires: 0,
    };
  }
  const kind = String((cfg && (cfg.providerType || cfg.provider || cfg.type)) || '');
  // 与 server.js 历史选择一致：tencent/cos → COS，其余（含缺省）→ aliyun
  if (kind.includes('tencent') || kind.includes('cos')) {
    return tencentCosPutSignUrl(cfg, objectKey, contentType || 'application/octet-stream');
  }
  return aliyunPutSignUrl(cfg, objectKey, contentType || 'application/octet-stream');
}

// ─── 统一服务端上传（upload/putObject 适配）──────────────────────
// 新增统一函数，供「真链」/挂载代码对任意 providerType 走同一入口：
//   aliyun/tencent：沿用既有 PutHeaders(+Stream) 签名 + HTTP PUT（与 assetFinalize.putObject
//     同款实现，body 收 Buffer/Uint8Array/string；超大流式上传仍建议直接用 stream 头版本）
//   local-disk：store.put（原子写），不碰网络
// 返回：{ ok, key, url, providerType }；失败抛 Error（消息经 diagnoseOssError 包装）。
// 注：云分支为纯网络路径，测试栈无云凭据 → 只做代码路径/契约单测，未做云端实测（如实声明）。
async function uploadObject(cfg, objectKey, body, opts = {}) {
  if (isLocalDiskProvider(cfg)) {
    const store = localStoreFor(cfg);
    const r = await store.put({ objectKey, body });
    return { ok: true, key: r.key, url: store.urlFor(r.key), providerType: 'local-disk' };
  }
  const contentType = opts.contentType || 'application/octet-stream';
  let buf = body;
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
  else if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const kind = String((cfg && (cfg.providerType || cfg.provider || cfg.type)) || '');
  let putUrl;
  let headers;
  if (kind.includes('tencent') || kind.includes('cos')) {
    if (!cfg._hostName) cfg._hostName = `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`;
    putUrl = `https://${cfg._hostName}/${objectKey}`;
    headers = tencentCosPutHeaders(cfg, objectKey, buf, contentType).headers;
  } else {
    const host = aliyunHost(cfg);
    putUrl = `https://${host}/${objectKey}`;
    headers = aliyunPutHeaders(cfg, objectKey, buf, contentType).headers;
  }
  const r = await fetch(putUrl, { method: 'PUT', headers, body: buf });
  if (!r.ok) {
    throw new Error(diagnoseOssError(cfg.providerType, r.status, await r.text().catch(() => '')));
  }
  return { ok: true, key: objectKey, url: putUrl, providerType: kind.includes('tencent') ? 'tencent-cos' : 'aliyun-oss' };
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
  local_dir: 'localDir',
  root_dir: 'rootDir',
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
  if (providerType === 'local-disk') {
    if (status === 500 || status === 0) return `本地磁盘存储写入失败: ${text}`;
    return `本地磁盘存储错误 HTTP ${status}: ${text}`;
  }
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
  // local-disk：目录可写性探测（mkdir -p + W_OK 检查），不留探测文件
  if (isLocalDiskProvider(cfg)) {
    try {
      const store = localStoreFor(cfg);
      const fsp = require('fs').promises;
      await fsp.mkdir(store.rootDir, { recursive: true });
      await fsp.access(store.rootDir, require('fs').constants.W_OK);
      return { ok: true, status: 200, durMs: Date.now() - t0, local: true };
    } catch (e) {
      return { ok: false, status: 500, durMs: Date.now() - t0, local: true, error: e && e.message };
    }
  }
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
  aliyunPutHeadersStream,
  aliyunPutSignUrl,
  aliyunBuildThumbUrl,
  buildOssThumbUrl,
  buildOssVideoSnapshotUrl,
  tencentCosHost,
  tencentCosPutHeaders,
  tencentCosPutHeadersStream,
  tencentCosSignUrl,
  tencentCosPutSignUrl,
  // 辅助
  buildOssGetUrl,
  userOssNamespace,
  loadOssConfigs,
  diagnoseOssError,
  // local-disk provider（统一适配 + store 桥）
  isLocalDiskProvider,
  localStoreFor,
  buildOssSignPutUrl,
  uploadObject,
  localMediaStore: { createLocalMediaStore, MEDIA_NOT_FOUND, isMediaNotFound, decodeUrlKey, encodeUrlKey },
  // 便捷：直接 re-export store 工具，父线挂载 /local-media 路由时可单 require oss.cjs
  createLocalMediaStore,
  MEDIA_NOT_FOUND,
  isMediaNotFound,
  decodeUrlKey,
  encodeUrlKey,
  // 日志
  getLogger,
  setLogger,
  log,
  // 探测
  probeConnectivity,
};
