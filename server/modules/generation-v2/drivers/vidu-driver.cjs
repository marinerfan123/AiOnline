'use strict';
/**
 * Vidu Provider Driver（L25，组E）— 多 Operation 驱动。
 *
 * §22-23 Driver Contract 具体实现（对齐已合 L22 provider-adapter.cjs）：
 *   统一接口 { submit, poll, fetch, cancel, compile } + 三归一
 *   { normalizeStatus, normalizeError, normalizeResult } —— 三种原始输入
 *   （状态词 / 错误 / 结果）收敛到同一契约形状，上层只认一个形状，不猜各家字段。
 *
 * compile() 是 Provider 差异的唯一边界（§23）：
 *   业务输入（Model Operation Input，含 operation_code）→ Vidu provider request。
 *   按 operation_code 分支出不同请求形状（vidu 一个 operation 一个 endpoint，
 *   首尾帧/图生/参考生形状各异，见 docs/product-v2 §75「Preflight 必须 Provider-specific」：
 *   Vidu Start-End 是独立 endpoint，Image-to-Video 又不同 duration/resolution/audio
 *   → 不能一个 giant schema）。禁 quota/billing/routing 业务逻辑（buildBody 白名单，
 *   绝不 spread 业务输入）；Provider 参数只活在 request body 内，不得泄漏回上层。
 *
 * 鉴权：Authorization: Token <token>（非 Bearer，见 scripts/seed/model-hub.config.json
 *   vidu.notes「鉴权头为 Authorization: Token ***」）。base_url 缺省 https://api.vidu.cn。
 *
 * http 契约（注入传输层，便于测试替身）：{ request({ method, url, headers, body }) →
 *   Promise<{ status, body }> }（body 为已解析 JSON 或原始串）。credentials：{ token }。
 * operations（可选）：operation_code → { endpoint, buildBody }，覆盖/扩展缺省形状。
 */

const {
  DriverContractError,
  normalizeStatus: baseNormalizeStatus,
  normalizeError: baseNormalizeError,
  normalizeResult: baseNormalizeResult,
  registerDriverFactory,
} = require('../provider-adapter.cjs');

const DEFAULT_BASE_URL = 'https://api.vidu.cn';

// compile() 对未知 operation_code 的拒绝错误码（§70 taxonomy；provider-adapter FAILED_CODES 含之 → 'failed'）。
const UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION';

// ─── 业务输入抽取（白名单；buildBody 只用这些字段，业务字段天然被丢弃）──────────
function pickModel(input) {
  const v = input.model ?? input.modelId ?? input.upstreamModelName ?? null;
  return v == null || v === '' ? null : String(v);
}
function asArray(v) { return Array.isArray(v) ? v : []; }
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v) { return v == null || v === '' ? null : String(v); }
function setNum(body, key, v) { const n = numOrNull(v); if (n != null) body[key] = n; }
function setStr(body, key, v) { const s = strOrNull(v); if (s != null) body[key] = s; }

// ─── 各 operation 的 provider 请求体形状（按 operation_code 分支；至少两种形状）───
// 文生视频：model + prompt + duration/aspect_ratio/resolution（无图）。
function buildText2VideoBody(input) {
  const body = { model: pickModel(input) || 'viduq3' };
  if (input.prompt != null && input.prompt !== '') body.prompt = String(input.prompt);
  setNum(body, 'duration', input.durationSec ?? input.duration);
  setStr(body, 'aspect_ratio', input.aspectRatio ?? input.aspect_ratio ?? input.ratio);
  setStr(body, 'resolution', input.resolution);
  return body;
}

// 图生视频（首帧）：model + images:[firstFrame] + prompt + duration。
function buildImg2VideoBody(input) {
  const body = { model: pickModel(input) || 'viduq3' };
  const refs = asArray(input.referenceImages);
  if (refs.length) body.images = [refs[0]];
  if (input.prompt != null && input.prompt !== '') body.prompt = String(input.prompt);
  setNum(body, 'duration', input.durationSec ?? input.duration);
  setStr(body, 'resolution', input.resolution);
  return body;
}

// 首尾帧（Start-End）：model + images:[first,last]（要求两图，宽高比接近 §75）+ duration。
function buildFrame2FrameBody(input) {
  const body = { model: pickModel(input) || 'viduq3' };
  const refs = asArray(input.referenceImages);
  if (refs.length >= 2) body.images = [refs[0], refs[1]];
  setNum(body, 'duration', input.durationSec ?? input.duration);
  setStr(body, 'resolution', input.resolution);
  return body;
}

// 参考生视频：model + subjects:[1..7 参考图] + prompt + duration。
function buildReferenceVideoBody(input) {
  const body = { model: pickModel(input) || 'viduq3' };
  const refs = asArray(input.referenceImages);
  if (refs.length) body.subjects = refs.slice(0, 7);
  if (input.prompt != null && input.prompt !== '') body.prompt = String(input.prompt);
  setNum(body, 'duration', input.durationSec ?? input.duration);
  return body;
}

// operation_code 词表（单一来源）。endpoint = 提交端点；buildBody = 该 operation 的请求体形状。
const VIDU_OPERATIONS = Object.freeze({
  'video.text_to_video': { endpoint: '/ent/v2/text2video', buildBody: buildText2VideoBody },
  'video.image_to_video': { endpoint: '/ent/v2/img2video', buildBody: buildImg2VideoBody },
  'video.first_last_frame': { endpoint: '/ent/v2/frame2frame', buildBody: buildFrame2FrameBody },
  'video.reference_video': { endpoint: '/ent/v2/reference2video', buildBody: buildReferenceVideoBody },
});
const VIDU_OPERATION_CODES = Object.freeze(Object.keys(VIDU_OPERATIONS));

// ─── Vidu 响应字段抽取（provider-specific，只在此层）──────────────────────────
function extractTaskId(body) {
  const b = body || {};
  const d = b.data && typeof b.data === 'object' ? b.data : null;
  const id = b.task_id ?? b.taskId ?? b.id ?? (d && (d.task_id ?? d.taskId ?? d.id));
  return id ? String(id) : '';
}
function extractStatus(body) {
  const b = body || {};
  const d = b.data && typeof b.data === 'object' ? b.data : null;
  return b.status ?? (d && d.status) ?? null;
}
function httpError(res) {
  const body = (res && res.body) || {};
  const b = body && typeof body === 'object' ? body : {};
  const rawMessage = (b.error && (b.error.message || b.error.msg)) || b.message
    || (typeof body === 'string' ? body : '') || `HTTP ${res.status}`;
  let code;
  if (res.status === 429) code = 'RATE_LIMIT';
  else if (res.status === 401 || res.status === 403) code = 'AUTH_ERROR';
  else if (res.status === 404) code = 'NOT_FOUND';
  else if (res.status === 400 || res.status === 422) code = 'INVALID_INPUT';
  else code = 'PROVIDER_FAILED';
  const out = { code, httpStatus: res.status, message: String(rawMessage).slice(0, 200) };
  const ra = b.retry_after ?? b.retryAfter ?? res.retryAfter;
  if (ra != null) out.retryAfter = ra;
  return out;
}

// ─── 三归一（vidu-specific 抽取 → 委托契约规范实现，产出同一形状）───────────────
// normalizeStatus：vidu 状态词与契约词表同源（success/failed/processing…），直接委托。
function normalizeStatus(raw) { return baseNormalizeStatus(raw); }
// normalizeError：vidu 错误 → { status, errorCode, errorMessage, retryAfter? }。
function normalizeError(err) { return baseNormalizeError(err); }
// normalizeResult：先抽 vidu 嵌套形状（data.url / creations[0].url / cover_url / data.status），再委托。
function normalizeResult(result) {
  const r = result || {};
  const d = r.data && typeof r.data === 'object' ? r.data : null;
  const flatStatus = r.status != null ? r.status : (d && d.status);
  const nestedUrl = (d && (d.url || d.video_url || d.cover_url))
    || (Array.isArray(r.creations) && r.creations[0]
      && (r.creations[0].url || r.creations[0].video_url))
    || null;
  const normalized = { ...r };
  if (flatStatus != null) normalized.status = flatStatus;
  if (nestedUrl) normalized.providerUrl = nestedUrl;
  return baseNormalizeResult(normalized);
}

/**
 * 工厂：createViduDriver({ http, credentials, baseUrl?, operations? })。
 * @param {object} deps
 * @param {{request:(o:object)=>Promise<{status:number,body?:any}>}} deps.http  传输层
 * @param {{token?:string,apiKey?:string,api_token?:string}} deps.credentials  鉴权（Vidu 用 Token 头）
 * @param {string} [deps.baseUrl]  缺省 https://api.vidu.cn（尾斜杠剥除）
 * @param {object} [deps.operations]  operation_code → { endpoint, buildBody }，覆盖/扩展缺省
 * @returns {{submit,poll,fetch,cancel,compile,normalizeStatus,normalizeError,normalizeResult}}
 */
function createViduDriver({ http, credentials, baseUrl, operations } = {}) {
  if (!http || typeof http.request !== 'function') {
    throw new TypeError('vidu driver: http.request 传输层必填');
  }
  const creds = credentials || {};
  const token = String(creds.token ?? creds.apiKey ?? creds.api_token ?? '').trim();
  const effBase = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  // 注册表用 Object.create(null) 防 prototype 链键穿透（对齐 provider-adapter._registry）。
  const ops = Object.assign(Object.create(null), VIDU_OPERATIONS, operations || {});

  const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Token ${token}` });
  const taskUrl = (taskId) => `${effBase}/ent/v2/tasks/${encodeURIComponent(String(taskId))}/creations`;

  // compile()：业务输入 → provider request（唯一边界，纯翻译，禁业务逻辑）。
  function compile(businessInput) {
    const input = businessInput || {};
    const code = String(input.operationCode ?? input.operation_code ?? '').trim();
    if (!code) {
      throw new DriverContractError(UNSUPPORTED_OPERATION, 'vidu.compile: operation_code 必填');
    }
    const op = ops[code];
    if (!op || typeof op.buildBody !== 'function') {
      throw new DriverContractError(
        UNSUPPORTED_OPERATION,
        `vidu.compile: 未知 operation_code "${code}"（支持: ${VIDU_OPERATION_CODES.join(', ')}）`,
      );
    }
    return {
      method: 'POST',
      url: `${effBase}${op.endpoint}`,
      body: op.buildBody(input),
    };
  }

  // submit：compile → 鉴权 → POST → 归一。缺凭证/网络错/未知 operation 一律归一，绝不向上抛。
  async function submit(businessInput) {
    if (!token) return normalizeError({ code: 'AUTH_ERROR', message: 'vidu: 未配置 Token（credentials.token）' });
    let req;
    try { req = compile(businessInput); }
    catch (e) { return normalizeError(e); }
    let res;
    try {
      res = await http.request({ method: req.method, url: req.url, headers: authHeaders(), body: req.body });
    } catch (e) {
      return normalizeError(e); // 网络/超时 → 'unknown'（可重试，绝不判 failed）
    }
    if (res.status >= 400) return normalizeError(httpError(res));
    const taskId = extractTaskId(res.body);
    if (!taskId) return normalizeError({ code: 'PROVIDER_FAILED', message: 'vidu: 提交未返回 task_id' });
    return { status: 'pending', providerTaskId: taskId, providerRequestId: taskId };
  }

  // poll：GET 任务状态 → 归一状态词（成功不取 URL，取 URL 交给 fetch）。
  async function poll(taskId) {
    if (!token) return normalizeError({ code: 'AUTH_ERROR', message: 'vidu: 未配置 Token（credentials.token）' });
    if (taskId == null || taskId === '') {
      return normalizeError({ code: 'INVALID_INPUT', message: 'vidu: poll taskId 必填' });
    }
    let res;
    try {
      res = await http.request({ method: 'GET', url: taskUrl(taskId), headers: authHeaders() });
    } catch (e) {
      return normalizeError(e);
    }
    if (res.status >= 400) return normalizeError(httpError(res));
    const st = normalizeStatus(extractStatus(res.body));
    if (st === 'failed') {
      return normalizeError({ code: 'PROVIDER_FAILED', message: 'vidu: 任务失败' });
    }
    return { status: st, providerTaskId: String(taskId) };
  }

  // fetch：GET 任务/结果 → 归一（成功取 providerUrl）。
  async function fetch(taskId) {
    if (!token) return normalizeError({ code: 'AUTH_ERROR', message: 'vidu: 未配置 Token（credentials.token）' });
    if (taskId == null || taskId === '') {
      return normalizeError({ code: 'INVALID_INPUT', message: 'vidu: fetch taskId 必填' });
    }
    let res;
    try {
      res = await http.request({ method: 'GET', url: taskUrl(taskId), headers: authHeaders() });
    } catch (e) {
      return normalizeError(e);
    }
    if (res.status >= 400) return normalizeError(httpError(res));
    return normalizeResult(res.body);
  }

  // cancel：Vidu 无公开取消端点（L25 交付不含）→ UNSUPPORTED（§22 禁 return null）。
  async function cancel(taskId) {
    if (taskId == null || taskId === '') {
      return normalizeError({ code: 'INVALID_INPUT', message: 'vidu: cancel taskId 必填' });
    }
    return normalizeError({ code: 'UNSUPPORTED', message: 'vidu: cancel 未实现（Vidu 无公开取消端点）' });
  }

  return { submit, poll, fetch, cancel, compile, normalizeStatus, normalizeError, normalizeResult };
}

// 静态工厂注册（§138 无副作用）：模块加载即登记工厂引用，不实例化、不 I/O。
// fromContract(..., { instantiate }) 在 DI 层提供 http/credentials 后延迟实例化。
registerDriverFactory('vidu', createViduDriver);

module.exports = {
  createViduDriver,
  VIDU_OPERATIONS,
  VIDU_OPERATION_CODES,
  UNSUPPORTED_OPERATION,
  DEFAULT_BASE_URL,
};
