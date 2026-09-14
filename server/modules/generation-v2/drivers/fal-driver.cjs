'use strict';

/**
 * fal.ai 聚合 Driver (L24, 组E) — §22-23 Driver Contract 实现。
 *
 * fal 是聚合平台：一个 app（模型别名，如 fal-ai/flux/schnell）挂载任意下游模型，
 * 统一走 Queue API（queue.fal.run）：
 *   POST   {baseUrl}/{appId}            → submit（建 queue/任务引用）
 *   GET    {status_url}                 → poll（状态映射）
 *   GET    {response_url}               → fetch（结果 files[] → artifacts）
 *   DELETE {cancel_url}                 → cancel
 *
 * 契约（§22，与 provider-adapter.cjs REQUIRED_DRIVER_SHAPE 同形）：
 *   { submit, poll, fetch, cancel, compile } 五方法。
 *
 *   · compile() 是 Provider 差异唯一边界（§23）：业务输入(Model Operation Input)
 *     → provider request { appId, input }；禁 quota/billing/routing 等业务逻辑；
 *     Provider 参数不泄漏回上层。业务字段（model/operation/count/idempotencyKey…）
 *     在此剥离，只把模型参数直传 provider。
 *
 *   · 三归一复用 adapter：provider-adapter.cjs 的 normalizeStatus / normalizeError /
 *     normalizeResult 是唯一归一入口。fal 状态词表先映射到规范词再走 normalizeStatus；
 *     错误/结果同样收敛到统一契约形状
 *       { status:'success'|'failed'|'pending'|'not_found'|'unknown', ... }
 *     上层（applyProviderEvent / queryProviderStatus）只认这一个形状，不猜 fal 字段。
 *
 *   · 安全：UNKNOWN 绝不当 FAILED；404→not_found；401/403→failed(AUTH_ERROR)；
 *     400/422→failed(INVALID_INPUT)；429/5xx/网络→unknown（可重试，绝不判 provider failed）。
 *
 * 不改 provider-adapter.cjs：本文件按字符串 key 注册（registerFalDriver），运行时接入。
 */

const {
  normalizeStatus,
  normalizeError,
  normalizeResult,
  DriverContractError,
  registerDriverFactory,
} = require('../provider-adapter.cjs');

const DEFAULT_BASE_URL = 'https://queue.fal.run';

// ─── fal 状态词表 → 规范词（映射后再走 provider-adapter normalizeStatus）────────
// fal Queue API status: IN_QUEUE / IN_PROGRESS / COMPLETED（失败经 error body / 非2xx）。
// 宽容：大小写不敏感，兼容 FAILED/CANCELED/EXPIRED 等扩展词。未识别词原样交出，
// 由 normalizeStatus 落到 'unknown'（绝不当 failed）。
const FAL_STATUS_WORDS = Object.freeze({
  IN_QUEUE: 'queued',        // → normalizeStatus('queued')   = pending
  QUEUED: 'queued',
  PENDING: 'pending',
  IN_PROGRESS: 'running',    // → normalizeStatus('running')  = pending
  RUNNING: 'running',
  PROCESSING: 'processing',  // → pending
  STARTED: 'started',        // → pending
  COMPLETED: 'completed',    // → success
  SUCCEEDED: 'succeeded',    // → success
  SUCCESS: 'success',        // → success
  DONE: 'done',              // → success
  FAILED: 'failed',          // → failed
  ERROR: 'error',            // → failed
  CANCELLED: 'cancelled',    // → failed
  CANCELED: 'canceled',      // → failed
  EXPIRED: 'expired',        // → failed
  REJECTED: 'rejected',      // → failed
});

function mapFalStatus(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const upper = s.toUpperCase();
  return FAL_STATUS_WORDS[upper] != null ? FAL_STATUS_WORDS[upper] : s;
}

// ─── role / content_type 映射（fetch 结果 files[] → artifacts）──────────────────
// role 语义：image / video / audio / file（供下游路由/展示）；content_type 保留 provider
// 原始 MIME（缺省时按 role 回退规范 MIME）。映射优先级：显式 role > content_type 前缀
// > URL 扩展名 > 'file'。
const ROLE_FROM_CONTENT_TYPE = Object.freeze({ image: 'image', video: 'video', audio: 'audio' });
const DEFAULT_CONTENT_TYPE = Object.freeze({
  image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg', file: 'application/octet-stream',
});
const EXT_ROLE = Object.freeze({
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', mpeg: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio',
});

function roleFromContentType(ct) {
  if (ct == null) return null;
  const c = String(ct).toLowerCase().trim();
  if (!c) return null;
  const major = c.split('/')[0];
  return ROLE_FROM_CONTENT_TYPE[major] || null;
}

function roleFromUrl(url) {
  if (!url) return null;
  const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(url));
  return m ? (EXT_ROLE[m[1].toLowerCase()] || null) : null;
}

function normalizeArtifact(f) {
  if (typeof f === 'string') f = { url: f };
  if (f == null || typeof f !== 'object') f = {};
  const url = String(f.url || f.uri || f.href || f.src || '').trim();
  const rawCt = f.content_type || f.contentType || f.mime_type || f.mimeType || f.type || null;
  const explicitRole = f.role != null ? String(f.role).toLowerCase() : null;
  const role = explicitRole || roleFromContentType(rawCt) || roleFromUrl(url) || 'file';
  const content_type = rawCt != null ? String(rawCt) : DEFAULT_CONTENT_TYPE[role];
  const out = { url, role, content_type };
  if (f.width != null) out.width = f.width;
  if (f.height != null) out.height = f.height;
  if (f.file_size != null) out.file_size = f.file_size;
  if (f.file_name != null) out.file_name = f.file_name;
  if (f.duration != null) out.duration = f.duration;
  return out;
}

// 收集 provider 结果里的各类输出字段 → 统一 files[]（宽容多形）。
function collectFiles(body) {
  if (body == null) return [];
  if (typeof body === 'string') return [{ url: body }];
  const out = [];
  const push = (x) => { if (x != null) out.push(x); };
  const gather = (o) => {
    if (o == null || typeof o !== 'object') return;
    if (Array.isArray(o.files)) o.files.forEach(push);
    if (Array.isArray(o.images)) o.images.forEach(push);
    if (Array.isArray(o.outputs)) o.outputs.forEach(push);
    if (o.video != null) push(o.video);
    if (o.audio != null) push(o.audio);
    if (o.image != null) push(o.image);
    if (o.url != null) push({ url: o.url });
  };
  gather(body);
  // 宽容：个别 app 把产物包在 data 里
  if (body.data != null && typeof body.data === 'object') {
    if (Array.isArray(body.data)) body.data.forEach((d) => gather(d));
    else gather(body.data);
  }
  return out;
}

function normalizeArtifacts(body) {
  return collectFiles(body).map(normalizeArtifact).filter((a) => a.url !== '');
}

// ─── 工具 ──────────────────────────────────────────────────────────────────
function resolveApiKey(credentials) {
  if (typeof credentials === 'string') return credentials;
  if (credentials && typeof credentials === 'object') {
    return credentials.apiKey || credentials.api_key || credentials.key || credentials.token || '';
  }
  return '';
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

// 按 base/appId/requestId 重建 fal 队列 URL（reference 缺 URL 时的宽容回退）。
function buildQueueUrl(base, ref, appIdKey, requestIdKey, suffix) {
  const appId = pick(ref, ['appId', 'app_id']);
  const requestId = pick(ref, ['requestId', 'request_id']);
  if (!appId || !requestId) return null;
  return `${base}/${String(appId).replace(/^\/+/, '')}/requests/${String(requestId)}${suffix || ''}`;
}

function createFalDriver({ http, credentials, baseUrl } = {}) {
  if (!http || (typeof http !== 'function' && typeof http.request !== 'function')) {
    throw new DriverContractError('CONTRACT_MISSING', 'createFalDriver: http request function is required');
  }
  const apiKey = resolveApiKey(credentials);
  if (!apiKey) {
    throw new DriverContractError('CONTRACT_MISSING', 'createFalDriver: credentials (fal api key) is required');
  }
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  // 底层 HTTP：网络异常 → 抛带 .normalized 的错误（调用方 tryRequest 捕获后返回归一形状）。
  async function request(opts) {
    const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };
    const o = { method: opts.method, url: opts.url, headers };
    if (opts.body !== undefined) o.body = opts.body;
    try {
      return (typeof http === 'function') ? await http(o) : await http.request(o);
    } catch (e) {
      const err = new Error((e && e.message) || String(e));
      err.code = (e && (e.code || e.errorCode)) || 'NETWORK_ERROR';
      err.normalized = normalizeError(err);
      throw err;
    }
  }

  // 捕获网络错误 → 返回归一错误（绝不 throw 给上层猜）。
  async function tryRequest(opts) {
    try {
      return { err: null, res: await request(opts) };
    } catch (e) {
      return { err: (e && e.normalized) ? e.normalized : normalizeError(e), res: null };
    }
  }

  // 非2xx → 归一错误（复用 adapter normalizeError；UNKNOWN 绝不当 FAILED）。
  function httpError(res, fallback) {
    const status = Number((res && res.status) || 0);
    const body = (res && res.body) != null ? res.body : {};
    const detail = (body && typeof body === 'object' && (body.detail || body.error || body.message))
      || (typeof body === 'string' ? body : null) || fallback || `HTTP ${status}`;
    let code;
    if (status === 404) code = 'NOT_FOUND';
    else if (status === 401 || status === 403) code = 'AUTH_ERROR';
    else if (status === 400 || status === 422) code = 'INVALID_INPUT';
    else if (status === 429) code = 'RATE_LIMIT';
    else if (status >= 500) code = 'NETWORK_ERROR';
    else code = 'UNKNOWN';
    // 抽取 Retry-After（body 或响应头），交给上层 decideRetry 尊重（与 vidu/volcengine 一致）。
    const ra = (body && typeof body === 'object' && (body.retry_after ?? body.retryAfter))
      ?? (res && (res.retryAfter
        || (res.headers && (res.headers['retry-after'] || res.headers['Retry-After']))))
      ?? null;
    const err = { code, message: String(detail).slice(0, 200), httpStatus: status };
    if (ra != null) err.retryAfter = ra;
    return normalizeError(err);
  }

  return {
    // ─── compile 边界（§23）：业务输入 → provider request { appId, input } ───
    compile(businessInput) {
      const b = (businessInput && typeof businessInput === 'object') ? businessInput : {};
      const appId = b.model || b.appId || b.app_id || b.modelId || b.model_id;
      if (!appId || typeof appId !== 'string' || !String(appId).trim()) {
        throw new DriverContractError('INVALID_INPUT', 'compile: fal app id (model) is required');
      }
      // 业务字段（路由/幂等/计数/内容类型）不泄漏给 provider；其余为 model input 直传。
      const input = { ...b };
      for (const k of ['model', 'modelId', 'model_id', 'appId', 'app_id', 'operation',
        'count', 'idempotencyKey', 'clientRequestId', 'pendingIds', 'contentType', 'content_type']) {
        delete input[k];
      }
      return { appId: String(appId).trim(), input };
    },

    // ─── submit：POST {base}/{appId} → 建 queue/任务引用 ───
    async submit(providerRequest) {
      const req = (providerRequest && typeof providerRequest === 'object') ? providerRequest : {};
      const appId = req.appId || req.app_id;
      const input = req.input != null ? req.input : (req.payload || {});
      if (!appId || !String(appId).trim()) {
        return normalizeError({ code: 'MISSING_REFERENCE', message: 'submit: appId missing (run compile first)' });
      }
      const url = `${base}/${String(appId).trim().replace(/^\/+/, '')}`;
      const { err, res } = await tryRequest({ method: 'POST', url, body: input });
      if (err) return err;
      if (res && res.status >= 400) return httpError(res, 'fal submit failed');
      const body = (res && res.body) || {};
      const requestId = pick(body, ['request_id', 'requestId']);
      if (!requestId) {
        // 无 request_id → 未知（不臆造 task id）
        return normalizeError({ code: 'UNKNOWN', message: `fal submit returned no request_id: ${JSON.stringify(body).slice(0, 160)}` });
      }
      const rid = String(requestId);
      const app = String(appId).trim();
      const reqBase = `${base}/${app.replace(/^\/+/, '')}`;
      return {
        status: 'success',
        requestId: rid,
        appId: app,
        statusUrl: pick(body, ['status_url', 'statusUrl']) || `${reqBase}/requests/${rid}/status`,
        responseUrl: pick(body, ['response_url', 'responseUrl']) || `${reqBase}/requests/${rid}`,
        cancelUrl: pick(body, ['cancel_url', 'cancelUrl']) || `${reqBase}/requests/${rid}/cancel`,
      };
    },

    // ─── poll：GET status_url → 状态映射（status / status_url 宽容）───
    async poll(reference) {
      const ref = (reference && typeof reference === 'object') ? reference : {};
      let statusUrl = pick(ref, ['statusUrl', 'status_url']) || buildQueueUrl(base, ref, 'appId', 'requestId', '/status');
      if (!statusUrl) {
        return normalizeError({ code: 'MISSING_REFERENCE', message: 'poll: missing status_url / request reference' });
      }
      const { err, res } = await tryRequest({ method: 'GET', url: statusUrl });
      if (err) return err;
      if (res && res.status >= 400) return httpError(res, 'fal poll failed');
      const body = (res && res.body) || {};
      // 宽容：body.status 缺失但含 status_url → 视作中间态；未识别状态词 → unknown（绝不当 failed）。
      const raw = body.status != null ? body.status : (body.status_url != null ? 'IN_PROGRESS' : '');
      const normalized = normalizeStatus(mapFalStatus(raw));
      if (normalized === 'success') {
        return {
          status: 'success',
          responseUrl: pick(body, ['response_url', 'responseUrl']) || pick(ref, ['responseUrl', 'response_url']) || null,
        };
      }
      if (normalized === 'failed') {
        return normalizeError({ code: 'PROVIDER_FAILED', message: String(body.error || body.detail || JSON.stringify(body)).slice(0, 160) });
      }
      if (normalized === 'not_found') {
        return normalizeError({ code: 'NOT_FOUND', message: 'fal task not found' });
      }
      if (normalized === 'unknown') {
        return { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: `fal status unrecognized: ${raw}` };
      }
      return { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'still processing' };
    },

    // ─── fetch：GET response_url → files[] 归一 artifacts ───
    async fetch(reference) {
      const ref = (reference && typeof reference === 'object') ? reference : {};
      let responseUrl = pick(ref, ['responseUrl', 'response_url']) || buildQueueUrl(base, ref, 'appId', 'requestId', '');
      if (!responseUrl) {
        return normalizeError({ code: 'MISSING_REFERENCE', message: 'fetch: missing response_url / request reference' });
      }
      const { err, res } = await tryRequest({ method: 'GET', url: responseUrl });
      if (err) return err;
      if (res && res.status >= 400) return httpError(res, 'fal fetch failed');
      const body = (res && res.body) || {};
      // fal 可能把 error 放在 200 body（个别 app）→ 有 error 且无产物 → failed
      if (body.error != null && collectFiles(body).length === 0) {
        return normalizeError({ code: 'PROVIDER_FAILED', message: String(body.error).slice(0, 160) });
      }
      const artifacts = normalizeArtifacts(body);
      if (!artifacts.length) {
        return normalizeError({ code: 'OUTPUT_INVALID', message: `fal fetch returned no artifacts: ${JSON.stringify(body).slice(0, 160)}` });
      }
      // 复用 adapter normalizeResult 保证 success 形状一致；artifacts 为 fal 扩展。
      const normalized = normalizeResult({ status: 'success', providerUrl: artifacts[0].url, providerRequestId: pick(ref, ['requestId', 'request_id']) });
      return { ...normalized, artifacts };
    },

    // ─── cancel：DELETE cancel_url ───
    async cancel(reference) {
      const ref = (reference && typeof reference === 'object') ? reference : {};
      let cancelUrl = pick(ref, ['cancelUrl', 'cancel_url']) || buildQueueUrl(base, ref, 'appId', 'requestId', '/cancel');
      if (!cancelUrl) {
        return normalizeError({ code: 'MISSING_REFERENCE', message: 'cancel: missing cancel_url / request reference' });
      }
      const { err, res } = await tryRequest({ method: 'DELETE', url: cancelUrl });
      if (err) return err;
      if (res && res.status >= 400) return httpError(res, 'fal cancel failed');
      return { status: 'success', canceled: true };
    },
  };
}

// 注册 helper（L24 组E 接线用；不改 provider-adapter.cjs，运行时按字符串 key 注册）。
function registerFalDriver(driver, kind = 'fal') {
  const { registerDriver } = require('../provider-adapter.cjs');
  return registerDriver(kind, driver);
}

// 静态工厂注册（§138 无副作用）：模块加载即登记工厂引用，不实例化、不 I/O。
// fromContract(..., { instantiate }) 在 DI 层提供 http/credentials 后延迟实例化。
registerDriverFactory('fal', createFalDriver);

module.exports = {
  createFalDriver,
  mapFalStatus,
  normalizeArtifact,
  normalizeArtifacts,
  collectFiles,
  registerFalDriver,
  DEFAULT_BASE_URL,
};
