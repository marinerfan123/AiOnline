'use strict';
// 视频 provider 适配层 —— 共享工具
// 所有视频适配器（agnes / minimax / volcano / ...）共用这里的 HTTP、内容构造、状态归一、轮询逻辑。
// 设计目标：新增一家视频供应商 ≈ 1 个薄文件（只做「规范 VideoTask ↔ 线格式」翻译 + submit/poll）。
//
// 规范核心（Canonical VideoTask，与供应商无关）：
//   { prompt, ratio, resolution, durationSec, referenceImages[], negative, videoMode? }
//   videoMode ∈ 't2v' | 'i2v_first' | 'i2v_first_last' | 'reference_image'
//     - 缺省时由 referenceImages 数量推导（0→t2v, 1→i2v_first, 2→i2v_first_last, 3+→reference_image）
//
// 状态归一（canonical enum）：'success' | 'failed' | 'pending'

// ─── 占位符替换（兼容旧 custom 端点 bodyTemplate 用法）───
function fillTemplate(template, vars) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), vars);
    if (v == null) return 'null';
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  });
}

// ─── JSONPath 解析 ──────────────────────────────────
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const tokens = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
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

// ─── HTTP 调用（与 dispatcher.callEndpoint 行为一致；GET/DELETE 把 vars 拼为 query）───
async function callEndpoint(baseUrl, endpoint, apiKey, vars) {
  const effBase = (endpoint && endpoint.baseUrl) || baseUrl;
  let url = `${effBase.replace(/\/+$/, '')}${endpoint.path.startsWith('/') ? endpoint.path : '/' + endpoint.path}`;
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 直接 URL 调用（MiniMax / Volcano 的 submit/poll 用绝对 URL，不走 base+path 拼接）───
async function fetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method,
      headers: h,
      body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 端点解析（模型覆盖 > 服务商默认 > openai-compatible 默认）───
function resolveEndpoint(provider, model, kind) {
  const me = (model && model.endpoint) || {};
  if (me[kind]) return { protocol: me.protocol, endpoint: me[kind] };
  const pe = (provider && (provider.default_endpoint || provider.defaultEndpoint)) || {};
  if (pe[kind]) return { protocol: pe.protocol, endpoint: pe[kind] };
  return { protocol: (provider && provider.protocol) || 'openai-compatible', endpoint: undefined };
}

// ─── 通用错误提取 ──────────────────────────────────
function makeError(body, status, fallback) {
  const errMsg =
    (body && body.error && body.error.message) ||
    (body && body.message) ||
    (typeof body === 'string' ? body.slice(0, 200) : '') ||
    `HTTP ${status}`;
  return { status: 'error', error: `${fallback}：${errMsg}`, images: [], videoUrl: '', rateLimited: status === 429 };
}

// ─── Agnes 视频分辨率（方向正确即可，Agnes 会再标准化）───
const VIDEO_TIER_SCALE = { '1k': 1, '2k': 1.5, '3k': 2, '4k': 2.5 };
function agnesVideoSize(ratio, resolution) {
  const base = (() => {
    switch (ratio) {
      case '16:9': return { width: 1152, height: 648 };
      case '9:16': return { width: 648, height: 1152 };
      case '4:3': return { width: 1024, height: 768 };
      case '3:4': return { width: 768, height: 1024 };
      case '1:1': return { width: 1024, height: 1024 };
      default: return { width: 1024, height: 1024 };
    }
  })();
  const scale = VIDEO_TIER_SCALE[String(resolution || '1k').toLowerCase()] || 1;
  return {
    width: Math.round(base.width * scale),
    height: Math.round(base.height * scale),
  };
}

// ─── 视频模式推导（缺省由参考图数量决定）───
function deriveVideoMode(refs) {
  const n = Array.isArray(refs) ? refs.length : 0;
  if (n === 0) return 't2v';
  if (n === 1) return 'i2v_first';
  if (n === 2) return 'i2v_first_last';
  return 'reference_image';
}

// ─── 多模态 content[] 构造（MiniMax / Volcano 共用 role 词汇，仅字段编码不同）───
// MiniMax：text 用 { type:'text', content }，image 用 { type:'image_url', role, content:url }
// Volcano：text 用 { type:'text', text }，image 用 { type:'image_url', role, image_url:{ url } }
function buildVideoContent(refs, mode, prompt, providerKey) {
  const content = [];
  const imgs = Array.isArray(refs) ? refs : [];
  if (providerKey === 'minimax') {
    content.push({ type: 'text', content: prompt });
    if (mode === 'i2v_first_last' && imgs.length >= 2) {
      content.push({ type: 'image_url', role: 'first_frame', content: imgs[0] });
      content.push({ type: 'image_url', role: 'last_frame', content: imgs[1] });
    } else if (mode === 'reference_image') {
      for (const u of imgs) content.push({ type: 'image_url', role: 'reference_image', content: u });
    } else if (mode === 'i2v_first' || imgs.length >= 1) {
      content.push({ type: 'image_url', role: 'first_frame', content: imgs[0] });
    }
  } else {
    // volcano（默认）
    content.push({ type: 'text', text: prompt });
    if (mode === 'i2v_first_last' && imgs.length >= 2) {
      content.push({ type: 'image_url', role: 'first_frame', image_url: { url: imgs[0] } });
      content.push({ type: 'image_url', role: 'last_frame', image_url: { url: imgs[1] } });
    } else if (mode === 'reference_image') {
      for (const u of imgs) content.push({ type: 'image_url', role: 'reference_image', image_url: { url: u } });
    } else if (mode === 'i2v_first' || imgs.length >= 1) {
      content.push({ type: 'image_url', role: 'first_frame', image_url: { url: imgs[0] } });
    }
  }
  return content;
}

// ─── 状态归一：供应商原始 status → canonical enum ───
function normalizeVideoStatus(raw, _providerKey) {
  const s = String(raw || '').toLowerCase();
  const ok = ['succeeded', 'success', 'succeed', 'done', 'completed'];
  const fail = ['failed', 'error', 'cancelled', 'canceled', 'expired'];
  if (ok.includes(s)) return 'success';
  if (fail.includes(s)) return 'failed';
  return 'pending';
}

// ─── 共享轮询循环：pollFn 返回 { status:'success'|'failed'|'pending', videoUrl?, error? } ───
// 防僵尸安全线：默认 90 分钟。超时**不判失败**（成败只听生成端回复），改返 timeout 交由上层保留待复核。
// isCancelled：可选取消信号回调。返回 true 时立即中止轮询、返回 { status:'canceled' }（不向 provider 继续轮询、不动计费）。
async function pollLoop({ intervalMs = 3000, timeoutMs = 90 * 60 * 1000, pollFn, adaptive = false, startedAt = 0, isCancelled = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  const base = startedAt || Date.now();   // 持久化 startedAt（崩溃恢复接入时传入）→ 重启任务不重置密度；否则用本进程起点
  const wasCancelled = () => typeof isCancelled === 'function' && isCancelled();
  let backoffMs = 0;                       // pollFn 可回传 retryAfterMs 驱动 429/5xx 瞬时退避（下一轮 sleep 下限）
  while (Date.now() < deadline) {
    // 取消信号①：sleep 前（最高频命中，用户取消后下一轮立即退出，避免白等一个 interval）
    if (wasCancelled()) return { videoUrl: '', status: 'canceled', error: '用户已取消' };
    // 自适应轮询密度（主流做法：前期密、后期疏，减少 provider 配额消耗与出网带宽）。
    // 仅作用于后端→provider 层；前端层不随此变疏（前端只查 PG 主键，无 provider 压力）。
    let iv = intervalMs;
    if (adaptive) {
      const elapsed = Date.now() - base;
      if (elapsed < 60_000) iv = intervalMs;                              // 前 1 分钟：基线（5~10s）
      else if (elapsed < 5 * 60_000) iv = Math.max(intervalMs, 15_000);   // 1~5 分钟：≥15s
      else if (elapsed < 15 * 60_000) iv = Math.max(intervalMs, 30_000);  // 5~15 分钟：≥30s
      else iv = Math.max(intervalMs, 60_000);                             // >15 分钟：60s 封顶
    }
    iv = Math.max(iv, backoffMs);          // 429/5xx 退避：不因自适应被压短，封顶由 pollFn 决定
    await sleep(iv);
    backoffMs = 0;                          // 本轮退避已消费
    // 取消信号②：sleep 后立即检查（避免刚睡完还去打 provider）
    if (wasCancelled()) return { videoUrl: '', status: 'canceled', error: '用户已取消' };
    let r;
    try {
      r = await pollFn();
    } catch (e) {
      return { videoUrl: '', status: 'error', error: `轮询异常：${(e && e.message) || String(e)}`.slice(0, 160) };
    }
    // 取消信号③：拿到 provider 回复后再确认一次（防止取消瞬间恰好发出请求）
    if (wasCancelled()) return { videoUrl: '', status: 'canceled', error: '用户已取消' };
    // 429/5xx 瞬时退避：pollFn 回传 retryAfterMs → 下一轮 sleep 至少等这么久（继续轮询，不判失败）
    if (r && typeof r.retryAfterMs === 'number' && r.retryAfterMs > 0) {
      backoffMs = Math.min(Math.ceil(r.retryAfterMs), 300_000);
    }
    // 成功 / 明确的生成端失败 / 瞬时异常 都立即返回（不让 pollLoop 继续空等）。
    // 注意：'failed' 是 provider 任务 definitive 终态（failed/error/canceled），必须作为终态返回，
    // 与瞬时 'error'（网络抖动/提交失败）区分——上层据此立即终态化、绝不切下一个账号空转。
    if (r && (r.status === 'success' || r.status === 'error' || r.status === 'failed')) return r;
    // r.status === 'pending' 或 'timeout' 都继续等生成端回复（不做时间判失败）
  }
  // 超过安全线仍未拿到生成端终态：返回 timeout（**非** error），绝不判失败、不影响计费，上层保留任务待复核。
  return { videoUrl: '', status: 'timeout', error: '等待生成端回复超过安全线（90分钟），任务保留待复核' };
}

module.exports = {
  fillTemplate, getByPath, sleep, callEndpoint, fetchJson, resolveEndpoint, makeError,
  agnesVideoSize, deriveVideoMode, buildVideoContent, normalizeVideoStatus, pollLoop,
};
