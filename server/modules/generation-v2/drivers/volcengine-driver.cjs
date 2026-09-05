'use strict';
/**
 * volcengine 直连 Driver（L23, 组E）—— 火山方舟 Seedance 视频生成直连适配。
 *
 * 实现 §22-23 Driver Contract 统一接口（{ submit, poll, fetch, cancel, compile }）：
 *   submit : POST   {baseUrl}/contents/generations/tasks        → { status:'submitted', providerTaskId }
 *   poll   : GET    {baseUrl}/contents/generations/tasks/{id}   → 归一状态（success/failed/pending/not_found/unknown）
 *   fetch  : GET    {baseUrl}/contents/generations/tasks/{id}   → 产物 url 归一（providerUrl）
 *   cancel : DELETE {baseUrl}/contents/generations/tasks/{id}   → { status:'canceled' }
 *   compile: 业务输入(Model Operation Input) → provider request（§23 唯一边界）
 *
 * 边界约定（§22-23）：
 *   · compile() 是 Provider 差异的唯一边界 —— 只做「业务输入 → provider request」委托，
 *     禁 quota / billing / routing 等业务逻辑；Provider 参数不得向上泄漏。
 *   · 三归一复用 provider-adapter.cjs 导出（normalizeStatus / normalizeError / normalizeResult），
 *     本文件不重写状态词表，保证与 applyProviderEvent / queryProviderStatus 返回值「同形」。
 *   · 未知响应形状 → 归一为 'unknown'；网络/超时异常 → 归一 error，绝不向上抛裸异常。
 *
 * 依赖注入：http 为注入客户端（测试注入 mock，无真实网络调用）；credentials.apiKey 鉴权。
 *   http.request(url, { method, headers, body }) → Promise<{ status:number, body:object|null }>
 *   · status：HTTP 状态码；body：已解析的 JSON 对象（解析失败为 null）。
 */

const {
  normalizeStatus, normalizeError, normalizeResult, DRIVER_ERROR, registerDriverFactory,
} = require('../provider-adapter.cjs');

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

// 视频模式推导（缺省由参考图数量决定），与 providers/video/shared.deriveVideoMode 对齐。
function deriveVideoMode(refs) {
  const n = Array.isArray(refs) ? refs.length : 0;
  if (n === 0) return 't2v';
  if (n === 1) return 'i2v_first';
  if (n === 2) return 'i2v_first_last';
  return 'reference_image';
}

// 多模态 content[] 构造（volcengine wire 格式）：
//   text 用 { type:'text', text }；image 用 { type:'image_url', role, image_url:{ url } }。
function buildContent(businessInput) {
  const input = businessInput || {};
  const prompt = input.prompt == null ? '' : String(input.prompt);
  const refs = Array.isArray(input.referenceImages) ? input.referenceImages : [];
  const mode = input.videoMode || deriveVideoMode(refs);
  const content = [];
  if (prompt !== '') content.push({ type: 'text', text: prompt });
  if (mode === 'i2v_first_last' && refs.length >= 2) {
    content.push({ type: 'image_url', role: 'first_frame', image_url: { url: refs[0] } });
    content.push({ type: 'image_url', role: 'last_frame', image_url: { url: refs[1] } });
  } else if (mode === 'reference_image') {
    for (const u of refs) content.push({ type: 'image_url', role: 'reference_image', image_url: { url: u } });
  } else if (mode === 'i2v_first' || refs.length >= 1) {
    content.push({ type: 'image_url', role: 'first_frame', image_url: { url: refs[0] } });
  }
  return content;
}

// 非2xx → 归一错误（与 fal/vidu 一致：429→RATE_LIMIT、5xx→NETWORK_ERROR 可重试，绝不判 failed）。
// 此前 volcengine 无 status 映射：submit/poll/fetch 把 429/5xx 落到 body.error.code 直通或 normalizeStatus(undefined)，
// 丢失 RATE_LIMIT 码 + Retry-After，破坏与 L21 poll policy(decideRetry) 的交互（429 无法识别 → 走固定退避而非 Retry-After）。
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
  else if (res.status >= 500) code = 'NETWORK_ERROR';
  else code = 'UNKNOWN';
  const out = { code, httpStatus: res.status, message: String(rawMessage).slice(0, 200) };
  const ra = b.retry_after ?? b.retryAfter ?? res.retryAfter
    ?? (res.headers && (res.headers['retry-after'] || res.headers['Retry-After']));
  if (ra != null) out.retryAfter = ra;
  return out;
}

function createVolcengineDriver({ http, credentials, baseUrl } = {}) {
  if (!http || typeof http.request !== 'function') {
    throw new TypeError('createVolcengineDriver: http.request is required');
  }
  if (!credentials || typeof credentials.apiKey !== 'string' || !credentials.apiKey.trim()) {
    throw new TypeError('createVolcengineDriver: credentials.apiKey is required');
  }
  const apiKey = credentials.apiKey;
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  const authHeaders = () => ({ Authorization: `Bearer ${apiKey}` });

  // 统一 HTTP 调用 + 异常归一（不抛裸）：网络/超时 → normalizeError（status:'unknown'，可重试）。
  async function call(method, path, { body } = {}) {
    const url = `${base}${path}`;
    const opts = { method, headers: authHeaders() };
    if (body !== undefined) opts.body = body;
    try {
      return await http.request(url, opts);
    } catch (e) {
      const name = (e && e.name) || '';
      const code = (name === 'AbortError' || name === 'TimeoutError')
        ? DRIVER_ERROR.NETWORK_ERROR
        : ((e && e.code) || DRIVER_ERROR.NETWORK_ERROR);
      return { _normalizedError: normalizeError({ code, message: (e && e.message) || String(e) }) };
    }
  }

  // GET 任务详情，解包 body.data（volcengine 任务详情在 data 内，兼容根级直给）。
  async function getTask(taskId) {
    const res = await call('GET', `/contents/generations/tasks/${encodeURIComponent(String(taskId))}`);
    if (res && res._normalizedError) return { error: res._normalizedError };
    const body = res && res.body ? res.body : {};
    const obj = (body.data && typeof body.data === 'object') ? body.data : body;
    return { res, obj };
  }

  // ─── compile(): 业务输入 → provider request（§23 唯一边界，仅委托）───
  function compile(businessInput) {
    const input = businessInput || {};
    const request = {
      model: input.model || input.modelId || '',
      content: buildContent(input),
    };
    if (input.resolution != null) request.resolution = input.resolution;
    if (input.ratio != null) request.ratio = input.ratio;
    if (input.durationSec != null) request.duration = input.durationSec;
    if (input.seed != null) request.seed = input.seed;
    return request;
  }

  // ─── submit(): compile + POST，返回 provider 任务 ID ───
  async function submit(businessInput) {
    const request = compile(businessInput);
    const res = await call('POST', '/contents/generations/tasks', { body: request });
    if (res && res._normalizedError) return res._normalizedError;
    if (res && res.status >= 400) return normalizeError(httpError(res));
    const body = res && res.body ? res.body : {};
    const taskId = String(body.id || (body.data && body.data.id) || body.task_id || '').trim();
    if (taskId) {
      return { status: 'submitted', providerTaskId: taskId, taskId };
    }
    // 非 2xx / 200 但无 id / 业务错误 → 归一 error（不抛裸）。
    return normalizeError({
      code: (body.error && (body.error.code || body.error.message)) || 'PROVIDER_ERROR',
      message: (body.error && (body.error.message || body.error.msg)) || body.message || 'submit response missing task id',
      httpStatus: res && res.status,
    });
  }

  // ─── poll(): 状态归一（success / failed / pending / not_found / unknown）───
  async function poll(taskId) {
    const got = await getTask(taskId);
    if (got.error) return got.error;
    const { res, obj } = got;
    if (res && res.status >= 400) return normalizeError(httpError(res));
    const status = normalizeStatus(obj.status);
    if (status === 'success') {
      return normalizeResult({
        status: 'success',
        videoUrl: obj.video_url || obj.videoUrl,
        url: obj.url,
        images: obj.images,
        providerTaskId: String(taskId),
      });
    }
    if (status === 'failed') {
      // 生成端 definitive 终态（failed/error/canceled）→ 'failed'（PROVIDER_FAILED 在 FAILED_CODES 内，保证收敛）。
      return normalizeError({
        code: 'PROVIDER_FAILED',
        message: (obj.error && (obj.error.message || obj.error.msg)) || obj.message || 'generation failed',
      });
    }
    // pending / not_found / unknown 统一复用 normalizeResult 收敛（STILL_PROCESSING / NOT_FOUND / UNKNOWN）。
    // 未知响应形状（空 body / 无 status / 陌生词）→ normalizeStatus 返回 'unknown'，绝不抛裸。
    return normalizeResult({
      status,
      errorMessage: (obj.error && (obj.error.message || obj.error.msg)) || obj.message || undefined,
    });
  }

  // ─── fetch(): 产物 url 归一 ───
  async function fetch(taskId) {
    const got = await getTask(taskId);
    if (got.error) return got.error;
    const { res, obj } = got;
    if (res && res.status >= 400) return normalizeError(httpError(res));
    // video_url / videoUrl / url / images[0] 经 normalizeResult 收敛为 providerUrl。
    return normalizeResult({
      status: normalizeStatus(obj.status),
      videoUrl: obj.video_url || obj.videoUrl,
      url: obj.url,
      images: obj.images,
      imageUrl: obj.imageUrl,
      providerTaskId: String(taskId),
    });
  }

  // ─── cancel(): DELETE provider 任务 ───
  async function cancel(taskId) {
    const res = await call('DELETE', `/contents/generations/tasks/${encodeURIComponent(String(taskId))}`);
    if (res && res._normalizedError) return res._normalizedError;
    if (res && res.status >= 200 && res.status < 300) {
      return { status: 'canceled', providerTaskId: String(taskId) };
    }
    // 404 → not_found（任务已不存在）；其余（429/5xx 等）→ 瞬时 unknown（可重试，绝不判 failed）。
    if (res && res.status === 404) {
      return normalizeError({ code: 'NOT_FOUND', message: 'cancel failed: task not found' });
    }
    return normalizeError({
      code: (res && res.status) ? `HTTP_${res.status}` : DRIVER_ERROR.NETWORK_ERROR,
      message: 'cancel failed',
      httpStatus: res && res.status,
    });
  }

  return { submit, poll, fetch, cancel, compile };
}

// 静态工厂注册（§138 无副作用）：模块加载即登记工厂引用，不实例化、不 I/O。
// fromContract(..., { instantiate }) 在 DI 层提供 http/credentials 后延迟实例化。
registerDriverFactory('volcengine', createVolcengineDriver);

module.exports = { createVolcengineDriver, DEFAULT_BASE_URL };
