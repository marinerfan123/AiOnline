'use strict';
// 图片 provider 适配层 —— 共享工具（与 providers/video/shared.cjs 同构）
// 所有图像适配器（gpt-image / agnes / openai-compat）共用这里的 HTTP、线格式构造、结果/错误归一。
// 设计目标：新增一家图像供应商 ≈ 1 个薄文件（只做「规范 ImageTask ↔ 线格式」翻译 + call）。
//
// 规范核心（Canonical ImageTask，与供应商无关）：
//   { prompt, ratio, resolution, count, referenceImages[], negative }
//     - model 上游 wire 名由 adapter 内回退：model.upstreamModelName → model.model_id（与 dispatcher 一致）
//     - count：期望张数 n，clamp [1,4]（OpenAI 官方端点原生支持 n；其余模型由上层拆单，n 恒 1）
//
// 统一返回（本层全部 adapter 与 index 一律，契约见各 adapter 头注释）：
//   { ok: true,  result: { images: string[] } }
//   { ok: false, code, retryable, message?, httpStatus?, retryAfterMs? }
// 错误码词汇（与 modelhub/failureClassifier 的 TRANSIENT/PERMANENT 分类对齐）：
//   NO_API_KEY(不可重试) UNAUTHORIZED(不可重试) BAD_REQUEST(不可重试) EMPTY_RESPONSE(不可重试)
//   RATE_LIMITED(可重试) UPSTREAM(可重试) TIMEOUT(可重试) NETWORK(可重试) UNKNOWN_PROVIDER(不可重试)
//
// 语义继承自 dispatcher.imageGenerate（抽离前内联实现的等价搬运）：
//   - 超时默认 60s（AbortController），超时 ≠ 判失败，code TIMEOUT 交上层定夺（dispatcher 语义：可换账号/重试）
//   - 429 → RATE_LIMITED + 解析 Retry-After / x-ratelimit-reset（钳 [1s,10min]），上层按头冷却 key
//   - 网络错/5xx → 可重试（吸收偶发抖动）；鉴权/参数错/响应无图 → 不可重试（避免无谓重试放大故障）

const DEFAULT_TIMEOUT_MS = 60000;

// ─── JSONPath 解析 ──────────────────────────────────
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const tokens = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path))) {
    if (m[2] != null) tokens.push(Number(m[2]));
    else if (m[1] != null) tokens.push(m[1]);
  }
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = typeof t === 'number' ? cur[t] : cur[t];
  }
  return cur;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 裸 base64 → data URI（dispatcher.toDataUri 等价）───
function toDataUri(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://')) return s;
  // provider 返回的 b64_json 是裸 base64，必须包装成 data URI 才能作为 img.src / 持久化 URL 使用
  return `data:image/png;base64,${s}`;
}

// ─── 占位符替换（兼容旧 custom 端点 bodyTemplate 用法；dispatcher.fillTemplate 等价）───
function fillTemplate(template, vars) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), vars);
    if (v == null) return 'null';
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  });
}

// ─── 尺寸映射（dispatcher 常量等价）──────────────────
// OpenAI 兼容（DALL-E 3 / SD / relay）：ratio → size 枚举 + resolution 倍增
const RATIO_TO_SIZE = { '16:9': '1792x1024', '4:3': '1024x768', '1:1': '1024x1024', '3:4': '768x1024', '9:16': '1024x1792' };
// GPT Image 系列（gpt-image-1/2/1.5）官方 size 枚举：auto / 1024x1024 / 1536x1024 / 1024x1536
const GPT_IMAGE_RATIO_TO_SIZE = { '1:1': '1024x1024', '16:9': '1536x1024', '9:16': '1024x1536', auto: 'auto' };
const RES_MULTIPLIER = { '1k': 1, '2k': 2, '4k': 4, '8k': 8 };

function bumpSize(size, res) {
  const mul = RES_MULTIPLIER[res] || 1;
  if (mul === 1) return size;
  const [w, h] = size.split('x').map(Number);
  return `${w * mul}x${h * mul}`;
}

// 三种尺寸策略（dispatcher imageGenerate 分支等价）：
function gptImageSize(ratio) {
  return GPT_IMAGE_RATIO_TO_SIZE[ratio] || GPT_IMAGE_RATIO_TO_SIZE.auto;
}
function agnesImageSize(resolution) {
  return String(resolution || '1k').toUpperCase(); // agnes 图像端点用分辨率档位字符串（1K/2K/4K）
}
function openaiImageSize(ratio, resolution) {
  return bumpSize(RATIO_TO_SIZE[ratio] || '1024x1024', resolution);
}

function isGptImageModel(model) {
  if (!model) return false;
  const name = String((model.upstreamModelName || model.model_id || model.model) || '').toLowerCase();
  return /gpt-image/i.test(name);
}

function clampCount(count) {
  return Math.max(1, Math.min(4, Number(count) || 1));
}

// ─── 端点解析（模型覆盖 > 服务商默认 > openai-compatible 默认；video/shared 同构）───
function resolveEndpoint(provider, model, kind) {
  const me = (model && model.endpoint) || {};
  if (me[kind]) return { protocol: me.protocol, endpoint: me[kind] };
  const pe = (provider && (provider.default_endpoint || provider.defaultEndpoint)) || {};
  if (pe[kind]) return { protocol: pe.protocol, endpoint: pe[kind] };
  return { protocol: (provider && provider.protocol) || 'openai-compatible', endpoint: undefined };
}

// 有效 key：显式 override（≥6 字符）优先，否则回落 provider.api_key（dispatcher imageGenerate 等价）
function effectiveKey(ctx) {
  const over = (ctx && ctx.apiKey) || '';
  if (over && over.length >= 6) return over;
  const pk = (ctx && ctx.provider && ctx.provider.api_key) || '';
  return pk;
}

// 图生图/多图合成：顶层 images 兼容 relay/自定义端点；img2imgInExtraBody 时另附 extra_body.image
// （dispatcher：默认 = 服务商 base_url 是否 agnes；model.endpoint > default_endpoint 可显式覆盖）
function attachReferenceImages(vars, referenceImages, provider, model) {
  const hasImages = Array.isArray(referenceImages) && referenceImages.length > 0;
  if (!hasImages) return;
  const base = (provider && provider.base_url) || '';
  const me = (model && model.endpoint) || {};
  const de = (provider && (provider.default_endpoint || provider.defaultEndpoint)) || {};
  const img2imgInExtraBody = me.img2imgInExtraBody != null ? me.img2imgInExtraBody
    : (de.img2imgInExtraBody != null ? de.img2imgInExtraBody : /agnes-ai\.cn/i.test(base));
  vars.images = referenceImages;
  if (img2imgInExtraBody) {
    vars.extra_body = { image: referenceImages, response_format: 'url' };
  }
}

// ─── 响应图片提取（dispatcher.extractImages 等价）───
function extractImages(body, endpoint) {
  if (!body) return [];
  if (endpoint && endpoint.imageFieldPath) {
    const v = getByPath(body, endpoint.imageFieldPath);
    return Array.isArray(v) ? v.map(toDataUri).filter(Boolean) : v ? [toDataUri(v)].filter(Boolean) : [];
  }
  if (Array.isArray(body && body.data)) {
    return body.data.map((d) => (d && (toDataUri(d.url) || toDataUri(d.b64_json))) || '').filter(Boolean);
  }
  return [];
}

// ─── 错误消息提取（dispatcher.makeError 的 errMsg 等价，不拼业务前缀——前缀由接线层按 code 组装）───
function extractErrMsg(body, status) {
  if (body && body.error && body.error.message) return String(body.error.message);
  if (body && typeof body.error === 'string') return body.error;
  if (body && body.message) return String(body.message);
  if (typeof body === 'string' && body) return body.slice(0, 200);
  return `HTTP ${status}`;
}

// 解析上游 Retry-After / x-ratelimit-reset 头 → 毫秒；钳制 [1s, 10min]（dispatcher 等价）
function parseRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('retry-after') || headers.get('x-ratelimit-reset');
  if (!raw) return undefined;
  const n = Number(raw);
  if (!isNaN(n)) return Math.min(600000, Math.max(1000, n * 1000));
  const d = Date.parse(raw);
  if (!isNaN(d)) return Math.min(600000, Math.max(1000, d - Date.now()));
  return undefined;
}

// ─── 统一返回构造 ──────────────────────────────────
function okResult(images) {
  return { ok: true, result: { images } };
}
function fail(code, retryable, message, extra) {
  const out = { ok: false, code, retryable };
  if (message) out.message = message;
  return Object.assign(out, extra || {});
}

// HTTP 状态 → code / retryable（分类与 failureClassifier：429/5xx/网络 transient；4xx 鉴权参数 permanent）
function httpFailure(status, body, headers) {
  const s = Number(status) || 0;
  const msg = extractErrMsg(body, s);
  if (s === 401 || s === 403) return fail('UNAUTHORIZED', false, msg, { httpStatus: s });
  if (s === 429) {
    const retryAfterMs = parseRetryAfterMs(headers);
    return fail('RATE_LIMITED', true, msg, { httpStatus: s, retryAfterMs });
  }
  if (s >= 400 && s < 500) return fail('BAD_REQUEST', false, msg, { httpStatus: s });
  if (s >= 500) return fail('UPSTREAM', true, msg, { httpStatus: s });
  return fail(`HTTP_${s}`, s >= 500 || s === 429, msg, { httpStatus: s });
}

// ─── 带超时 fetch（默认 60s；dispatcher 的 AbortController+60s 等价，超时可经 ctx.timeoutMs 覆盖）───
// 返回 { status, headers, text }。超时 → 抛 { name:'AbortError', code:'TIMEOUT' }；网络错原样抛。
async function rawFetch(url, init, ctx) {
  const timeoutMs = (ctx && ctx.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const fetchImpl = (ctx && ctx.fetch) || globalThis.fetch;
  const ctrl = new AbortController();
  let timer = null;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      const e = new Error('aborted');
      e.name = 'AbortError';
      e.code = 'TIMEOUT';
      reject(e);
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchImpl(url, { ...init, signal: ctrl.signal }),
      timeoutP,
    ]);
    const text = await res.text();
    return { status: res.status, ok: res.ok === true || (res.status >= 200 && res.status < 300), headers: res.headers || null, text };
  } catch (e) {
    // 无论 race 中先落的是原生 AbortError 还是超时哨兵，只要信号已 abort 一律归 TIMEOUT（确定性）
    if (ctrl.signal.aborted) {
      const t = new Error('aborted');
      t.name = 'AbortError';
      t.code = 'TIMEOUT';
      throw t;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── custom 端点调用（dispatcher.callEndpoint 等价：bodyTemplate / GET-DELETE query / parse 容错）───
async function customCall(baseUrl, endpoint, apiKey, vars, ctx) {
  const effBase = (endpoint && endpoint.baseUrl) || baseUrl;
  let url = `${String(effBase || '').replace(/\/+$/, '')}${endpoint.path.startsWith('/') ? endpoint.path : '/' + endpoint.path}`;
  const method = endpoint.method || 'POST';
  const headers = { 'Content-Type': 'application/json', ...(endpoint.headers || {}) };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if ((method === 'GET' || method === 'DELETE') && vars && typeof vars === 'object') {
    const qs = Object.entries(vars)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  let body;
  if (endpoint.bodyTemplate) body = fillTemplate(endpoint.bodyTemplate, { ...vars, apiKey });
  else if (method !== 'GET' && method !== 'DELETE') body = JSON.stringify(vars);
  const res = await rawFetch(url, { method, headers, body }, ctx);
  let parsed = null;
  try { parsed = res.text ? JSON.parse(res.text) : null; } catch { parsed = null; }
  return { status: res.status, headers: res.headers, body: parsed };
}

// ─── 统一图片请求（adapter 们共用；行为 = dispatcher.imageGenerate 的协议/超时/归一骨架）───
// ctx：{ apiKey, payload, provider, model, timeoutMs?, fetch? }；vars：已按家族构造好的线格式请求体
async function generate(ctx, vars) {
  const provider = (ctx && ctx.provider) || {};
  const model = ctx && ctx.model;
  const baseUrl = provider.base_url || '';
  const apiKey = effectiveKey(ctx);
  if (!apiKey) return fail('NO_API_KEY', false, '服务商未配置 API Key');

  const { protocol, endpoint } = resolveEndpoint(provider, model, 'generate');
  try {
    if (protocol === 'custom' && endpoint) {
      // custom protocol：callEndpoint + bodyTemplate + extractImages(imageFieldPath)
      const { status, body } = await customCall(baseUrl, endpoint, apiKey, vars, ctx);
      if (status >= 400) return httpFailure(status, body, null); // dispatcher：custom 分支不传 headers（无 Retry-After）
      const imgs = extractImages(body, endpoint);
      return imgs.length
        ? okResult(imgs)
        : fail('EMPTY_RESPONSE', false, '响应中未找到图片字段');
    }
    // 标准 OpenAI 兼容：POST {base}/images/generations
    const apiUrl = `${baseUrl.replace(/\/+$/, '')}/images/generations`;
    const res = await rawFetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(vars),
    }, ctx);
    let data = null;
    try {
      data = res.text ? JSON.parse(res.text) : null;
    } catch (e) {
      // dispatcher：200 但 JSON 解析失败落外层 catch → 网络错误（瞬时，可重试）
      return fail('NETWORK', true, (e && e.message) || '响应体 JSON 解析失败', { httpStatus: res.status });
    }
    if (!res.ok) return httpFailure(res.status, data, res.headers);
    const imgs = extractImages(data, undefined);
    return imgs.length
      ? okResult(imgs)
      : fail('EMPTY_RESPONSE', false, '响应中无图片数据');
  } catch (e) {
    if (e && e.code === 'TIMEOUT') {
      const ms = (ctx && ctx.timeoutMs) || DEFAULT_TIMEOUT_MS;
      return fail('TIMEOUT', true, `图片生成超时(${Math.round(ms / 1000)}s)`);
    }
    return fail('NETWORK', true, (e && e.message) || String(e));
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  getByPath, sleep, toDataUri, fillTemplate,
  RATIO_TO_SIZE, GPT_IMAGE_RATIO_TO_SIZE, RES_MULTIPLIER,
  bumpSize, gptImageSize, agnesImageSize, openaiImageSize,
  isGptImageModel, clampCount, resolveEndpoint, effectiveKey,
  attachReferenceImages, extractImages, extractErrMsg, parseRetryAfterMs,
  httpFailure, okResult, fail, rawFetch, customCall, generate,
};
