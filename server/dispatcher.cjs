'use strict';
// 服务端生成分发器
const crypto = require('crypto');
const billing = require('./billing.cjs'); // Phase A 计费（reserve/commit/release）
const accounting = require('./accounting.cjs'); // 全局双边账务：generate 真实消耗走账
const videoRouter = require('./providers/video/index.cjs'); // 视频 provider 适配层（agnes/minimax/volcano/generic 路由）
const { pollLoop } = require('./providers/video/shared.cjs'); // 共享自适应轮询循环（供 generic 续轮询与崩溃恢复复用）
const realtime = require('./realtime.cjs'); // 生成任务实时通道（SSE）：终态切换时通知前端，替代前端固定轮询
// ModelHub V3 Phase 1 — 唯一模型身份 resolver（收敛 display_name / model_id 归一逻辑，dispatcher 内不再散落处理 display_name）
const { resolveModelIdentity } = require('./modules/modelhub/resolver.cjs');
// ModelHub V3 Phase 2 — 逻辑模型 × 服务商 线路绑定读取层（优先读 bindings，双读回退 models.provider_id）
const { loadDispatchPairs } = require('./modules/modelhub/bindings.cjs');
// ModelHub V3 — 智能路由尝试数据落地（generation_jobs / generation_attempts）：双写，best-effort 不阻断生成
const { makeJobRecorder, NULL_RECORDER, recordResumeJob } = require('./modules/modelhub/jobs.cjs');
const router = require('./modules/modelhub/router.cjs'); // Phase 3.4 确定性智能路由（纯函数，非阻断接入）
const assetFinalize = require('./assetFinalize.cjs'); // Phase 1 主流化：服务端最终化 provider 资源到 OSS + 写 media（替代前端 processResultImages）
const uploadQueue = require('./uploadQueue.cjs'); // 搬运与 API 解耦：终态上传移出请求/SSE 关键路径，后台队列异步搬
const rateLimit = require('./rateLimitRedis.cjs'); // Redis 共享限流（多 worker/多实例安全，#360 解法）
const cpuMonitor = require('./cpuMonitor.cjs'); // CPU 自适应负载降级（80% 阈值进入 SHED，返 503）

// ─── 日志总线注入（由 server.js 启动时 setLogSink(logbus) 注入）───
// 生成失败 / 异常必须落到后台「核心错误日志 + 实时监控」(logbus.emit('ERROR') → syslog 持久化 + SSE 广播)，
// 解决「前台出图失败后端没有任何反映、监控没做到位」的问题。
let logSink = null;
function setLogSink(sink) { logSink = sink; }
function logError(source, message, meta) {
  if (logSink && typeof logSink.emit === 'function') {
    try { logSink.emit('ERROR', source, message, meta || null); } catch (_) { /* 日志失败绝不应影响主链路 */ }
  }
}
// 负责：按 model_id 找到所有已启用的「模型行 × 服务商」组合，
// 在「全局最大并发 maxThreads」+「每家服务商 max_concurrent」约束下，
// round-robin 把 N 个生成请求均衡分配到不同服务商。
// 协议兼容 OpenAI-compatible 默认接口 + 自定义 endpoint（与前端 genericClient 对齐）。

// ─── 全局并发状态（跨请求共享，实现真正全局信号量）───
let GLOBAL_ACTIVE = 0;
let GLOBAL_MAX = 10;

// ── 智能路由（Phase 3.4，非阻断接入）──
// 路由算法本身是纯函数（router.cjs）；这里只持有可热改的权重与指标缓存。
// 任何路由异常都不得阻断生成主链路——失败即退化为「按实时态排序」的原始行为。
let ROUTING_WEIGHTS = router.DEFAULT_WEIGHTS;
// 评分路由总开关（kill-switch）：false → dispatchOne 退化为原始顺序（Phase 3.4 之前行为），可回退。
// 默认开启；可用 env ROUTING_V3_ENABLED=false 关闭，或由 settings.app.routingV3Enabled 运行时热改。
let ROUTING_V3_ENABLED = process.env.ROUTING_V3_ENABLED !== 'false';
const metricsCache = { at: 0, map: null };
const METRICS_TTL_MS = 30000;

// ─── 取消信号集合（内存态）：cancelTask 写入，轮询循环读，命中即停止轮询 ───
// 注意：这是「停止轮询」的快速信号；权威终态（释放积分 / 标记 canceled / 推送 SSE）由 cancelTask 执行。
// 进程重启后该集合清空（已落库 canceled 的任务由崩溃恢复逻辑跳过/保留），不影响功能正确性。
const cancelledTasks = new Set();

// ─── 统一共享 B 桶调度（方向 A 受限账号）/ unlimited（方向 B 普通付费）───
// 单实例内存态（PM2 必须 instances:1，见 deploy/ecosystem.config.cjs）。
// 多实例横向扩展需把 ACCT 状态迁至 Redis（deployment-plan.md §6）。
const ACCT = {};
const DEFAULT_BUCKET = 20;                              // 默认 B：每账号每 60s 可用 B 个「单位」
const DEFAULT_OP_COST = { '1k': 1, '2k': 2, '4k': 20, 'video': 20 }; // 各操作消耗单位（cap=floor(B/cost)）
const DEFAULT_RPM = { '1k': 20, '2k': 10, '4k': 1, '8k': 1 };        // 仅旧格式 {RPM上限} 归一用
const DEFAULT_COOLDOWN_MS = 60000;                     // 整账号冷却默认 60s（可调）
const ACCOUNT_CONC_CAP = 4;                            // 单账号并发硬上限（与 provider.max_concurrent 取小）
const MAX_RETRY = 3;                                   // 单任务「全部账号不可用」时的最多重试（无感切换）
const KEY_ROTATE_MAX = 4;                              // 多 key 池 429 时池内换 key 重试上限（解锁聚合吞吐，同时防止系统性限流时狂打 N 次计费调用）
const KEY_429_COOLDOWN_MS = 60000;                     // 单把 key 收到 429 后的冷却（匹配上游 1 请求/分钟，避免立即重选打爆）

// ─── 多 Key 池（同一供应商多把 API Key，各自独立参与生成分配）───
// AKEYS[pid] = Map<keyId, keyState>；keyState 持有 per-key 运行时态（并发/失败/CB），持久于内存跨请求。
// DB 的 api_keys 表是成员与 status 的权威源；syncKeyPool 每次请求从 DB 对账，但保留运行时计数（不重置）。
const AKEYS = {};
// 每 key 并发上限 = provider.max_concurrent（默认 2）；总容量随 key 数线性扩展（aggregate cap = perKeyCap × activeKeyCount）
const KEY_STATUS_ACTIVE = 'active';

// 从 DB 行对账某 provider 的 key 池到内存态：新增 key 初始化运行时态；保留已有 key 的计数（不重置）；
// DB 中已删除的 key 同步移除（释放运行时态）。
function syncKeyPool(pid, dbRows) {
  let m = AKEYS[pid];
  if (!m) { m = new Map(); AKEYS[pid] = m; }
  const freshIds = new Set();
  for (const r of (dbRows || [])) {
    freshIds.add(r.id);
    const existing = m.get(r.id);
    if (existing) {
      existing.apiKey = r.api_key;
      existing.status = r.status || KEY_STATUS_ACTIVE;
      existing.weight = (typeof r.weight === 'number' && r.weight > 0) ? r.weight : 1;
    } else {
      m.set(r.id, {
        id: r.id, apiKey: r.api_key, status: r.status || KEY_STATUS_ACTIVE,
        weight: (typeof r.weight === 'number' && r.weight > 0) ? r.weight : 1,
        conc: 0, consecutiveFailures: 0, lastUsedAt: 0, lastFailureAt: 0, cooldownUntil: 0,
        cbState: router.cbInitState(),
      });
    }
  }
  for (const id of [...m.keys()]) if (!freshIds.has(id)) m.delete(id);
  return m;
}

// 热刷新：清空某 provider（或全部）的 key 运行时态，下次请求重新从 DB 对账（立即生效新增/隔离/启用）。
function invalidateProviderKeyCache(pid) {
  if (pid) { delete AKEYS[pid]; }
  else { for (const k of Object.keys(AKEYS)) delete AKEYS[k]; }
}

// 单把 key 收到 429 后的短期冷却：尊重上游 Retry-After（若有），否则默认 KEY_429_COOLDOWN_MS。
// 与整账号冷却（markReject / ACCT.cooldownUntil）解耦——多 key 池下只冷却这一把，不波及池内其他 key，
// 由 pickKey 在选 key 时跳过冷却中的 key，从而「自然轮换」到下一把可用 key（限流感知密钥池的核心）。
function cooldownKey(ks, now, retryAfterMs) {
  if (!ks) return;
  const ms = (typeof retryAfterMs === 'number' && retryAfterMs > 0) ? retryAfterMs : KEY_429_COOLDOWN_MS;
  ks.cooldownUntil = now + ms;
}

// 从池中按「最少最近使用（lastUsedAt ASC）」轮转选一把可用 key：
// active 且 未冷却(cooldownUntil) 且 CB 准入 且 并发未达 keyConcCap。无可用 key 返回 null。
function pickKey(pid, now, keyConcCap) {
  const m = AKEYS[pid];
  if (!m || m.size === 0) return null;
  const cands = [];
  for (const ks of m.values()) {
    if (ks.status !== KEY_STATUS_ACTIVE) continue;     // 隔离/禁用跳过
    if (ks.cooldownUntil && now < ks.cooldownUntil) continue;  // 该 key 429 冷却中，跳过（不让重选打爆）
    let cbAdm;
    try { cbAdm = router.cbAdmit(ks.cbState, now); } catch (e) { cbAdm = { admit: true, state: ks.cbState }; }
    ks.cbState = cbAdm.state;
    if (!cbAdm.admit) continue;                        // 该 key 熔断隔离（CB OPEN/HALF_OPEN 额度耗尽）
    if (ks.conc >= keyConcCap) continue;               // 单 key 并发满
    cands.push(ks);
  }
  if (cands.length === 0) return null;
  cands.sort((x, y) => (x.lastUsedAt || 0) - (y.lastUsedAt || 0));
  return cands[0];
}

// 暴露每 key 运行时态给监控/管理接口（与 DB 的 label/status 合并展示）。
function getKeyStates(pid) {
  const m = AKEYS[pid];
  if (!m) return [];
  return [...m.values()].map((ks) => ({
    id: ks.id, status: ks.status, conc: ks.conc, consecutiveFailures: ks.consecutiveFailures,
    lastUsedAt: ks.lastUsedAt ? new Date(ks.lastUsedAt).toISOString() : null,
    cbState: ks.cbState ? ks.cbState.state : null,
  }));
}

// ─── 占位符替换 ─────────────────────────────────────
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

// ─── HTTP 调用 ──────────────────────────────────────
async function callEndpoint(baseUrl, endpoint, apiKey, vars) {
  // 允许端点单独覆盖 baseUrl（如 Agnes 视频轮询在根域 /agnesapi，而提交在 /v1 下）
  const effBase = (endpoint && endpoint.baseUrl) || baseUrl;
  let url = `${effBase.replace(/\/+$/, '')}${endpoint.path.startsWith('/') ? endpoint.path : '/' + endpoint.path}`;
  const method = endpoint.method || 'POST';
  const headers = { 'Content-Type': 'application/json', ...(endpoint.headers || {}) };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  // GET/DELETE：把 vars 作为查询参数拼到 URL（轮询类端点常用，如 video_id=xxx）
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

// ─── 端点解析（模型覆盖 > 服务商默认 > OpenAI 兼容默认）───
function resolveEndpoint(provider, model, kind) {
  const me = model.endpoint || {};
  if (me[kind]) return { protocol: me.protocol, endpoint: me[kind] };
  const pe = provider.default_endpoint || {};
  if (pe[kind]) return { protocol: pe.protocol, endpoint: pe[kind] };
  return { protocol: provider.protocol || 'openai-compatible', endpoint: undefined };
}

// ─── 图片生成 ──────────────────────────────────────
const RATIO_TO_SIZE = { '16:9': '1792x1024', '4:3': '1024x768', '1:1': '1024x1024', '3:4': '768x1024', '9:16': '1024x1792' };
// OpenAI GPT Image 系列（gpt-image-1 / gpt-image-2 / gpt-image-1.5）支持的 size 枚举与 DALL-E 3 不同。
// 官方有效值：auto / 1024x1024 / 1536x1024（横向 16:9） / 1024x1536（纵向 9:16）。
// 其余比例回退到 auto，由模型按提示词自动决定画幅。
const GPT_IMAGE_RATIO_TO_SIZE = { '1:1': '1024x1024', '16:9': '1536x1024', '9:16': '1024x1536', 'auto': 'auto' };
const RES_MULTIPLIER = { '1k': 1, '2k': 2, '4k': 4, '8k': 8 };

function bumpSize(size, res) {
  const mul = RES_MULTIPLIER[res] || 1;
  if (mul === 1) return size;
  const [w, h] = size.split('x').map(Number);
  return `${w * mul}x${h * mul}`;
}

function isGptImageModel(model) {
  if (!model) return false;
  const name = (model.upstreamModelName || model.model_id || model.model || '').toLowerCase();
  return /gpt-image/i.test(name);
}

async function imageGenerate(provider, model, opts, apiKeyOverride) {
  const { prompt, ratio, resolution, count, referenceImages, negative } = opts;
  const baseUrl = provider.base_url;
  const apiKey = (apiKeyOverride && apiKeyOverride.length >= 6) ? apiKeyOverride : provider.api_key;
  if (!apiKey) return { images: [], status: 'error', error: '服务商未配置 API Key' };

  const isAgnes = /agnes-ai\.cn/i.test(baseUrl || '');
  const isGptImage = isGptImageModel(model);
  const de = provider.default_endpoint || {};
  const me = (model && model.endpoint) || {};
  const sizeFormat = me.sizeFormat || de.sizeFormat || (isAgnes ? 'agnes' : 'openai');
  const img2imgInExtraBody = (me.img2imgInExtraBody != null ? me.img2imgInExtraBody
    : (de.img2imgInExtraBody != null ? de.img2imgInExtraBody : isAgnes));

  const hasImages = Array.isArray(referenceImages) && referenceImages.length > 0;
  let size;
  if (isGptImage) {
    size = GPT_IMAGE_RATIO_TO_SIZE[ratio] || GPT_IMAGE_RATIO_TO_SIZE.auto;
  } else if (sizeFormat === 'agnes') {
    size = String(resolution || '1k').toUpperCase();
  } else {
    size = bumpSize(RATIO_TO_SIZE[ratio] || '1024x1024', resolution);
  }

  const vars = {
    model: model.upstreamModelName || model.model_id, // Phase 2：上游 wire name 取自 binding（兜底 model_id）
    prompt,
    n: Math.max(1, Math.min(4, count || 1)),
    size,
  };
  // OpenAI GPT Image 官方端点不识别 ratio / resolution / negative_prompt；
  // 传这些字段会被官方忽略，但严格的中转站可能报错。DALL-E 3 / SD / 自定义端点才需要它们。
  if (!isGptImage) {
    vars.ratio = ratio;
    if (sizeFormat !== 'agnes') {
      vars.resolution = resolution;
    }
    // 反向提示词（正负向搭配刚需）：SD/自定义端点支持 negative_prompt 字段；
    // agnes 图像端点规范不含此字段，跳过以免其严格校验报错（negative 仍存库，UI 完整展示）。
    if (sizeFormat !== 'agnes' && negative) {
      vars.negative_prompt = negative;
    }
  }
  // 图生图/多图合成：Agnes 等要求把参考图放到 extra_body.image；
  // 同时保留顶层 images 兼容 relay / 自定义端点。
  if (hasImages) {
    vars.images = referenceImages;
    if (img2imgInExtraBody) {
      vars.extra_body = { image: referenceImages, response_format: 'url' };
    }
  }

  const { protocol, endpoint } = resolveEndpoint(provider, model, 'generate');
  try {
    if (protocol === 'custom' && endpoint) {
      const { status, body } = await callEndpoint(baseUrl, endpoint, apiKey, vars);
      if (status >= 400) return makeError(body, status, '图片生成失败');
      const imgs = extractImages(body, endpoint);
      return imgs.length
        ? { images: imgs, status: 'success' }
        : { images: [], status: 'error', error: '响应中未找到图片字段' };
    }
    const apiUrl = `${baseUrl.replace(/\/$/, '')}/images/generations`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(vars),
        signal: ctrl.signal,
      });
    } catch (fe) {
      clearTimeout(timer);
      const aborted = fe && (fe.name === 'AbortError' || /abort/i.test(fe.message || ''));
      return { images: [], status: 'error', error: (aborted ? '图片生成超时(60s)' : `网络错误：${(fe && fe.message) || String(fe)}`).slice(0, 120) };
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) return makeError(data, response.status, '图片生成失败', response.headers);
    const imgs = extractImages(data, undefined);
    return imgs.length
      ? { images: imgs, status: 'success' }
      : { images: [], status: 'error', error: '响应中无图片数据' };
  } catch (e) {
    return { images: [], status: 'error', error: `网络错误：${(e && e.message) || String(e)}`.slice(0, 120) };
  }
}

// ─── 视频生成（异步 submit + poll 模式）───
// 路由：非 generic 供应商（agnes/minimax/volcano）走统一 provider 适配层（server/providers/video）；
//      generic（openai-compatible / custom bodyTemplate 视频端点）走下方内联实现（保持历史行为）。
async function videoGenerate(provider, model, opts) {
  const key = videoRouter.resolveKey(provider, model);
  if (key !== 'generic') {
    // 已拆分 submit/poll：先提交拿 provider task id，立即持久化（崩溃恢复地基），再续轮询。
    const s = await videoRouter.submit(provider, model, opts);
    if (s.status !== 'submitted') return s; // 提交阶段即错，直接透传 error
    if (opts.onSubmitted) {
      try {
        await opts.onSubmitted({ providerTaskId: s.providerTaskId, providerKey: key, providerId: provider.id, modelId: model.model_id });
      } catch (e) { console.warn('[videoGenerate] onSubmitted 持久化失败:', e.message); }
    }
    return videoRouter.poll(provider, model, s.taskId, 0, () => cancelledTasks.has(opts.taskId));
  }

  const { prompt, ratio, durationSec, referenceImages, negative, resolution } = opts;
  const baseUrl = provider.base_url;
  const apiKey = provider.api_key;
  if (!apiKey) return { videoUrl: '', status: 'error', error: '服务商未配置 API Key' };

  const vars = {
    model: model.upstreamModelName || model.model_id, // Phase 2：上游 wire name 取自 binding（兜底 model_id）
    prompt,
    ratio,
    resolution: resolution || '1k',
    duration: durationSec || 6,
    firstFrame: referenceImages && referenceImages[0] ? referenceImages[0] : '',
    images: referenceImages || [],
  };
  // 反向提示词：custom 端点经 fillTemplate 的 {{negative}}/{{negative_prompt}} 占位替换生效；
  // 标准视频端点忽略未知字段。最终仍写入 generation_tasks.payload 与 media，UI 完整展示。
  if (negative) { vars.negative = negative; vars.negative_prompt = negative; }

  const { protocol, endpoint } = resolveEndpoint(provider, model, 'generate');
  const isAsync = !!(provider.default_endpoint && provider.default_endpoint.async) ||
    !!(model.endpoint && model.endpoint.async) || protocol === 'custom';

  try {
    if (isAsync && endpoint) {
      const { status, body } = await callEndpoint(baseUrl, endpoint, apiKey, vars);
      if (status >= 400) return makeError(body, status, '视频任务提交失败');
      const taskId = String(getByPath(body, (endpoint.taskIdPath) || 'data.task_id') ?? '');
      if (!taskId) return { videoUrl: '', status: 'error', error: '未返回任务 ID（taskIdPath 配置？）' };
      // 提交成功：立即持久化 provider task id（崩溃恢复地基）
      if (opts.onSubmitted) {
        try {
          await opts.onSubmitted({ providerTaskId: taskId, providerKey: 'generic', providerId: provider.id, modelId: model.model_id });
        } catch (e) { console.warn('[videoGenerate] onSubmitted 持久化失败:', e.message); }
      }
      const pollEp = resolveEndpoint(provider, model, 'poll').endpoint;
      if (!pollEp) return { videoUrl: '', status: 'error', error: '未配置 poll 端点（异步任务需轮询）' };
      // 轮询查询参数名可配置（Agnes 用 video_id，通用用 task_id）
      const pollQueryParam = (pollEp && pollEp.taskQueryParam) || 'task_id';
      const deadline = Date.now() + 90 * 60 * 1000;          // 安全线（仅防僵尸）：与 pollLoop 一致 90 分钟；绝不据此判失败
      const pollStart = Date.now();
      const baseIv = (pollEp && pollEp.taskPollIntervalMs) || 3000;
      while (Date.now() < deadline) {
        // 取消信号：用户已取消则立即停轮询（不向 provider 继续打），返回 canceled 交由上层释放积分
        if (cancelledTasks.has(opts.taskId)) return { videoUrl: '', status: 'canceled', error: '用户已取消' };
        // 自适应轮询密度（与 pollLoop 一致：前期密后期疏，减少 provider 配额消耗）
        const elapsed = Date.now() - pollStart;
        const iv = elapsed < 60_000 ? baseIv
          : elapsed < 5 * 60_000 ? Math.max(baseIv, 15_000)
          : elapsed < 15 * 60_000 ? Math.max(baseIv, 30_000)
          : Math.max(baseIv, 60_000);
        await sleep(iv);
        // 取消信号②：sleep 后再次确认，避免刚睡完还去打 provider
        if (cancelledTasks.has(opts.taskId)) return { videoUrl: '', status: 'canceled', error: '用户已取消' };
        const r = await callEndpoint(baseUrl, pollEp, apiKey, { [pollQueryParam]: taskId });
        const st = String(getByPath(r.body, pollEp.taskStatusPath || 'data.status') ?? '').toLowerCase();
        const okVals = (pollEp.taskSuccessValues || ['succeeded', 'success', 'done', 'completed']).map((s) => s.toLowerCase());
        if (okVals.includes(st)) {
          const url = String(getByPath(r.body, pollEp.taskResultPath || 'data.video_url') ?? '');
          return url ? { videoUrl: url, status: 'success' } : { videoUrl: '', status: 'error', error: '任务成功但未返回视频 URL（taskResultPath？）' };
        }
        // 生成端明确终态失败 → terminal 'failed'（区别于瞬时 'error'），上层立即终态化、不空转切下一个账号。
        if (st === 'failed' || st === 'error' || st === 'canceled') return { videoUrl: '', status: 'failed', error: `视频生成失败：${JSON.stringify(r.body).slice(0, 160)}` };
      }
      // 超过安全线仍未拿到生成端终态：返回 timeout（**非** error），绝不判失败、不影响计费，上层保留任务待复核。
      return { videoUrl: '', status: 'timeout', error: '等待生成端回复超过安全线（90分钟），任务保留待复核' };
    }
    const { status, body } = await callEndpoint(baseUrl, endpoint, apiKey, vars);
    if (status >= 400) return makeError(body, status, '视频生成失败');
    const url = String(getByPath(body, (endpoint && endpoint.videoFieldPath) || 'data.video_url') ?? '');
    return url ? { videoUrl: url, status: 'success' } : { videoUrl: '', status: 'error', error: '响应中未找到视频 URL' };
  } catch (e) {
    return { videoUrl: '', status: 'error', error: `网络错误：${(e && e.message) || String(e)}`.slice(0, 120) };
  }
}

// ─── helpers ───────────────────────────────────────
// generic 视频续轮询（与服务商适配层对齐的自适应密度）：仅供崩溃恢复 resume 复用，
// 因 provider 任务已提交（provider_task_id 已持久化），只需按 taskId 重建轮询端点。
// isCancelled：可选取消信号（dispatcher 注入 cancelledTasks 检查），命中即停止轮询。
async function genericVideoPoll(provider, model, taskId, startedAt = 0, isCancelled = null) {
  const { protocol, endpoint } = resolveEndpoint(provider, model, 'generate');
  const baseUrl = provider.base_url;
  const apiKey = provider.api_key;
  const isAsync = !!(provider.default_endpoint && provider.default_endpoint.async) ||
    !!(model.endpoint && model.endpoint.async) || protocol === 'custom';
  const pollEp = resolveEndpoint(provider, model, 'poll').endpoint;
  if (!isAsync || !pollEp) return { videoUrl: '', status: 'error', error: 'generic 非异步任务无需轮询' };
  const pollQueryParam = (pollEp && pollEp.taskQueryParam) || 'task_id';
  return pollLoop({
    intervalMs: (pollEp && pollEp.taskPollIntervalMs) || 3000, adaptive: true, startedAt, isCancelled,
    pollFn: async () => {
      const r = await callEndpoint(baseUrl, pollEp, apiKey, { [pollQueryParam]: taskId });
      const st = String(getByPath(r.body, pollEp.taskStatusPath || 'data.status') ?? '').toLowerCase();
      const okVals = (pollEp.taskSuccessValues || ['succeeded', 'success', 'done', 'completed']).map((s) => s.toLowerCase());
      if (okVals.includes(st)) {
        const url = String(getByPath(r.body, pollEp.taskResultPath || 'data.video_url') ?? '');
        return url ? { videoUrl: url, status: 'success' } : { videoUrl: '', status: 'error', error: '任务成功但未返回视频 URL（taskResultPath？）' };
      }
      // 生成端明确终态失败 → terminal 'failed'（区别于瞬时 'error'），上层立即终态化、不空转切下一个账号。
      if (st === 'failed' || st === 'error' || st === 'canceled') return { videoUrl: '', status: 'failed', error: `视频生成失败：${JSON.stringify(r.body).slice(0, 160)}` };
      return { videoUrl: '', status: 'pending' };
    },
  });
}

function toDataUri(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://')) return s;
  // provider 返回的 b64_json 是裸 base64，必须包装成 data URI 才能作为 img.src / 持久化 URL 使用
  return `data:image/png;base64,${s}`;
}

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

// 解析上游 Retry-After / x-ratelimit-reset 头 → 毫秒；钳制 [1s, 10min]，避免极端值把 key 冷却过久。
function parseRetryAfterMs(headers) {
  if (!headers) return undefined;
  const raw = (headers.get && headers.get('retry-after')) || (headers.get && headers.get('x-ratelimit-reset'));
  if (!raw) return undefined;
  const n = Number(raw);
  if (!isNaN(n)) return Math.min(600000, Math.max(1000, n * 1000));
  const d = Date.parse(raw);
  if (!isNaN(d)) return Math.min(600000, Math.max(1000, d - Date.now()));
  return undefined;
}

function makeError(body, status, fallback, headers) {
  const errMsg =
    (body && body.error && body.error.message) ||
    (body && body.message) ||
    (typeof body === 'string' ? body.slice(0, 200) : '') ||
    `HTTP ${status}`;
  const retryAfterMs = status === 429 ? parseRetryAfterMs(headers) : undefined;
  return { status: 'error', error: `${fallback}：${errMsg}`, images: [], videoUrl: '', rateLimited: status === 429, retryAfterMs };
}

// ─── 统一共享 B 桶调度 ─────────────────────────────
// 旧格式 rate_limits = {"1k":20,"2k":10,"4k":1}（值为每分钟上限 RPM）。
// 新格式 rate_limits = { bucket_units_per_min:B, ops:{1k,2k,4k,video}, manual_state? }
//   · ops 的值是「每次操作消耗的单位数」，cap[op] = floor(B / cost[op])
//   · 所有操作（1k/2k/4k/video）从同一桶扣 → 单账号额度共享
//   · manual_state('hot'|'cold')：管理员手动强切（持久化到 rate_limits JSONB，随库恢复）
function normalizeRateLimits(rl) {
  if (rl && typeof rl === 'object' && rl.ops && typeof rl.bucket_units_per_min === 'number') {
    const out = { bucket_units_per_min: rl.bucket_units_per_min, ops: { ...DEFAULT_OP_COST, ...rl.ops } };
    if (rl.manual_state) out.manual_state = rl.manual_state;
    return out;
  }
  // 旧格式：值是各分辨率 RPM 上限 → 归一为成本（cost = B / cap）
  const old = (rl && typeof rl === 'object') ? rl : {};
  const B = (typeof old['1k'] === 'number' && old['1k'] > 0) ? old['1k'] : DEFAULT_BUCKET;
  const ops = {};
  for (const t of ['1k', '2k', '4k', 'video']) {
    const cap = (typeof old[t] === 'number' && old[t] > 0)
      ? old[t]
      : (t === '1k' ? DEFAULT_RPM['1k'] : t === '2k' ? DEFAULT_RPM['2k'] : DEFAULT_RPM['4k']);
    ops[t] = Math.max(1, Math.round(B / cap));
  }
  return { bucket_units_per_min: B, ops };
}

function costFor(a, tier) {
  const c = a.ops && a.ops[tier];
  return (typeof c === 'number' && c > 0) ? c : (DEFAULT_OP_COST[tier] || 1);
}

function getAcct(pid, provider) {
  if (!ACCT[pid]) {
    const norm = normalizeRateLimits(provider && provider.rate_limits);
    ACCT[pid] = {
      bucketB: norm.bucket_units_per_min,
      ops: norm.ops,
      manualState: norm.manual_state || null,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      bucket: { cap: norm.bucket_units_per_min, tokens: norm.bucket_units_per_min, last: Date.now() },
      conc: 0,
      cooldownUntil: 0,
      consecutiveRejects: 0,
      cbState: router.cbInitState(),   // Circuit Breaker 状态机（Phase 3.5）：CLOSED / OPEN / HALF_OPEN
      capacityModel: (provider && provider.capacity_model === 'unlimited') ? 'unlimited' : 'limited',
    };
  }
  const a = ACCT[pid];
  // 热改生效：DB 改 rate_limits / capacity_model / cooldown_ms 立即同步（不重置桶余额）
  if (provider) {
    const norm = normalizeRateLimits(provider.rate_limits);
    a.bucketB = norm.bucket_units_per_min;
    a.ops = norm.ops;
    a.manualState = norm.manual_state || null;
    a.bucket.cap = norm.bucket_units_per_min;
    if (provider.capacity_model) a.capacityModel = (provider.capacity_model === 'unlimited') ? 'unlimited' : 'limited';
    if (typeof provider.cooldown_ms === 'number' && provider.cooldown_ms > 0) a.cooldownMs = provider.cooldown_ms;
  }
  return a;
}

// 令牌桶按时间回流：B 个令牌 / 60 秒
function refillAccount(a, now) {
  const dt = (now - a.bucket.last) / 1000;
  if (dt > 0) a.bucket.tokens = Math.min(a.bucket.cap, a.bucket.tokens + dt * (a.bucket.cap / 60));
  a.bucket.last = now;
}

function isCold(a, now) {
  if (a.manualState === 'cold') return true;
  if (a.manualState === 'hot') return false;
  return now < a.cooldownUntil;
}

// 瞬时错误识别：网络抖动 / 超时 / 5xx / 429 限流 → 可重试吸收偶发失败（治"时好时坏"）；
// 确定性错误（响应中无图片字段、鉴权失败、参数错）不重试，避免无谓重试放大故障。
function isTransient(err) {
  if (!err) return false;
  // 注意：429 / 限流 不在此列 —— 429 由 attemptOnAccount 的 rateLimited 分支（外层 while 池内轮换）统一处理；
  // 若此处也把 429 当瞬时错重试，会与外层轮换「双重计数」→ 单 429 被放大成多次计费调用（10 次扣费事故根因之一）。
  return /网络错误|timeout|timed out|ETIMEDOUT|ECONN|socket|hang up|abort|5\d\d|upstream|bad gateway|gateway timeout|service unavailable/i.test(err);
}

// 拒单：切下一个供应商、不扣费、不返错；首次拒单即冷，连续 3 拒也冷（双路径，任一即冷却）
function markReject(a, now) {
  a.consecutiveRejects += 1;
  a.cooldownUntil = now + (a.cooldownMs || DEFAULT_COOLDOWN_MS);
  // Circuit Breaker（Phase 3.5，非阻断）：记录一次失败驱动状态机；异常绝不阻断主链路
  try {
    a.cbState = router.cbRecordOutcome(a.cbState, 'failure', now);
  } catch (e) { /* 熔断逻辑异常不影响生成 */ }
}

// ── Redis 共享限流接入（#360 解法）──
// 本地 GLOBAL_ACTIVE / a.conc / a.bucket 仍维护（监控展示 + Redis 降级兜底）；
// Redis 层为跨进程权威闸：全局并发 + per-provider 并发(ZSET 租约) + per-provider RPM 令牌桶(Lua)。
// 返回 rl 句柄（含 slot id），任一闸不满足返回 null（上层切下一个账号）。
async function acquireRateLimitSlots(p, cost, multiKey, a, aggCap, now) {
  let bucketCharged = false;
  if (!multiKey && a.capacityModel !== 'unlimited') {
    const ok = await rateLimit.tryProviderBucket(p.provider.id, cost, a.bucket.cap, now);
    if (!ok) { markReject(a, now); return null; } // 桶空 → 拒单（与旧语义一致）
    bucketCharged = true;
  }
  const provConcId = await rateLimit.incrProviderConc(p.provider.id, aggCap);
  if (!provConcId) { if (bucketCharged) rateLimit.refundProviderBucket(p.provider.id, cost, a.bucket.cap); return null; }
  const globalId = await rateLimit.acquireGlobalSlot(GLOBAL_MAX);
  if (!globalId) {
    rateLimit.decProviderConc(p.provider.id, provConcId);
    if (bucketCharged) rateLimit.refundProviderBucket(p.provider.id, cost, a.bucket.cap);
    return null;
  }
  return { globalId, provConcId, bucketCharged };
}

// 在单个账号上尝试一次生成；账号不可用（冷却/桶空/并发满）或失败（429/异常）返回 null（上层切下一个）
async function attemptOnAccount(p, tier, input, contentType, recorder) {
  const now = Date.now();
  const a = getAcct(p.provider.id, p.provider);
  // 管理员手动隔离（不论单 key / 多 key 池都生效：硬隔离整个服务商）
  if (a.manualState === 'cold') return null;
  // 多 Key 池判定：multi-key 下彻底跳过 legacy 桶/冷却/CB
  // ——legacy 桶 (bucket_units_per_min=20) 与单 key CB 是「单 key 时代」的限流器，与「475 把 key 各自独立」语义冲突；
  // per-key CB + 每 key 并发上限 已经接管单个 key 的故障隔离，无需再被单账号共享桶/熔断二次拦截。
  const _poolEarly = AKEYS[p.provider.id];
  const _multiKey = !!(_poolEarly && _poolEarly.size > 1);
  // 始终计算 cost：recorder 记录 attempt 成本始终需要；legacy 令牌桶占用仅在单 key 路径生效（多 key 池彻底跳过）
  const cost = costFor(a, tier);
  if (!_multiKey) {
    // Circuit Breaker 权威准入（Phase 3.5，非阻断）：OPEN 冷却中 / HALF_OPEN 探测额度耗尽 → 隔离，绝不发请求
    let cbAdm;
    try { cbAdm = router.cbAdmit(a.cbState, now); } catch (e) { cbAdm = { admit: true, state: a.cbState || null }; }
    a.cbState = cbAdm.state;
    if (!cbAdm.admit) return null;   // 熔断隔离：不扣令牌、不占并发、不记 attempt（解决「一直打/一直失败/一直扣资源」）
    // 仅 CLOSED 态套用 legacy 短冷却作为补充背压（防单点抖动放大）；OPEN/HALF_OPEN 由 CB 全权裁决
    if (a.cbState.state === 'CLOSED' && isCold(a, now)) return null;
    refillAccount(a, now);
    if (a.capacityModel !== 'unlimited' && a.bucket.tokens < cost) { markReject(a, now); return null; } // 共享桶空 → 拒单（未请求）
  }
  // per-model 并发覆盖：模型自身设了 max_concurrent（非 null 正数）则优先用，否则回退服务商默认
  const modelConc = (p.model && typeof p.model.max_concurrent === 'number' && p.model.max_concurrent > 0) ? p.model.max_concurrent : null;
  const keyConcCap = modelConc ?? (Number(p.provider.max_concurrent) || 2);
  // 多 Key 池：总并发上限随可用 key 数扩展（aggregate cap = perKeyCap × activeKeyCount）；单 key 行为与旧版一致
  const pool = AKEYS[p.provider.id];
  const poolExists = !!(pool && pool.size > 0);
  const activeKeyCount = poolExists ? pool.size : 1;
  const aggCap = Math.max(keyConcCap, keyConcCap * activeKeyCount); // 多 key → 容量线性扩展
  // ── 选 key：优先池内轮转；池为空（legacy）回退 providers.api_key；池存在但全不可用 → 本账号不可用 ──
  const selKey = poolExists ? pickKey(p.provider.id, now, keyConcCap) : null;
  // 原子占位：选 key 即同步占用其并发槽（不等下方 await），否则并行子任务会在 await 窗口内选到同一把 key。
  // agnes 等「1 图/key/5min」限流服务商，同一 key 并发多发只会 429，批量生成退化为串行出图——这是根治点。
  if (selKey) { selKey.conc += 1; selKey.lastUsedAt = now; }
  const multiKey = poolExists && pool.size > 1;
  const effectiveApiKey = selKey ? selKey.apiKey : (poolExists ? '' : (p.provider.api_key || ''));
  if (!effectiveApiKey) { if (selKey) selKey.conc -= 1; return null; }                          // 无任何可用 key
  // 跨进程权威闸：全局并发 + per-provider 并发 + (单 key 路径)RPM 令牌桶；任一不满足返回 null（上层切下一个）
  const rl = await acquireRateLimitSlots(p, cost, _multiKey, a, aggCap, now);
  if (!rl) { if (selKey) selKey.conc -= 1; return null; }
  if (!_multiKey && a.capacityModel !== 'unlimited') a.bucket.tokens -= cost; // 本地展示/降级兜底（权威由 Redis 令牌桶）
  a.conc += 1; GLOBAL_ACTIVE += 1;                            // 本地展示/降级兜底计数（selKey 并发槽已在上方原子占用）
  const t0 = Date.now();                                       // 真正发起请求的时刻（仅此后记 attempt）
  // 向 recorder 记一次实际尝试（best-effort，绝不影响主链路）；success/timeout/failed/429/error 各分支各自调用
  const mark = async (status, extra) => {
    if (!recorder || !recorder.record) return;
    const f = Date.now();
    try {
      await recorder.record({
        providerId: p.provider.id, bindingId: p.bindingId || '', modelId: p.model.model_id,
        status, httpStatus: extra && extra.httpStatus, providerErrorCode: extra && extra.providerErrorCode,
        cost, latencyMs: f - t0, startedAt: t0, finishedAt: f,
      });
    } catch (e) { /* recorder 已内部吞错，双保险 */ }
  };
  try {
    let res;
    let rotateCount = 0;
    while (true) {
      const providerWithKey = selKey ? { ...p.provider, api_key: effectiveApiKey } : p.provider;
      res = contentType === 'video'
        ? await videoGenerate(providerWithKey, p.model, input)
        : await imageGenerate(p.provider, p.model, input, effectiveApiKey);
      // 图片：瞬时网络/限流错误有界重试（吸收供应商偶发抖动，治"时好时坏"）；视频异步长任务不在此重试
      // 守卫 !res.rateLimited：429 已交外层 while 处理，绝不在此重复重试放大计费
      if (contentType !== 'video' && res && res.status === 'error' && !res.rateLimited && isTransient(res.error)) {
        for (let ri = 0; ri < 2; ri++) {
          await sleep(300 * (ri + 1));
          const r2 = await imageGenerate(p.provider, p.model, input);
          if (r2.status === 'success') { res = r2; break; }
          if (!isTransient(r2.error)) { res = r2; break; }
          res = r2;
        }
      }
      if (res && res.rateLimited) {                            // 真实 429：冷却当前 key + 池内换下一把重试（解锁聚合吞吐）
        if (!_multiKey && a.capacityModel !== 'unlimited') a.bucket.tokens += cost; if (rl && rl.bucketCharged) rateLimit.refundProviderBucket(p.provider.id, cost, a.bucket.cap); // 单 key 路径退还桶（多 key 未占用）
        if (selKey) {
          selKey.conc -= 1;                                     // 释放本 key 并发槽
          selKey.consecutiveFailures += 1;
          selKey.lastFailureAt = Date.now();
          cooldownKey(selKey, Date.now(), res.retryAfterMs);   // 按 Retry-After（默认 60s）冷却该 key，避免立即重选打爆
          try { selKey.cbState = router.cbRecordOutcome(selKey.cbState, 'failure', Date.now()); } catch (e) {}
        }
        await mark('rate_limited', { httpStatus: 429, providerErrorCode: 'RATE_LIMITED' }); // 429 也是一次真实尝试
        // 多 key 池：在池内轮换下一把未冷却/未熔断/并发未满的 key 重试；单 key 池直接拒单（与原语义一致）
        if (multiKey && rotateCount < KEY_ROTATE_MAX) {
          const nextKey = pickKey(p.provider.id, Date.now(), keyConcCap);
          if (nextKey && nextKey !== selKey) {
            selKey = nextKey;
            effectiveApiKey = selKey.apiKey;
            selKey.conc += 1; selKey.lastUsedAt = Date.now();
            rotateCount += 1;
            continue;                                           // 换 key 重试（仍在本账号/本 provider 内）
          }
        }
        if (!multiKey) markReject(a, now);                      // 单 key 保持原语义：整账号冷却；多 key 不冷却整池，仅隔离该 key
        a.conc -= 1; GLOBAL_ACTIVE -= 1; if (rl) { rateLimit.decProviderConc(p.provider.id, rl.provConcId); rateLimit.releaseGlobalSlot(rl.globalId); }
        return null;                                            // 池内可换 key 已耗尽（或单 key）→ 上层切下一个账号/等待区
      }
      break;                                                    // 非 429：交予下方 timeout/failed/error/success 分支处理
    }
    // 生成端迟迟未给终态（安全线触发：video 适配器 pollLoop 返回 status:'timeout'）——
    // 成败只听生成端回复，时间永远不当判据：绝不在此判失败、绝不释放积分。
    // 把 timeout 显式透传出去，避免被当成"资源不可用"误入等待区反复重新轮询（浪费 + 语义错）。
    // 上层 dispatchOne → generate → generateAsync 的 timeout 分支会标 'waiting' 保留待复核（积分仍 held，不释放）。
    if (res && res.status === 'timeout') {
      if (selKey) selKey.conc -= 1;
      a.conc -= 1; GLOBAL_ACTIVE -= 1; if (rl) { rateLimit.decProviderConc(p.provider.id, rl.provConcId); rateLimit.releaseGlobalSlot(rl.globalId); }
      await mark('timeout', { providerErrorCode: 'TIMEOUT' });
      return {
        status: 'timeout',
        error: res.error || '等待生成端回复超过安全线，任务保留待复核',
        images: [], videoUrl: '',
        providerId: p.provider.id, modelId: p.model.model_id, modelType: contentType, units: 0,
        bindingId: p.bindingId || '',
      };
    }
    // 生成端明确失败（provider 任务 definitive failed/error/canceled）：立即终态化，绝不切下一个账号空转。
    // 每个 key 会新建真实 provider 任务并轮询到完成，多 key 下逐个尝试会卡 running 数小时、积分永不释放、前台永不更新。
    // 释放本账号限流额度 + 并发槽（任务已死，不占坑）；不 markReject（非整账号冷却，避免无谓降低容量）。
    if (res && res.status === 'failed') {
      if (selKey) selKey.conc -= 1;
      if (!_multiKey && a.capacityModel !== 'unlimited') a.bucket.tokens += cost; if (rl && rl.bucketCharged) rateLimit.refundProviderBucket(p.provider.id, cost, a.bucket.cap);
      a.conc -= 1; GLOBAL_ACTIVE -= 1; if (rl) { rateLimit.decProviderConc(p.provider.id, rl.provConcId); rateLimit.releaseGlobalSlot(rl.globalId); }
      await mark('failed', { providerErrorCode: 'PROVIDER_FAILED' });
      return {
        status: 'failed',
        error: res.error || '生成失败',
        images: res.images || [], videoUrl: res.videoUrl || '',
        providerId: p.provider.id, modelId: p.model.model_id, modelType: contentType, units: 0,
        bindingId: p.bindingId || '',
      };
    }
    if (!res || res.status !== 'success') {                    // 真失败（网络抖动/无图片/配置错）→ 冷却该账号后切下一个
      if (!_multiKey && a.capacityModel !== 'unlimited') a.bucket.tokens += cost; if (rl && rl.bucketCharged) rateLimit.refundProviderBucket(p.provider.id, cost, a.bucket.cap);
      a.conc -= 1; GLOBAL_ACTIVE -= 1; if (rl) { rateLimit.decProviderConc(p.provider.id, rl.provConcId); rateLimit.releaseGlobalSlot(rl.globalId); }
      if (selKey) { selKey.conc -= 1; selKey.consecutiveFailures += 1; selKey.lastFailureAt = now; try { selKey.cbState = router.cbRecordOutcome(selKey.cbState, 'failure', now); } catch (e) {} }
      if (!multiKey) markReject(a, now);                       // 多 key：仅隔离该 key，不冷却整池
      await mark('error', { providerErrorCode: 'PROVIDER_ERROR' });
      return null;
    }
    try { a.cbState = router.cbRecordOutcome(a.cbState, 'success', now); } catch (e) { /* 熔断异常不阻断 */ }
    if (!multiKey) a.consecutiveRejects = 0;                   // 成功 → 单 key 重置拒单计数、释放并发槽
    a.conc -= 1; GLOBAL_ACTIVE -= 1; if (rl) { rateLimit.decProviderConc(p.provider.id, rl.provConcId); rateLimit.releaseGlobalSlot(rl.globalId); }
    if (selKey) { selKey.conc -= 1; selKey.consecutiveFailures = 0; try { selKey.cbState = router.cbRecordOutcome(selKey.cbState, 'success', now); } catch (e) {} }
    await mark('success', { httpStatus: 200 });
    // 精确归因：本次成功出自哪个 provider / model / 类型 / 产出资产数（供双边记账）
    const units = res.images ? (res.images.length || 0) : (res.videoUrl ? 1 : 0);
    return { ...res, providerId: p.provider.id, modelId: p.model.model_id, modelType: contentType, units, bindingId: p.bindingId || '' };
  } catch (e) {
    if (!_multiKey && a.capacityModel !== 'unlimited') a.bucket.tokens += cost; if (rl && rl.bucketCharged) rateLimit.refundProviderBucket(p.provider.id, cost, a.bucket.cap);
    a.conc -= 1; GLOBAL_ACTIVE -= 1; if (rl) { rateLimit.decProviderConc(p.provider.id, rl.provConcId); rateLimit.releaseGlobalSlot(rl.globalId); }
    if (selKey) { selKey.conc -= 1; selKey.consecutiveFailures += 1; selKey.lastFailureAt = now; try { selKey.cbState = router.cbRecordOutcome(selKey.cbState, 'failure', now); } catch (er) {} }
    if (!multiKey) markReject(a, now);
    await mark('error', { providerErrorCode: 'EXCEPTION' });
    return null;
  }
}

// ─── 智能路由辅助（Phase 3.4，非阻断）───
// 把 dispatcher 内存 ACCT 的实时态快照成一个 plain object，供 router.cjs 的 gate 读取。
// 全新账号（ACCT 尚无条目）→ 视为完全可用（限流/冷却/并发皆空），与 dispatcher 行为一致。
// concCap 按 (模型 max_concurrent ?? 服务商 max_concurrent ?? 2) 与硬上限取小，与 attemptOnAccount 一致。
function snapshotAcct(pair) {
  const provider = (pair && pair.provider) || {};
  const model = (pair && pair.model) || {};
  const pid = provider.id || '';
  const modelConc = (model && typeof model.max_concurrent === 'number' && model.max_concurrent > 0) ? model.max_concurrent : null;
  const perKeyCap = modelConc ?? (Number(provider.max_concurrent) || 2);
  // 多 Key 池容量必须与 attemptOnAccount 的执行层一致：perKeyCap × active key 数。
  // 旧逻辑固定 min(perKeyCap, ACCOUNT_CONC_CAP)，provider.max_concurrent=1 时路由预门控把整个
  // 475-key 池误判为总并发 1，导致 count=4 的其余 3 张在到达 pickKey 前即被拒入等待区。
  const pool = AKEYS[pid];
  const activeKeyCount = pool
    ? [...pool.values()].filter((ks) => ks.status === KEY_STATUS_ACTIVE).length
    : 1;
  const concCap = Math.max(perKeyCap, perKeyCap * Math.max(1, activeKeyCount));
  const a = ACCT[pid];
  if (!a) {
    return {
      providerId: pid, cooldownUntil: 0, consecutiveRejects: 0, manualState: null,
      cbState: router.cbInitState(),
      capacityModel: (provider.capacity_model === 'unlimited') ? 'unlimited' : 'limited',
      bucket: { tokens: 1e9, cap: 1e9 }, conc: 0, concCap,
    };
  }
  return {
    providerId: pid, cooldownUntil: a.cooldownUntil, consecutiveRejects: a.consecutiveRejects,
    manualState: a.manualState,
    cbState: a.cbState ? Object.assign({}, a.cbState) : router.cbInitState(),
    capacityModel: a.capacityModel,
    bucket: { tokens: a.bucket ? a.bucket.tokens : 1e9, cap: a.bucket ? a.bucket.cap : 1e9 },
    conc: a.conc, concCap,
  };
}

// 权重可配置（用户：第一版权重可配置化）：仅覆盖 DEFAULT_WEIGHTS 中存在的键，且须为有限数
function setRoutingWeights(w) {
  if (w && typeof w === 'object') {
    const merged = { ...router.DEFAULT_WEIGHTS };
    for (const k of Object.keys(router.DEFAULT_WEIGHTS)) {
      if (typeof w[k] === 'number' && Number.isFinite(w[k])) merged[k] = w[k];
    }
    ROUTING_WEIGHTS = merged;
  }
  return ROUTING_WEIGHTS;
}
function getRoutingWeights() { return ROUTING_WEIGHTS; }

// 评分路由总开关（kill-switch）：false → 退化为原始顺序（兼容层，可回退）
function setRoutingV3Enabled(v) { ROUTING_V3_ENABLED = !!v; return ROUTING_V3_ENABLED; }
function getRoutingV3Enabled() { return ROUTING_V3_ENABLED; }

// 运行时热配置聚合：从 settings.app 读全局并发 / 等待区阈值 / kill-switch / 路由权重。
// 非阻断：各字段独立处理，单字段异常不影响其他字段；调用方（generate）已在外层 try/catch。
// 路由权重与 setRoutingWeights 同契约：仅覆盖 DEFAULT_WEIGHTS 中存在的有限数值键（越界/非数值忽略）。
function applyRuntimeSettings(v) {
  if (!v || typeof v !== 'object') return;
  if (v.maxThreads) GLOBAL_MAX = Number(v.maxThreads) || 10;
  if (typeof v.waitingAreaThreshold === 'number' && v.waitingAreaThreshold > 0) {
    WAITING_THRESHOLD = Math.floor(v.waitingAreaThreshold);
  }
  if (typeof v.routingV3Enabled === 'boolean') ROUTING_V3_ENABLED = v.routingV3Enabled; // kill-switch 热切换
  // 路由权重热配置：写入 settings.app.routingWeights 即被 generate() 每请求载入（前端权重 UI 的落点）
  if (v.routingWeights && typeof v.routingWeights === 'object') {
    try { setRoutingWeights(v.routingWeights); } catch {}
  }
}

// 近期尝试指标缓存（TTL 30s）：一次查询覆盖所有 binding，非阻断（失败退化为空 map）
async function loadRoutingMetricsCached(pgPool, bindingIds) {
  const now = Date.now();
  if (metricsCache.map && (now - metricsCache.at) < METRICS_TTL_MS) return metricsCache.map;
  if (!pgPool || !Array.isArray(bindingIds) || bindingIds.length === 0) return metricsCache.map || {};
  try {
    const m = await router.loadRoutingMetrics(pgPool, bindingIds, { windowHours: 24 });
    metricsCache.at = now;
    metricsCache.map = m;
    return m;
  } catch (e) {
    return metricsCache.map || {};
  }
}

// 解释端点用：返回完整路由决策（chosen + ranking + rejected + 权重 + 门控顺序），供后台「决策解释」面板消费
async function explainRouting(pairs, opts) {
  opts = opts || {};
  const pgPool = opts.pgPool;
  const bindingIds = (pairs || []).map((p) => p.bindingId || '');
  const metrics = pgPool ? await loadRoutingMetricsCached(pgPool, bindingIds) : {};
  const acctMap = new Map();
  for (const p of (pairs || [])) acctMap.set(p.provider.id, snapshotAcct(p));
  const res = router.routeBindings(pairs, {
    acctMap, metrics,
    weights: opts.weights || ROUTING_WEIGHTS,
    seed: opts.seed != null ? opts.seed : 1,
    contentType: opts.contentType, tier: opts.tier, now: opts.now,
  });
  return {
    weights: res.weights,
    gateOrder: router.GATE_ORDER,
    chosen: res.chosen,
    ranking: res.ranking,
    rejected: res.rejected,
    metricsBindings: Object.keys(metrics).length,
  };
}

// 构建单次 dispatch 的候选尝试顺序（best-first，确定性）。
// 权威来源 = router.routeBindings（门控+评分+排序）；与旧的 routeDispatchOrder 行为一致：
//   先排 eligible（门控通过）候选，再把未覆盖的 pair（含被门控剔除者）补在末尾作为最后兜底。
// 失败即退化为原始顺序（非阻断，兼容层）；ROUTING_V3_ENABLED=false 时直接走原始顺序（kill-switch）。
function buildDispatchSequence(pairs, opts) {
  opts = opts || {};
  const fallback = () => (pairs || []).slice();
  if (!ROUTING_V3_ENABLED) return fallback();
  try {
    const rb = router.routeBindings(pairs, {
      acctMap: opts.acctMap,
      metrics: opts.metrics || Object.create(null),
      weights: ROUTING_WEIGHTS,
      seed: opts.seed != null ? opts.seed : 1,
      contentType: opts.contentType, tier: opts.tier,
    });
    const byBid = new Map((pairs || []).map((p) => [p.bindingId || '', p]));
    const ordered = [];
    for (const r of (rb.ranking || [])) {
      const p = byBid.get(r.bindingId);
      if (p) ordered.push(p);
    }
    // 任何未被排序覆盖的 pair（含被门控剔除者）→ 补在末尾，保证不丢候选（与旧 routeDispatchOrder 一致）
    for (const p of (pairs || [])) if (!ordered.includes(p)) ordered.push(p);
    return ordered;
  } catch (e) {
    return fallback(); // 路由异常绝不阻断生成主链路
  }
}

// 单任务：轮询所有账号，拒单静默切下一个；全部不可用 → 有界退避重试；仍失败 → throttled（无硬错、前台无感）
// 候选顺序由智能路由 routeDispatchOrder 接管（best-first，确定性）；attemptOnAccount 仍负责实时 admission + 失败兜底切换。
async function dispatchOne(pairs, tier, input, contentType, recorder, pgPool) {
  let retryReason = null;   // 下一次尝试的「为什么重试」说明（首尝试为 null = 初次）
  // 智能路由：加载近期尝试指标（缓存 30s，非阻断；无 PG 时退化为空 → 仅按实时态排序）
  const bindingIds = pairs.map((p) => p.bindingId || '');
  const metrics = pgPool ? await loadRoutingMetricsCached(pgPool, bindingIds) : {};
  const acctMap = new Map();
  for (const p of pairs) acctMap.set(p.provider.id, snapshotAcct(p));
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    // 每轮重试重新路由：按 score best-first 重排候选（实时态由 attemptOnAccount 兜底 admission）
    // 切换调用（Phase A）：权威序列来自 buildDispatchSequence → router.routeBindings（门控+评分+排序），
    // 非阻断（路由异常退化为原始顺序），且受 ROUTING_V3_ENABLED kill-switch 控制（可回退）。
    const seq = buildDispatchSequence(pairs, {
      acctMap, metrics,
      seed: (attempt + 1) * 2654435761, contentType, tier,
    });
    let brokeForGlobal = false;
    for (const p of seq) {
      if (rateLimit.globalIsFull(GLOBAL_MAX)) { await sleep(120); brokeForGlobal = true; break; }
      if (recorder && recorder.setRetryReason) recorder.setRetryReason(retryReason);
      const r = await attemptOnAccount(p, tier, input, contentType, recorder);
      if (!r) {                                               // 本次未产出结果（限流/冷却/瞬错/忙）→ 记录原因，切下一个账号
        retryReason = `provider ${p.provider.id} 未产出结果（限流/冷却/瞬错/忙），切换下一账号`;
        continue;
      }
      if (r.status === 'success') { return r; }   // 路由已接管排序，不再轮转 RR_POINTER
      // 生成端已给终态：timeout 保留待复核 / failed 立即终态，二者均绝不再试下一个账号
      //（failed 是 provider definitive 失败，切下一个账号只会新建真实 provider 任务空转，浪费配额且卡 running）。
      if (r.status === 'timeout' || r.status === 'failed') return r;
    }
    if (brokeForGlobal) { await sleep(200 * (attempt + 1)); continue; }
    await sleep(200 * (attempt + 1));                          // 整轮回不可用 → 短退避后重试
  }
  return { status: 'throttled', retryAfter: DEFAULT_COOLDOWN_MS, images: [], providerId: null, error: '资源紧张，请稍候重试' };
}

// ─── 主入口 ────────────────────────────────────────
async function generate(pgPool, opts) {
  const { model, prompt, ratio, resolution, count, contentType, referenceImages, negative, durationSec, videoMode } = opts;
  // 分辨率 → 桶档位：video 走 video 档（cost=20，与 4k 同权重）；8k 按 4k 计；未知按 1k
  const tier = contentType === 'video' ? 'video'
    : (['1k', '2k', '4k'].includes(resolution) ? resolution
      : (resolution === '8k' ? '4k' : '1k'));

  // 1. 全局最大并发 + 等待区阈值 + 路由 kill-switch + 路由权重（均可被 settings.app 实时覆盖）
  try {
    const r = await pgPool.query("SELECT value FROM settings WHERE key='app'");
    const v = r.rows[0] && r.rows[0].value;
    applyRuntimeSettings(v);
  } catch {}

  // 2. 唯一 resolver：display_name / model_id / 遗留 model 字符串 → canonical model_id 数组
  //    （禁止在 dispatcher 内散落处理 display_name；旧客户端传 display_name 经此归一）
  const modelIds = await resolveModelIdentity(pgPool, model);
  const canonicalModelId = opts.canonicalModelId || modelIds[0] || model || '';
  if (modelIds.length === 0) {
    return { status: 'failed', error: `未找到模型：${model}`, images: [] };
  }

  // 3. 该 model_id 下的可用 (模型行 × 服务商) 配对：
  //    Phase 2 改读 provider_model_bindings（优先），无绑定时双读回退旧 models.provider_id。
  //    每个 model 行已注入 upstreamModelName（上游真实模型名 wire name）；model_id 仍保留供账务/能力判定。
  const pairs = await loadDispatchPairs(pgPool, modelIds, contentType);
  if (pairs.length === 0) {
    return { status: 'failed', error: '该模型没有可用的已启用服务商（请检查服务商密钥与启用状态，或配置模型线路绑定）', images: [] };
  }

  // 多 Key 池对账：为本批涉及的服务商同步 api_keys 运行时态（保留计数，不重置）；
  // AKEYS 是 per-key 并发/熔断/失败计数的权威运行时源，DB 仅作成员与 status 的权威源。
  try {
    for (const p of pairs) syncKeyPool(p.provider.id, p.provider.__apiKeys || []);
  } catch (e) { /* 非致命：无 key 池不影响 legacy 单 key 路径 */ }

  // 5. 并发分配：单任务内部已做「拒单静默切下一个供应商」+「全部不可用 → throttled」
  // 视频数量固定 1（用户需求：视频不支持批量），图片按设置并行 count 张
  const total = contentType === 'video' ? 1 : Math.max(1, Math.min(4, Number(count) || 1));
  // 计费安全闸（防「10 次扣费」事故）：原生支持 n 的模型（gpt-image 等 OpenAI 官方端点）
  // 一次 API 调用即可出 N 张图，绝不能拆成 N 次独立调用 —— 否则中转按 N 次计费，用户被收 N 倍钱。
  // 判定与 imageGenerate 内 isGptImageModel 保持一致（基于配对模型上游名）。
  const nCapable = contentType !== 'video' && pairs.some((p) => isGptImageModel(p.model));
  const effectiveTotal = nCapable ? 1 : total;   // gpt-image：1 个子任务承载 N 张；其余模型维持原拆单
  const perCallCount = nCapable ? total : 1;      // gpt-image：单次 n=total；其余：每子任务 1 张
  // 智能路由尝试数据双写：仅异步生产路径（有 taskId）激活；sync 测试路径无 taskId → 空操作 recorder。
  // 每个子任务（每张图/每段视频）独立一个 job（job_id = `${task_id}__${i}`），其内各 provider 尝试为 attempt。
  const doRecord = !!(pgPool && opts.taskId);
  const tasks = [];
  for (let i = 0; i < effectiveTotal; i++) {
    const jobId = `${opts.taskId}__${i}`;
    const recorder = doRecord
      ? makeJobRecorder(pgPool, { jobId, taskId: opts.taskId, modelId: canonicalModelId, cost: opts.cost || 0 })
      : NULL_RECORDER;
    tasks.push((async () => {
      const input = { prompt, ratio, resolution, count: perCallCount, referenceImages, negative, durationSec, videoMode, taskId: opts.taskId, onSubmitted: opts.onSubmitted };
      if (recorder.begin) await recorder.begin().catch(() => {});
      const r = await dispatchOne(pairs, tier, input, contentType, recorder, pgPool);
      if (recorder.finish) await recorder.finish(r.status, r.providerId).catch(() => {});
      return r;
    })());
  }

  const results = await Promise.all(tasks);
  const images = [];
  const videos = [];        // 视频 URL 单独收集（与 images 通道并列，便于上层按 contentType 区分）
  const errors = [];
  const usedProviders = [];
  const consumption = [];   // 双边记账聚合：每组 (providerId, modelId, modelType) 的产出资产数
  let throttled = false;
  let timedOut = false;     // 生成端仍在进行（安全线触发）：成败只听生成端回复，绝不判失败、绝不释放积分
  for (const r of results) {
    if (r.providerId) usedProviders.push(r.providerId);
    if (r.providerId && r.modelId && r.units) {
      consumption.push({ providerId: r.providerId, modelId: r.modelId, modelType: r.modelType, units: r.units, bindingId: r.bindingId || '' });
    }
    if (r.status === 'throttled') { throttled = true; if (r.error) errors.push(r.error); continue; }
    if (r.status === 'timeout') { timedOut = true; if (r.error) errors.push(r.error); continue; }
    if (r.status === 'success') {
      if (r.images && r.images.length) {
        for (const url of r.images) images.push(url);   // gpt-image 单次返回 N 张，全部收集（不再只取第一张）
      } else if (r.videoUrl) {
        // 视频：videoUrl 单独通道；同时并入 images 以兼容上层 images.length 成功判定
        videos.push(r.videoUrl);
        images.push(r.videoUrl);
      }
    } else if (r.error) {
      errors.push(r.error);
    }
  }
  const usedProvidersUniq = [...new Set(usedProviders)];
  if (images.length > 0) {
    return { status: 'success', images, videoUrl: videos[0], source: 'provider', errors: errors.length ? errors : undefined, usedProviders: usedProvidersUniq, consumption };
  }
  // 优先级：成功 > timeout（保留，不判失败、不释放） > throttled（等待区重试） > failed
  if (timedOut) {
    return { status: 'timeout', error: errors[0] || '等待生成端回复超过安全线，任务保留待复核', images: [], usedProviders: usedProvidersUniq };
  }
  if (throttled) {
    return { status: 'throttled', retryAfter: DEFAULT_COOLDOWN_MS, error: errors[0] || '资源紧张，请稍候重试', images: [], usedProviders: usedProvidersUniq };
  }
  return { status: 'failed', error: errors[0] || '所有服务商生成失败', images: [], usedProviders: usedProvidersUniq };
}

function getArrayByPath(obj, path) {
  const v = getByPath(obj, path);
  return Array.isArray(v) ? v : [];
}

// ─── 搬运与 API 解耦：完成结算并异步入队（不阻塞请求/SSE，done 由后台 worker 发出）───
// 入队失败兜底：退回同步 finalize+emit（与旧行为一致），确保 'done' 永不丢失、客户端不卡 running。
async function completeViaQueue(pgPool, { userId, taskId, cost, costPool, idempotencyKey, ctx, providerImages, providerVideoUrl, originalResult }) {
  // 结算：成功 commit（与现有语义一致：积分在生成成功即扣，不依赖 finalize 成败）
  await billing.commitCredits(pgPool, userId, cost, idempotencyKey, costPool);
  try {
    const groups = (originalResult && originalResult.consumption) || [];
    const totalUnits = groups.reduce((s, g) => s + (g.units || 0), 0) || 1;
    for (const g of groups) {
      const alloc = Math.round((cost || 0) * (g.units || 0) / totalUnits);
      await accounting.recordConsumption(pgPool, {
        scope: 'user', actorId: userId || '', purpose: 'generate',
        providerId: g.providerId || '', modelId: g.modelId || '', modelType: g.modelType || 'image',
        outputUnits: g.units || 0, customerChargeCredits: alloc,
        bindingId: g.bindingId || '',
        idempotencyKey: `${idempotencyKey}:${g.providerId}:${g.modelId}`, taskRef: taskId,
      });
    }
  } catch (e) { console.warn('[accounting completeViaQueue]', e.message); }
  // 入队：搬运交给后台上传队列 worker（不阻塞本请求/SSE，done 由 worker 在 finalize 完成后发出）
  try {
    await uploadQueue.enqueueFinalize(pgPool, { ctx, providerImages, providerVideoUrl, originalResult });
  } catch (e) {
    console.warn('[uploadQueue] 入队失败，退回同步 finalize（兜底不丢 done）:', e.message);
    await uploadQueue.finalizeAndEmit(pgPool, { userId, taskId, ctx, providerImages, providerVideoUrl, originalResult }).catch((err) => {
      console.warn('[uploadQueue] 兜底 finalize 也失败:', err.message);
    });
  }
}

// 启动后台上传队列（仅 IS_LEADER 调用）：建表 + 崩溃恢复 + 起 worker
async function startUploadQueue(pgPool) {
  await uploadQueue.ensureUploadJobsTable(pgPool);
  await uploadQueue.recoverUploadJobs(pgPool);
  uploadQueue.startUploadWorker(pgPool);
  console.log('[dispatcher] 上传队列 worker 已挂载（搬运已解耦至后台）');
}

// ─── 异步生成：返回 taskId 立即让前端可轮询，状态写入 PG ───
async function generateAsync(pgPool, opts) {
  // CPU 自适应降级：若本 worker CPU 持续 >80%（默认阈值），拒绝新任务（route 层转 503 + Retry-After）
  // in-flight 任务不受影响，SHED 只拒绝「准备入队的新请求」
  if (cpuMonitor.isShedding()) {
    return { taskId: null, error: 'CPU_OVERLOAD: 系统繁忙，请稍后重试' };
  }
  if (!pgPool) return { taskId: null, error: '数据库不可用' };
  const { model, displayModelName, prompt, count, contentType, referenceImages, pendingIds = [], clientMeta = {}, user_id, idempotencyKey, cost = 0, costPool = 'recharge' } = opts;
  // 生成一个稳定 taskId：便于前端 localStorage 持久化关联
  const taskId = `gt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 归一 canonical model_id：旧任务 / 遗留孤儿可能传 display_name，resolver 兜底；
  // model 列保留展示名（displayModelName || 原始 model 字符串），model_id 列写 canonical。
  let canonicalModelId = '';
  try {
    const resolved = await resolveModelIdentity(pgPool, model);
    canonicalModelId = resolved[0] || model || '';
    const displayModel = (typeof displayModelName === 'string' && displayModelName) ? displayModelName : (model || '');
    await pgPool.query(
      `INSERT INTO generation_tasks
         (task_id, status, model, model_id, prompt, count, content_type, pending_ids, client_meta, user_id, idempotency_key, cost, cost_pool)
       VALUES ($1, 'running', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [taskId, displayModel, canonicalModelId, prompt || '', count || 1, contentType || 'image', pendingIds, clientMeta, user_id || null, idempotencyKey || null, cost || 0, costPool || 'recharge'],
    );
  } catch (e) {
    return { taskId: null, error: `写入任务表失败：${e.message}` };
  }
  // 注入 taskId + canonicalModelId + onSubmitted：视频提交后立即持久化 provider task id（崩溃恢复地基）。
  // runOpts 透传到 generate → dispatchOne → attemptOnAccount → videoGenerate，视频任务提交成功后即写库。
  const runOpts = { ...opts, taskId, canonicalModelId, onSubmitted: (info) => persistProviderTaskId(pgPool, taskId, info) };

  // 后台跑：完成后更新 PG（不再 await）
  generate(pgPool, runOpts)
    .then(async (result) => {
      // 取消护栏（覆盖图片等无 poll 循环的路径）：若任务已被 cancelTask 取消（已释放积分+标记 canceled+推送），
      // 无论生成结果如何（即便图片 provider 刚成功返回）都按取消处理，绝不 commit 覆盖 canceled、绝不重复结算。
      if (cancelledTasks.has(taskId)) {
        cancelledTasks.delete(taskId);
        try {
          await updateTaskStatus(pgPool, taskId, 'canceled', null, '用户已取消', user_id);
          realtime.emitTaskUpdate(user_id, { taskId, status: 'canceled', error: '用户已取消' });
        } catch (e) { console.warn('[dispatcher] 取消兜底失败:', e.message); }
        return;
      }
      const ok = result && result.status === 'success' && Array.isArray(result.images) && result.images.length;
      try {
        if (ok) {
          // 搬运与 API 解耦：结算 + 异步入队（不 await OSS 上传）；
          // done 事件由后台上传队列 worker 在 finalize 完成后发出（见 uploadQueue.cjs）。
          await completeViaQueue(pgPool, {
            userId: user_id, taskId,
            cost, costPool, idempotencyKey,
            ctx: {
              userId: user_id, taskId,
              prompt,
              model: canonicalModelId,
              ratio: (opts && opts.ratio) || (clientMeta && clientMeta.ratio) || '1:1',
              contentType: contentType || 'image',
              pendingIds: (opts && Array.isArray(opts.pendingIds)) ? opts.pendingIds : [],
            },
            providerImages: result.images || [],
            providerVideoUrl: result.videoUrl || null,
            originalResult: result,
          });
        } else if (result && result.status === 'throttled') {
          // 资源全不可用（该任务所有可用供应商都冷却/限流）→ 进入等待区后台重试，
          // 不立即判失败、不释放积分（仍持有，等待真正生成或超时再释放）。
          // 前台是否提示"资源不足"由等待区积压 + 平台全冷状态决定（见 getWaitingAreaStatus）。
          enqueueWaiting(taskId, opts);
          // 持久化 opts 到 resume_meta，供后端重启/崩溃后恢复等待区（避免内存队列丢失导致任务永久卡 running）
          persistWaitingOpts(pgPool, taskId, opts).catch(() => {});
          await updateTaskStatus(pgPool, taskId, 'running', null, '资源紧张，已进入等待区排队重试', user_id);
          realtime.emitTaskUpdate(user_id, { taskId, status: 'running', error: '资源紧张，已进入等待区排队重试' });
          runWaitingPump(pgPool).catch((e) => console.warn('[waiting] pump error:', e.message));
        } else if (result && result.status === 'canceled') {
          // 用户已取消：权威终态（释放积分 + 标记 canceled + 推送 SSE）已由 cancelTask 完成；
          // 此处仅做幂等兜底——若因竞态 poll 循环先返回 canceled 而 cancelTask 尚未写库，则补写。不重复释放积分。
          cancelledTasks.delete(taskId);
          await updateTaskStatus(pgPool, taskId, 'canceled', null, '用户已取消', user_id);
          realtime.emitTaskUpdate(user_id, { taskId, status: 'canceled', error: '用户已取消' });
        } else if (result && result.status === 'timeout') {
          // 防僵尸安全线触发：生成端迟迟未给终态。绝不判失败、绝不释放积分，保留任务待复核（成败只听生成端回复）。
          await updateTaskStatus(pgPool, taskId, 'waiting', null, '等待生成端回复超过安全线，任务保留待复核', user_id);
          realtime.emitTaskUpdate(user_id, { taskId, status: 'waiting', error: '等待生成端回复超过安全线，任务保留待复核' });
        } else {
          // 生成失败：释放 held 积分（G3 释放点，按池回退）
          await billing.releaseCredits(pgPool, user_id, cost, idempotencyKey, costPool);
          await pgPool.query(
            `UPDATE generation_tasks SET status=$2, result=$3, error=$4, completed_at=NOW(), user_id=$5
             WHERE task_id=$1`,
            [taskId, 'failed', JSON.stringify(result || {}), (result && result.error) || '', user_id],
          );
          realtime.emitTaskUpdate(user_id, { taskId, status: 'failed', error: (result && result.error) || '' });
          // 持久化到核心错误日志 + 实时监控（前台出图失败后端可观测）
          logError('dispatcher.generate', `生成失败 taskId=${taskId} model=${model || ''} userId=${user_id || ''}`, {
            taskId,
            model: model || '',
            userId: user_id || '',
            contentType: contentType || 'image',
            count: count || 1,
            providerError: (result && result.error) || '',
            meta: (result && result.meta) || null,
          });
        }
      } catch (e) {
        console.warn('[dispatcher] 完成回调失败:', e.message);
      }
    })
    .catch(async (e) => {
      // 异常：释放 held 积分（按池回退）
      await billing.releaseCredits(pgPool, user_id, cost, idempotencyKey, costPool).catch(() => {});
      await pgPool.query(
        `UPDATE generation_tasks SET status='failed', error=$2, completed_at=NOW(), user_id=$3
         WHERE task_id=$1`,
        [taskId, String((e && e.message) || e), user_id],
      ).catch(() => {});
      realtime.emitTaskUpdate(user_id, { taskId, status: 'failed', error: String((e && e.message) || e) });
      // 后台生成异常（非 provider 返回，而是代码/网络层异常）→ 同样落核心错误日志
      logError('dispatcher.generate', `生成异常 taskId=${taskId} model=${model || ''} userId=${user_id || ''}: ${e && e.message}`, {
        taskId,
        model: model || '',
        userId: user_id || '',
        contentType: contentType || 'image',
        stack: (e && e.stack) || null,
      });
    });
  return { taskId };
}

// 视频提交成功后立即持久化 provider task id + 供应商/模型标识（崩溃恢复续轮询依赖）。
// 同时记录 submittedAt（resume 时推算轮询密度起点，避免重启后密度重置）。
async function persistProviderTaskId(pgPool, taskId, info) {
  const { providerTaskId, providerKey, providerId, modelId } = info || {};
  if (!providerTaskId) return;
  try {
    await pgPool.query(
      `UPDATE generation_tasks
         SET provider_task_id=$2, provider_key=$3, provider_id=$4, model_id=$5,
             resume_meta=jsonb_build_object('submittedAt', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
       WHERE task_id=$1`,
      [taskId, providerTaskId, providerKey || null, providerId || null, modelId || null],
    );
  } catch (e) {
    console.warn('[dispatcher] 持久化 provider_task_id 失败:', e.message);
  }
}

// ─── 崩溃恢复：启动时扫描在途视频任务，续轮询已提交但本进程未完成的任务 ───
// 仅恢复 status='running' 且已持久化 provider_task_id 的任务（提交前崩溃的任务无 provider task id，
// 由 billing.cjs 的 running>30min 兜底释放 held 积分，不会泄漏；此处只负责"拿回那一笔生成结果"）。
async function resumeRunningTasks(pgPool) {
  if (!pgPool) return { resumed: 0 };
  try {
    const r = await pgPool.query(
      `SELECT task_id, provider_id, model_id, provider_key, provider_task_id, user_id,
              idempotency_key, cost, cost_pool, model, content_type, count
         FROM generation_tasks
        WHERE status='running' AND provider_task_id IS NOT NULL AND provider_task_id <> ''
          AND created_at > NOW() - INTERVAL '6 hours'`,
    );
    let resumed = 0;
    for (const row of r.rows) {
      // 后台 fire-and-forget 续轮询，不阻塞启动
      resumeOneTask(pgPool, row).catch((e) => console.warn('[resume] 任务续轮询异常:', row.task_id, e.message));
      resumed++;
    }
    if (resumed) console.log(`[resume] 已恢复 ${resumed} 个崩溃前在途视频任务`);
    return { resumed };
  } catch (e) {
    console.warn('[resume] 扫描在途任务失败:', e.message);
    return { resumed: 0, error: e.message };
  }
}

// ─── 等待区崩溃恢复：重启/崩溃后，内存 WAITING_AREA 队列已丢失，但 DB 中仍有 status='running'
// 且处于等待区的孤儿任务（error 含"等待区"或已持久化 waitingOpts）。重新入队并启动泵重试，
// 避免任务永久卡 running（原仅 >3h 看门狗兜底，体验差且积压）。 ───
async function resumeWaitingArea(pgPool) {
  if (!pgPool) return { resumed: 0 };
  try {
    const r = await pgPool.query(
      `SELECT task_id, model, prompt, count, content_type, user_id, cost, cost_pool, idempotency_key, resume_meta
         FROM generation_tasks
        WHERE status='running'
          AND (resume_meta->'waitingOpts' IS NOT NULL OR error LIKE '%等待区%')
          AND created_at > NOW() - INTERVAL '3 hours'`,
    );
    let resumed = 0;
    for (const row of r.rows) {
      let opts;
      if (row.resume_meta && row.resume_meta.waitingOpts) {
        opts = row.resume_meta.waitingOpts;            // 新任务：完整 opts（含 ratio/resolution 等）
      } else {
        // 遗留孤儿：从行重建最小 opts（缺 ratio/resolution 等，generate 用默认 1k 兜底）
        opts = {
          model: row.model, prompt: row.prompt, count: row.count || 1,
          contentType: row.content_type || 'image', user_id: row.user_id,
          cost: row.cost || 0, costPool: row.cost_pool || 'recharge',
          idempotencyKey: row.idempotency_key, userPlan: 'free',
        };
      }
      if (!opts || !opts.model) continue;
      const taskId = row.task_id;
      const runOpts = { ...opts, taskId, onSubmitted: (info) => persistProviderTaskId(pgPool, taskId, info) };
      enqueueWaiting(taskId, runOpts, row.resume_meta && row.resume_meta.waitingState);
      resumed++;
    }
    if (resumed) {
      console.log(`[waiting] 恢复等待区孤儿任务 ${resumed} 个（重启后重试）`);
      runWaitingPump(pgPool).catch((e) => console.warn('[waiting] pump error:', e.message));
    }
    return { resumed };
  } catch (e) {
    console.warn('[waiting] 扫描等待区孤儿失败:', e.message);
    return { resumed: 0, error: e.message };
  }
}

// ─── 图片任务崩溃恢复：重启后重驱在途图片任务 ───
// 背景：图片生成是同步（POST /images/generations，60s 超时），不写 provider_task_id；
//       resumeRunningTasks 仅覆盖视频（provider_task_id IS NOT NULL），图片任务在重启时
//       会丢失内存中的 generate() promise，永久卡 running → 看门狗 90min 后标 failed
//       （见上方 resumeRunningTasks 注释）。本函数在启动时把"真实在途的图片任务"
//       重新驱动一遍 generate()，并做与 generateAsync 一致的终态处理（成功 commit + 资产最终化
//       落 OSS/media、超时/限流保留待复核或入等待区、失败释放 held 积分），与视频恢复口径对齐。
// 选择条件：status='running' AND content_type='image' AND provider_task_id IS NULL
//           AND resume_meta->'waitingOpts' IS NULL（排除等待区任务，避免与 resumeWaitingArea 重复入队）
//           AND created_at < NOW() - INTERVAL '1 minute'（避免与刚提交、本进程正在处理的任务竞态）
async function resumeRunningImageTasks(pgPool) {
  if (!pgPool) return { resumed: 0 };
  try {
    const r = await pgPool.query(
      `SELECT task_id, model, prompt, count, content_type, user_id, cost, cost_pool,
              idempotency_key, pending_ids, client_meta, created_at
         FROM generation_tasks
        WHERE status='running'
          AND content_type='image'
          AND (provider_task_id IS NULL OR provider_task_id = '')
          AND resume_meta->'waitingOpts' IS NULL
          AND created_at < NOW() - INTERVAL '1 minute'
          AND created_at > NOW() - INTERVAL '6 hours'`,
    );
    let resumed = 0;
    for (const row of r.rows) {
      const cm = row.client_meta || {};
      const opts = {
        model: row.model,
        prompt: row.prompt,
        count: row.count || 1,
        contentType: 'image',
        ratio: cm.ratio || '1:1',
        resolution: cm.resolution || '1k',
        referenceImages: Array.isArray(cm.referenceImages) ? cm.referenceImages : [],
        negative: cm.negative || '',
        user_id: row.user_id,
        cost: row.cost || 0,
        costPool: row.cost_pool || 'recharge',
        idempotencyKey: row.idempotency_key,
        pendingIds: Array.isArray(row.pending_ids) ? row.pending_ids : [],
        taskId: row.task_id,
        canonicalModelId: '',
      };
      // 后台 fire-and-forget 重驱，不阻塞启动
      resumeOneImageTask(pgPool, row, opts).catch((e) => console.warn('[resume-image] 重驱异常:', row.task_id, e.message));
      resumed++;
    }
    if (resumed) console.log(`[resume-image] 已重驱 ${resumed} 个崩溃前在途图片任务`);
    return { resumed };
  } catch (e) {
    console.warn('[resume-image] 扫描在途图片任务失败:', e.message);
    return { resumed: 0, error: e.message };
  }
}

async function resumeOneImageTask(pgPool, row, opts) {
  let result;
  try {
    // 直接重驱 generate()（同步图片生成，自带 60s 超时与瞬时错误有界重试）。
    // generate() 不写终态、不做计费，终态与计费由此处处理，与 generateAsync 一致。
    result = await generate(pgPool, opts);
  } catch (e) {
    result = { status: 'failed', error: `重驱异常：${e && e.message || e}`, images: [] };
  }
  const ok = result && result.status === 'success' && Array.isArray(result.images) && result.images.length;
  try {
    if (ok) {
      // 搬运与 API 解耦：结算 + 异步入队（不 await OSS 上传）；done 由后台上传队列 worker 发出
      await completeViaQueue(pgPool, {
        userId: row.user_id, taskId: row.task_id,
        cost: row.cost, costPool: row.cost_pool, idempotencyKey: row.idempotency_key,
        ctx: {
          userId: row.user_id, taskId: row.task_id,
          prompt: row.prompt,
          model: opts.canonicalModelId || row.model,
          ratio: opts.ratio || '1:1',
          contentType: 'image',
          pendingIds: opts.pendingIds || [],
        },
        providerImages: result.images || [],
        providerVideoUrl: null,
        originalResult: result,
      });
    } else if (result && result.status === 'timeout') {
      // 防僵尸安全线触发：成败只听生成端回复，绝不判失败、绝不释放积分，保留任务待复核
      await updateTaskStatus(pgPool, row.task_id, 'waiting', null, '等待生成端回复超过安全线，任务保留待复核', row.user_id);
      realtime.emitTaskUpdate(row.task_id, { taskId: row.task_id, status: 'waiting', error: '等待生成端回复超过安全线，任务保留待复核' });
    } else if (result && result.status === 'throttled') {
      // 资源全不可用 → 进入等待区后台重试，不立即判失败、不释放积分
      enqueueWaiting(row.task_id, opts);
      persistWaitingOpts(pgPool, row.task_id, opts).catch(() => {});
      await updateTaskStatus(pgPool, row.task_id, 'running', null, '资源紧张，已进入等待区排队重试', row.user_id);
      realtime.emitTaskUpdate(row.task_id, { taskId: row.task_id, status: 'running', error: '资源紧张，已进入等待区排队重试' });
      runWaitingPump(pgPool).catch((e) => console.warn('[waiting] pump error:', e.message));
    } else {
      // 生成失败：释放 held 积分（按池回退，幂等安全）
      await billing.releaseCredits(pgPool, row.user_id, row.cost, row.idempotency_key, row.cost_pool);
      await pgPool.query(
        `UPDATE generation_tasks SET status=$2, result=$3, error=$4, completed_at=NOW(), user_id=$5
         WHERE task_id=$1`,
        [row.task_id, 'failed', JSON.stringify(result || {}), (result && result.error) || '', row.user_id],
      );
      realtime.emitTaskUpdate(row.task_id, { taskId: row.task_id, status: 'failed', error: (result && result.error) || '' });
      logError('dispatcher.resume-image', `重驱生成失败 taskId=${row.task_id} model=${row.model || ''} userId=${row.user_id || ''}`, {
        taskId: row.task_id, model: row.model || '', userId: row.user_id || '',
        contentType: 'image', count: row.count || 1, providerError: (result && result.error) || '',
      });
    }
  } catch (e) {
    console.warn('[resume-image] 终态处理失败:', e.message);
  }
}

async function resumeOneTask(pgPool, row) {
  const { task_id, provider_id, model_id, provider_key, provider_task_id, user_id, idempotency_key, cost, cost_pool, model, content_type, count } = row;
  // 兼容旧任务：model_id 可能为空（遗留图片 / 视频任务），用 display_name 兜底解析 canonical
  const effectiveModelId = model_id || (await resolveModelIdentity(pgPool, model))[0] || model;
  // 重新加载 provider / model（含 api_key、endpoint 配置）—— 崩溃后这些不在内存，必须从库里取
  const pr = await pgPool.query('SELECT * FROM providers WHERE id=$1', [provider_id]);
  // 续轮询仅用 provider_task_id，不重发 wire name；但为一致性仍注入 upstreamModelName（绑定优先，否则 model_id）
  const mr = await pgPool.query(
    `SELECT m.*, COALESCE(b.upstream_model_name, m.model_id) AS upstream_model_name,
            COALESCE(b.id, '') AS binding_id
       FROM models m
       LEFT JOIN provider_model_bindings b
         ON b.model_id = m.model_id AND b.provider_id = m.provider_id AND b.enabled = true
      WHERE m.model_id=$1 AND m.provider_id=$2
      LIMIT 1`,
    [effectiveModelId, provider_id],
  );
  const provider = pr.rows[0];
  const mdl = mr.rows[0];
  if (!provider || !mdl) {
    console.warn('[resume] 任务', task_id, '的 provider/model 已不存在，跳过续轮询（保留 running 待人工）');
    return;
  }
  // startedAt：用提交时间推算，保持轮询密度不重置（resume_meta.submittedAt 不存在则 0 → 用本进程起点）
  let startedAt = 0;
  try {
    if (row.resume_meta && row.resume_meta.submittedAt) {
      const t = Date.parse(row.resume_meta.submittedAt);
      if (Number.isFinite(t)) startedAt = t;
    }
  } catch {}
  let pollRes;
  if (provider_key && provider_key !== 'generic' && videoRouter.poll) {
    pollRes = await videoRouter.poll(provider, mdl, provider_task_id, startedAt, () => cancelledTasks.has(task_id));
  } else if (provider_key === 'generic') {
    pollRes = await genericVideoPoll(provider, mdl, provider_task_id, startedAt, () => cancelledTasks.has(task_id));
  } else {
    console.warn('[resume] 任务', task_id, 'provider_key 未知:', provider_key, '跳过');
    return;
  }
  // 智能路由尝试数据：崩溃/重启后恢复续轮询，补记一条 resume 任务（best-effort，不阻断恢复）
  await recordResumeJob(pgPool, {
    taskId: task_id, providerId: provider_id, modelId: effectiveModelId,
    bindingId: (mdl && mdl.binding_id) || '', status: pollRes.status,
  }).catch(() => {});

  // 包装成 generation_tasks 终态结果形状 → 复用与正常完成一致的最终处理（commit / 释放 / 保留）
  let result;
  if (pollRes.status === 'success') {
    result = {
      status: 'success', images: [pollRes.videoUrl], videoUrl: pollRes.videoUrl, source: 'provider',
      consumption: [{ providerId: provider_id, modelId: model_id, modelType: 'video', units: 1, bindingId: (mdl && mdl.binding_id) || '' }],
    };
  } else if (pollRes.status === 'timeout') {
    result = { status: 'timeout', error: pollRes.error };
  } else {
    result = { status: 'failed', error: pollRes.error };
  }
  await finalizeResumedTask(pgPool, { taskId: task_id, user_id, idempotencyKey: idempotency_key, cost, costPool: cost_pool, contentType: content_type, model, count }, result);
}

// 续轮询完成后的终态处理：与 generateAsync 内的正常完成逻辑保持一致（成功 commit / 超时保留 / 失败释放）。
async function finalizeResumedTask(pgPool, ctx, result) {
  const { taskId, user_id, idempotencyKey, cost, costPool, contentType, model, count } = ctx;
  // 取消护栏：续轮询期间若被 cancelTask 取消，无论续轮询结果如何都按取消处理（不 commit、不重复释放）。
  if (cancelledTasks.has(taskId)) {
    cancelledTasks.delete(taskId);
    try {
      await updateTaskStatus(pgPool, taskId, 'canceled', null, '用户已取消', user_id);
      realtime.emitTaskUpdate(user_id, { taskId, status: 'canceled', error: '用户已取消' });
    } catch (e) { console.warn('[dispatcher] resume 取消兜底失败:', e.message); }
    return;
  }
  const ok = result && result.status === 'success' && Array.isArray(result.images) && result.images.length;
  try {
    if (ok) {
      // 搬运与 API 解耦：结算 + 异步入队（不 await OSS 上传）；done 由后台上传队列 worker 发出
      await completeViaQueue(pgPool, {
        userId: user_id, taskId,
        cost, costPool, idempotencyKey,
        ctx: {
          userId: user_id, taskId, prompt: '', model: model || '',
          ratio: '1:1', contentType: contentType || 'video', pendingIds: [],
        },
        providerImages: [],   // 视频路径：图片传空，仅 videoUrl
        providerVideoUrl: result.videoUrl || null,
        originalResult: result,
      });
    } else if (result && result.status === 'timeout') {
      // 防僵尸安全线触发：仍然绝不判失败、绝不释放积分，保留任务待复核（成败只听生成端回复）。
      await updateTaskStatus(pgPool, taskId, 'waiting', null, '等待生成端回复超过安全线，任务保留待复核', user_id);
      realtime.emitTaskUpdate(user_id, { taskId, status: 'waiting', error: '等待生成端回复超过安全线，任务保留待复核' });
    } else if (result && result.status === 'canceled') {
      // 用户已取消：cancelTask 已释放积分 + 标记 canceled + 推送；此处仅幂等兜底，不重复释放。
      cancelledTasks.delete(taskId);
      await updateTaskStatus(pgPool, taskId, 'canceled', null, '用户已取消', user_id);
      realtime.emitTaskUpdate(user_id, { taskId, status: 'canceled', error: '用户已取消' });
    } else {
      // 生成失败：释放 held 积分（按池回退）
      await billing.releaseCredits(pgPool, user_id, cost, idempotencyKey, costPool);
      await pgPool.query(
        `UPDATE generation_tasks SET status=$2, result=$3, error=$4, completed_at=NOW(), user_id=$5
         WHERE task_id=$1`,
        [taskId, 'failed', JSON.stringify(result || {}), (result && result.error) || '', user_id],
      );
      realtime.emitTaskUpdate(user_id, { taskId, status: 'failed', error: (result && result.error) || '' });
      logError('dispatcher.resume', `续轮询生成失败 taskId=${taskId} model=${model || ''} userId=${user_id || ''}`, {
        taskId, model: model || '', userId: user_id || '',
        contentType: contentType || 'image', count: count || 1,
        providerError: (result && result.error) || '',
      });
    }
  } catch (e) {
    console.warn('[dispatcher] finalizeResumedTask 失败:', e.message);
  }
}

// ─── 孤儿任务看门狗：兜底回收崩溃/未捕获导致的永久 running ───
// 背景：进程崩溃 / 未捕获异常可能让 running 任务永久孤儿——
//   · 图片任务崩溃中途中途无 provider_task_id，resumeRunningTasks 不覆盖；
//   · 续轮询遗漏或极端竞态下个别 running 任务可能永远停在 running。
// 这些孤儿若不回收，积分（held）永久占用、前台 pending 卡片永不更新。
// 策略：周期性扫描 created_at 超硬上限（90min，与轮询安全线一致）的 running 任务，
//       强制标 failed 并释放 held 积分，杜绝永久卡 running。
// 注：waiting 任务属「保留待复核」（超时铁律：绝不按时间判失败），看门狗只回收 running 孤儿，不碰 waiting。
const STUCK_HARD_LIMIT_MS = 90 * 60 * 1000;           // 90 分钟硬上限（与 poll 安全线对齐）
const STUCK_WATCHDOG_INTERVAL_MS = 10 * 60 * 1000;    // 每 10 分钟扫描一次
let watchdogStarted = false;
async function scanStuckTasks(pgPool) {
  try {
    const r = await pgPool.query(
      `SELECT task_id, user_id, cost, cost_pool, idempotency_key, status
         FROM generation_tasks
        WHERE status='running' AND created_at < NOW() - INTERVAL '90 minutes'`,
    );
    for (const row of r.rows) {
      // 释放 held 积分（按池回退，幂等安全）；仅 running 孤儿才会被选中，already-terminal 任务不会被重复释放。
      try {
        await billing.releaseCredits(pgPool, row.user_id, row.cost, row.idempotency_key, row.cost_pool);
      } catch (e) { console.warn('[watchdog] 释放积分失败（忽略）:', row.task_id, e.message); }
      await updateTaskStatus(pgPool, row.task_id, 'failed', null, '任务超时未完成（看门狗兜底回收孤儿任务）', row.user_id);
      realtime.emitTaskUpdate(row.user_id, { taskId: row.task_id, status: 'failed', error: '任务超时未完成（看门狗兜底回收孤儿任务）' });
      console.warn(`[watchdog] 回收孤儿 running 任务 ${row.task_id}（创建超 3h），已标 failed 并释放积分`);
    }
    if (r.rows.length) console.log(`[watchdog] 本轮回收 ${r.rows.length} 个孤儿 running 任务`);
  } catch (e) {
    console.warn('[watchdog] 扫描孤儿任务失败:', e.message);
  }
}
function startStuckTaskWatchdog(pgPool) {
  if (watchdogStarted || !pgPool) return;
  watchdogStarted = true;
  // 启动后先跑一次（尽快回收已存在的孤儿），随后周期扫描
  scanStuckTasks(pgPool).catch(() => {});
  setInterval(() => scanStuckTasks(pgPool).catch(() => {}), STUCK_WATCHDOG_INTERVAL_MS);
  console.log('[watchdog] 孤儿 running 任务看门狗已启动（硬上限 90min，每 10 分钟扫描）');
}

// 查询单个任务状态
async function getTaskStatus(pgPool, taskId) {
  if (!pgPool) return { status: 'unknown', error: '数据库不可用' };
  try {
    const r = await pgPool.query(
      `SELECT task_id, status, result, error, pending_ids, client_meta, model, prompt, count, content_type, created_at, completed_at
         FROM generation_tasks WHERE task_id=$1`,
      [taskId],
    );
    if (r.rows.length === 0) return { status: 'not_found', error: '任务不存在或已清理' };
    const row = r.rows[0];
    return {
      taskId: row.task_id,
      status: row.status,
      result: row.result || null,
      error: row.error || '',
      pendingIds: row.pending_ids || [],
      clientMeta: row.client_meta || {},
      model: row.model,
      prompt: row.prompt,
      count: row.count,
      contentType: row.content_type,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  } catch (e) {
    return { status: 'unknown', error: e.message };
  }
}

// 列出在途任务（status='running'，以及最近 1 小时内 done/failed 便于客户端发现刚完成但未及时拉到的事件）
// 严格按 user_id 归属过滤（防多用户串看，G1）；旧 user_id IS NULL 的历史行不再对全员可见
async function listActiveTasks(pgPool, userId) {
  if (!pgPool) return { tasks: [] };
  try {
    const params = [];
    let where = `WHERE (status='running' OR (completed_at > NOW() - INTERVAL '1 hour'))`;
    if (userId) {
      params.push(userId);
      where += ` AND user_id=$${params.length}`;
    }
    const r = await pgPool.query(
      `SELECT task_id, status, result, error, pending_ids, client_meta, model, prompt, count, content_type, created_at, completed_at
         FROM generation_tasks ${where}
         ORDER BY created_at DESC
         LIMIT 100`,
      params,
    );
    return {
      tasks: r.rows.map((row) => ({
        taskId: row.task_id,
        status: row.status,
        result: row.result || null,
        error: row.error || '',
        pendingIds: row.pending_ids || [],
        clientMeta: row.client_meta || {},
        model: row.model,
        prompt: row.prompt,
        count: row.count,
        contentType: row.content_type,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      })),
    };
  } catch (e) {
    return { tasks: [], error: e.message };
  }
}

// 导出内部调度函数（供测试 / 调试断言 RPM 门控与均匀分配用）
module.exports = {
  generate, generateAsync, getTaskStatus, listActiveTasks, callEndpoint, getByPath, getArrayByPath,
  setLogSink, logError,
  resumeRunningTasks, resumeWaitingArea, resumeRunningImageTasks, persistProviderTaskId, finalizeResumedTask, genericVideoPoll,
  startStuckTaskWatchdog,
  getAcct, normalizeRateLimits, costFor, getAccountStates, setManualState,
  // ── 多 Key 池（同一供应商多把 API Key，各自独立参与生成分配）──
  syncKeyPool, invalidateProviderKeyCache, getKeyStates, pickKey,
  // ── 智能路由（Phase 3.4 / Phase A 切换调用）──
  setRoutingWeights, getRoutingWeights, snapshotAcct, explainRouting,
  buildDispatchSequence, setRoutingV3Enabled, getRoutingV3Enabled, applyRuntimeSettings,
  // ── 等待区（资源全不可用时积压 + 前台"资源不足"提示）───
  getWaitingAreaStatus, enqueueWaiting, dequeueWaiting, waitingAreaSize,
  allResourcesDown, waitingAreaTriggered, setWaitingThreshold, getWaitingThreshold,
  refreshWaitingThreshold, runWaitingPump, updateTaskStatus, planPriority, cancelTask,
  startUploadQueue,
};

// ─── 等待区（资源全不可用时积压请求；超阈值触发前台"资源不足"）───
// 仅当某任务的所有可用供应商都不可用时，dispatchOne 返回 'throttled'；
// 该任务不立即判失败，而是进入等待区后台重试，直到资源恢复或超时。
// 当「所有账号全冷（平台级全不可用）」且「等待区积压 > 阈值」时，前台提示"资源不足"。
// 阈值（默认 10）可调：写入 settings.app.waitingAreaThreshold（管理面板「调度设置」）。
//
// 会员优先调度（商业优化）：不同套餐在等待区拥有不同出队优先级，
// 资源一旦恢复，会员任务优先抢到空闲账号 → 把"资源不足"从痛点转成付费理由。
// 优先级仅影响排队次序，不豁免计费/限额。后续若需可配置权重，可迁到 settings.app.planPriority。
const PLAN_PRIORITY = { free: 0, pro: 1, team: 2 };
function planPriority(plan) {
  return typeof PLAN_PRIORITY[plan] === 'number' ? PLAN_PRIORITY[plan] : 0;
}
const WAITING_AREA = new Map();            // taskId -> { enqueueAt, lastAttempt, attempts, priority, opts }
let WAITING_THRESHOLD = 10;                // 可调：所有资源不可用时，等待区积压超过该值 → 触发前台提示
// 防僵尸安全线（默认 90 分钟）：等待区内任务超过此线仍无可用资源 → 标记 waiting 保留、绝不判失败、绝不释放积分。成败只听生成端。
const WAITING_MAX_WAIT_MS = 90 * 60 * 1000;
// 全局重试上限（默认 10 次）：等待区重试达到该次数仍无可用资源 → 直接判失败并释放积分（关闭任务），不再无限保活。
// 可由 settings.app.waitingAreaMaxRetry 实时覆盖（见 refreshWaitingThreshold）。
let WAITING_MAX_RETRY = 10;
function setWaitingMaxRetry(n) { if (typeof n === 'number' && n > 0) WAITING_MAX_RETRY = Math.floor(n); }
function getWaitingMaxRetry() { return WAITING_MAX_RETRY; }
let waitingPumpRunning = false;

function setWaitingThreshold(n) {
  if (typeof n === 'number' && n > 0) WAITING_THRESHOLD = Math.floor(n);
}
function getWaitingThreshold() { return WAITING_THRESHOLD; }

// 从 settings.app.waitingAreaThreshold 实时刷新内存阈值（供 queue-status 接口在返回前调用，
// 保证前台阈值调整即时生效，无需等下一次 generate()）。
async function refreshWaitingThreshold(pgPool) {
  if (!pgPool) return;
  try {
    const r = await pgPool.query("SELECT value FROM settings WHERE key='app'");
    const v = r.rows[0] && r.rows[0].value;
    if (v && typeof v.waitingAreaThreshold === 'number' && v.waitingAreaThreshold > 0) {
      WAITING_THRESHOLD = Math.floor(v.waitingAreaThreshold);
    }
    if (v && typeof v.waitingAreaMaxRetry === 'number' && v.waitingAreaMaxRetry > 0) {
      WAITING_MAX_RETRY = Math.floor(v.waitingAreaMaxRetry);
    }
  } catch {}
}

// 平台级"所有资源不可用"：所有已加载账号都冷（含手动 cold / 冷却中）。
// 无账号配置时不算"全不可用"，避免误报（没有账号本就该报"无可用模型"而非"资源不足"）。
function allResourcesDown() {
  const entries = Object.values(getAccountStates());
  if (entries.length === 0) return false;
  return entries.every((s) => !!s.cold);
}

function enqueueWaiting(taskId, opts, persisted = null) {
  if (!WAITING_AREA.has(taskId)) {
    WAITING_AREA.set(taskId, {
      enqueueAt: Number(persisted?.enqueueAt) || Date.now(),
      lastAttempt: Number(persisted?.lastAttempt) || 0,
      attempts: Math.max(0, Number(persisted?.attempts) || 0),
      priority: planPriority(opts && opts.userPlan),
      opts,
    });
  }
}
function dequeueWaiting(taskId) { WAITING_AREA.delete(taskId); }
function waitingAreaSize() { return WAITING_AREA.size; }

// 持久化等待任务的完整 opts 到 resume_meta，供重启/崩溃后 resumeWaitingArea 重建内存队列并续重试。
// 过滤函数型/Promise 字段（不可序列化），其余原样存 jsonb。
async function persistWaitingOpts(pgPool, taskId, opts, state = null) {
  if (!pgPool || !taskId || !opts) return;
  try {
    const clean = {};
    for (const k of Object.keys(opts)) {
      const v = opts[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'function') continue;                       // 不持久化函数（onSubmitted 等）
      if (typeof v === 'object' && typeof v.then === 'function') continue; // 不持久化 Promise
      clean[k] = v;
    }
    await pgPool.query(
      `UPDATE generation_tasks SET resume_meta = COALESCE(resume_meta, '{}'::jsonb) || $2::jsonb WHERE task_id=$1`,
      [taskId, JSON.stringify({
        waitingOpts: clean,
        waitingState: state ? {
          enqueueAt: Number(state.enqueueAt) || Date.now(),
          lastAttempt: Number(state.lastAttempt) || 0,
          attempts: Math.max(0, Number(state.attempts) || 0),
        } : undefined,
      })],
    );
  } catch (e) {
    console.warn('[waiting] 持久化 opts 失败:', e.message);
  }
}

// 触发条件：所有资源不可用 且 等待区积压 > 阈值（阈值可调，默认 10）
function waitingAreaTriggered() {
  return allResourcesDown() && waitingAreaSize() > WAITING_THRESHOLD;
}

function getWaitingAreaStatus() {
  const down = allResourcesDown();
  const size = waitingAreaSize();
  let memberWaiting = 0;
  for (const item of WAITING_AREA.values()) if (item.priority > 0) memberWaiting++;
  return {
    waitingAreaSize: size,
    memberWaiting,
    allResourcesDown: down,
    threshold: WAITING_THRESHOLD,
    triggered: down && size > WAITING_THRESHOLD,
  };
}

// 退避间隔：随重试次数指数增长，封顶 30s，避免打爆供应商
function waitingBackoff(attempts) {
  return Math.min(30000, 2000 * Math.pow(1.6, attempts));
}

// 统一任务状态写回（完成 / 失败 / 重置为 running）。done/failed 时落 completed_at。
async function updateTaskStatus(pgPool, taskId, status, result, error, userId) {
  try {
    await pgPool.query(
      `UPDATE generation_tasks SET status=$2, result=$3, error=$4,
         completed_at = CASE WHEN $2 IN ('done','failed') THEN NOW() ELSE completed_at END,
         user_id=$5
       WHERE task_id=$1`,
      [taskId, status, result ? JSON.stringify(result) : null, error || '', userId || null],
    );
  } catch (e) {
    console.warn('[waiting] 更新任务状态失败:', e.message);
  }
}

// ─── 取消任务：释放 held 积分 + 停轮询 + 标记 canceled + 推送 SSE ───
// 权威终态在此执行（与 pollLoop 返回的 canceled 协调：pollLoop 只负责停止轮询并返回 canceled，
// 真正的积分释放 / DB 标记 / 前端推送由本函数完成，generateAsync.then / finalizeResumedTask 仅做幂等兜底）。
async function cancelTask(pgPool, userId, taskId) {
  if (!pgPool) return { ok: false, error: '数据库不可用', code: 503 };
  try {
    const r = await pgPool.query(
      `SELECT task_id, status, user_id, cost, cost_pool, idempotency_key
         FROM generation_tasks WHERE task_id=$1`,
      [taskId],
    );
    if (r.rows.length === 0) return { ok: false, error: '任务不存在', code: 404 };
    const row = r.rows[0];
    // 越权防护：仅任务 owner 可取消
    if (row.user_id && String(row.user_id) !== String(userId)) {
      return { ok: false, error: '无权取消该任务', code: 403 };
    }
    // 终态不可取消：done/failed/canceled 直接拒绝（避免重复释放积分）
    if (row.status === 'done' || row.status === 'failed' || row.status === 'canceled') {
      return { ok: false, error: '任务已结束，无法取消', code: 409 };
    }
    // ① 写入内存取消信号：正在进行的轮询循环下次检查即停止（不再向 provider 轮询）
    cancelledTasks.add(taskId);
    // ② 从等待区移除（若因资源紧张在排队，cancelTask 后不应再被 pump 重试）
    try { dequeueWaiting(taskId); } catch (_) { /* 不在等待区则忽略 */ }
    // ③ 释放 held 积分（按池回退）；幂等，重复取消安全
    try {
      await billing.releaseCredits(pgPool, row.user_id, row.cost, row.idempotency_key, row.cost_pool);
    } catch (e) {
      console.warn('[cancel] 释放积分失败（已忽略，任务仍标记取消）:', e.message);
    }
    // ④ 标记任务已取消（不 set completed_at：updateTaskStatus 的 CASE 仅 done/failed 才置）
    await updateTaskStatus(pgPool, taskId, 'canceled', null, '用户已取消', row.user_id);
    // ⑤ 实时推送 canceled 给前端（前端据此移除 pending 卡片、找回积分）
    realtime.emitTaskUpdate(row.user_id, { taskId, status: 'canceled', error: '用户已取消' });
    console.log(`[cancel] 任务 ${taskId} 已取消，held 积分已释放 userId=${row.user_id || ''}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `取消失败：${e.message}`, code: 500 };
  }
}

// 等待区后台泵：周期性重试积压任务，资源恢复即出队；超时则判失败释放积分。
// 同一进程内单例（waitingPumpRunning 守卫），由首个入队任务触发，跑完自动退出。
async function runWaitingPump(pgPool) {
  if (waitingPumpRunning) return;
  waitingPumpRunning = true;
  try {
    while (WAITING_AREA.size > 0) {
      const now = Date.now();
      const due = [];
      for (const [taskId, item] of WAITING_AREA) {
        if (now - item.enqueueAt > WAITING_MAX_WAIT_MS) {
          due.push({ taskId, item, reason: 'timeout' });
        } else if (item.attempts >= WAITING_MAX_RETRY) {
          // 重试已达上限仍无可用资源 → 直接关闭（判失败 + 释放积分），不再无限保活
          due.push({ taskId, item, reason: 'maxretry' });
        } else if (now - item.lastAttempt >= waitingBackoff(item.attempts)) {
          due.push({ taskId, item, reason: 'retry' });
        }
      }
      // 会员优先出队：priority 降序（会员先抢恢复的资源），同优先级按入队时间升序（FIFO）。
      due.sort((a, b) => (b.item.priority - a.item.priority) || (a.item.enqueueAt - b.item.enqueueAt));
      for (const { taskId, item, reason } of due) {
        if (WAITING_AREA.get(taskId) !== item) continue; // 已被其它分支移除
        // 已取消任务：跳过重试并立即出队（cancelTask 已释放积分，此处不再触碰计费）
        if (cancelledTasks.has(taskId)) { cancelledTasks.delete(taskId); WAITING_AREA.delete(taskId); continue; }
        const opts = item.opts;
        if (reason === 'timeout') {
          // 超时只标 waiting 保留待复核：绝不判失败、绝不释放积分（成败只能听生成端回复）。
          await updateTaskStatus(pgPool, taskId, 'waiting', null, '等待区超过安全线仍无可用资源，任务保留待复核（资源恢复后可重试）', opts.user_id);
          WAITING_AREA.delete(taskId);
          continue;
        }
        if (reason === 'maxretry') {
          // 已经成功结算或进入上传队列的任务，绝不能被滞后的等待区副本反向判 failed/release。
          // 这会发生在恢复/重复入队竞态：生成成功已 commit+enqueue，旧 WAITING_AREA 项稍后又达到重试上限。
          let completionInFlight = false;
          try {
            const settled = await pgPool.query(
              `SELECT EXISTS(
                 SELECT 1 FROM generation_tasks t
                  WHERE t.task_id=$1 AND t.status='done'
               ) OR EXISTS(
                 SELECT 1 FROM generation_tasks t
                 JOIN credit_transactions c ON c.ref=t.idempotency_key AND c.kind='commit'
                  WHERE t.task_id=$1
               ) OR EXISTS(
                 SELECT 1 FROM asset_upload_jobs u WHERE u.task_id=$1
               ) AS protected`,
              [taskId],
            );
            completionInFlight = !!(settled.rows[0] && settled.rows[0].protected);
          } catch (e) {
            // 状态无法核实时安全优先：保留任务，不能误退款/误判失败。
            console.warn('[waiting] maxretry 终态保护查询失败，保留任务:', taskId, e.message);
            completionInFlight = true;
          }
          if (completionInFlight) {
            console.log(`[waiting] 任务 ${taskId} 已结算或已入上传队列，忽略滞后 maxretry`);
            WAITING_AREA.delete(taskId);
            continue;
          }
          // 全局重试上限：确实没有成功/上传证据时才关闭并释放积分。
          await billing.releaseCredits(pgPool, opts.user_id, opts.cost, opts.idempotencyKey, opts.costPool).catch(() => {});
          const msg = `等待区重试 ${WAITING_MAX_RETRY} 次仍无可用资源，任务已自动关闭`;
          await updateTaskStatus(pgPool, taskId, 'failed', null, msg, opts.user_id);
          realtime.emitTaskUpdate(opts.user_id, { taskId, status: 'failed', error: msg });
          console.log(`[waiting] 任务 ${taskId} 重试超 ${WAITING_MAX_RETRY} 次无果，已自动关闭并释放积分 userId=${opts.user_id || ''}`);
          WAITING_AREA.delete(taskId);
          continue;
        }
        item.lastAttempt = now;
        item.attempts += 1;
        // 重试次数/入队时间必须持久化；否则服务重启后 attempts 重置为 0，旧任务会反复获得 10 次额度而长期 running。
        await persistWaitingOpts(pgPool, taskId, opts, item);
        const result = await generate(pgPool, opts);
        const ok = result && result.status === 'success' && Array.isArray(result.images) && result.images.length;
        if (ok) {
          // 搬运与 API 解耦：结算 + 异步入队（不 await OSS 上传）；done 由后台上传队列 worker 发出
          await completeViaQueue(pgPool, {
            userId: opts.user_id, taskId,
            cost: opts.cost, costPool: opts.costPool, idempotencyKey: opts.idempotencyKey,
            ctx: {
              userId: opts.user_id, taskId,
              prompt: opts.prompt,
              model: opts.canonicalModelId || opts.model,
              ratio: (opts && opts.ratio) || (opts.clientMeta && opts.clientMeta.ratio) || '1:1',
              contentType: opts.contentType || 'image',
              pendingIds: (opts && Array.isArray(opts.pendingIds)) ? opts.pendingIds : [],
            },
            providerImages: result.images || [],
            providerVideoUrl: result.videoUrl || null,
            originalResult: result,
          });
          WAITING_AREA.delete(taskId);
        } else if (result && result.status === 'throttled') {
          // 仍不可用：继续留在等待区，下一轮再试（任务保持 running，前台仍显示"生成中"）
        } else {
          await billing.releaseCredits(pgPool, opts.user_id, opts.cost, opts.idempotencyKey, opts.costPool).catch(() => {});
          await updateTaskStatus(pgPool, taskId, 'failed', result, (result && result.error) || '生成失败', opts.user_id);
          WAITING_AREA.delete(taskId);
        }
      }
      if (WAITING_AREA.size === 0) break;
      await sleep(1500);
    }
  } finally {
    waitingPumpRunning = false;
    // 防丢唤醒：旧泵判断队列为空准备退出的瞬间，可能有新任务 enqueue；
    // 新任务调用 runWaitingPump 时因 waitingPumpRunning=true 直接返回，随后旧泵退出，任务将永久卡 running。
    // finally 释放守卫后若队列又非空，必须立即重启泵。
    if (WAITING_AREA.size > 0) {
      queueMicrotask(() => runWaitingPump(pgPool).catch((e) => console.warn('[waiting] pump restart error:', e.message)));
    }
  }
}

// ─── 管理面板用：账号冷热状态快照 + 手动强切（持久化到 rate_limits JSONB / cooldown_ms 列）───
function getAccountStates() {  const out = {};
  const now = Date.now();
  for (const pid of Object.keys(ACCT)) {
    const a = ACCT[pid];
    // 多 Key 池下 legacy 账号的 cold/cooldownUntil/consecutiveRejects 不再代表「能否调度」——
    // per-key CB 与并发已接管所有限流；UI 的「cold 计数」不应被这把 legacy 钥匙污染。
    const pool = AKEYS[pid];
    const multiKey = !!(pool && pool.size > 1);
    out[pid] = {
      capacityModel: a.capacityModel,
      bucketUnitsPerMin: a.bucketB,
      tokens: Math.round(a.bucket.tokens * 100) / 100,
      cap: a.bucket.cap,
      conc: a.conc,
      cooldownUntil: a.cooldownUntil,
      cooldownMs: a.cooldownMs,
      cold: multiKey ? false : isCold(a, now),
      manualState: a.manualState,
      consecutiveRejects: a.consecutiveRejects,
      ops: a.ops,
      poolSize: pool ? pool.size : 0,
    };
  }
  return out;
}

function setManualState(pid, state, cooldownMs, pgPool) {
  const a = ACCT[pid];
  if (a) {
    a.manualState = state || null;
    if (typeof cooldownMs === 'number' && cooldownMs > 0) a.cooldownMs = cooldownMs;
    if (state === 'cold') a.cooldownUntil = Date.now() + (a.cooldownMs || DEFAULT_COOLDOWN_MS);
  }
  // 持久化：manual_state 写入 rate_limits JSONB；cooldown_ms 写独立列（随库恢复，重启后仍生效）
  if (pgPool) {
    pgPool.query('SELECT rate_limits FROM providers WHERE id=$1', [pid])
      .then((r) => {
        if (!r.rows[0]) return;
        const rl = (r.rows[0].rate_limits && typeof r.rows[0].rate_limits === 'object') ? r.rows[0].rate_limits : {};
        if (state) rl.manual_state = state; else delete rl.manual_state;
        const cols = ['rate_limits=$1'];
        const params = [JSON.stringify(rl)];
        if (typeof cooldownMs === 'number' && cooldownMs > 0) { cols.push('cooldown_ms=$2'); params.push(cooldownMs); }
        params.push(pid);
        return pgPool.query(`UPDATE providers SET ${cols.join(', ')} WHERE id=$${params.length}`, params);
      })
      .catch(() => {});
  }
  return a ? { ok: true, state: a.manualState } : { ok: false, error: '账号不存在' };
}
