'use strict';
// Agnes Video V2.0 适配器（从 dispatcher.videoGenerate 的 isAgnesVideo 分支抽离）
// 行为与原内联实现保持等价：num_frames/frame_rate 控制时长，height/width 控制分辨率，
// image+mode=ti2vid 做图生视频，extra_body.image+mode=keyframes 做关键帧动画。
//
// 端点策略（开箱即用，不再依赖脆弱的 endpoint 显式配置）：
//   - Agnes 本质上是异步任务：create(POST) + poll(GET)，因此一律按 async 处理。
//   - submit 端点：{base_url}/videos（base_url 缺省 https://api.agnes-ai.cn/v1）。
//   - poll   端点：{origin}/agnesapi?video_id=（origin 取 base_url 的协议+主机，去掉 /v1）。
//   - 若 model.endpoint.generate / model.endpoint.poll 已显式配置，则以其为准（覆盖默认）。
//   - 成功时视频地址在 metadata.url（旧版也可能落在根 url），两者都尝试读取。
const { callEndpoint, getByPath, agnesVideoSize, pollLoop, makeError } = require('./shared.cjs');

// 取 base_url 的协议+主机（去掉 /v1 等路径），用于 poll 端点
function agnesRootBase(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.origin;
  } catch {
    return 'https://api.agnes-ai.cn';
  }
}

// 解析/补全 Agnes 规范端点（create + poll），保证开箱即用
function resolveAgnesEndpoint(provider, model) {
  const me = (model && model.endpoint) || {};
  const baseUrl = (provider && provider.base_url) || 'https://api.agnes-ai.cn/v1';
  const rootBase = agnesRootBase(baseUrl);

  // 部分覆盖语义：显式配置只覆盖其提供的键，未提供的键保留默认（否则只配 taskPollIntervalMs
  // 会让 pollEp.path 变 undefined，轮询时 callEndpoint 直接 TypeError）。完整覆盖行为不变。
  const DEFAULT_SUBMIT_EP = { baseUrl, path: '/videos', method: 'POST' };
  const submitEp = me.generate ? { ...DEFAULT_SUBMIT_EP, ...me.generate } : { ...DEFAULT_SUBMIT_EP };
  const taskIdPath = submitEp.taskIdPath || 'video_id';

  const DEFAULT_POLL_EP = {
    baseUrl: rootBase,
    path: '/agnesapi',
    method: 'GET',
    taskQueryParam: 'video_id',
    taskResultPath: 'metadata.url',
    taskStatusPath: 'status',
    taskSuccessValues: ['completed'],
    taskPollIntervalMs: 8000,
  };
  const pollEp = me.poll
    ? { ...DEFAULT_POLL_EP, ...me.poll, baseUrl: me.poll.baseUrl || rootBase }
    : { ...DEFAULT_POLL_EP };

  return { submitEp, pollEp, taskIdPath, baseUrl };
}

// 构造 Agnes 视频提交体（与历史实现逐字段一致）
function buildAgnesVars(opts, model) {
  const { prompt, ratio, durationSec, referenceImages, negative, resolution } = opts;
  const hasImages = Array.isArray(referenceImages) && referenceImages.length > 0;
  const frameRate = 25;
  // num_frames 必须 ≤441 且 = 8n+1
  let numFrames = Math.round((Number(durationSec) || 6) * frameRate);
  numFrames = Math.min(441, Math.max(9, numFrames));
  numFrames = Math.floor((numFrames - 1) / 8) * 8 + 1;
  const { width, height } = agnesVideoSize(ratio, resolution);
  const vars = {
    model: model.upstreamModelName || model.model_id, // Phase 2：上游 wire name 取自 binding（兜底 model_id）
    prompt,
    height,
    width,
    num_frames: numFrames,
    frame_rate: frameRate,
  };
  if (negative) vars.negative_prompt = negative;
  if (hasImages) {
    if (referenceImages.length >= 2) {
      // 关键帧动画：多图进 extra_body.image
      vars.mode = 'keyframes';
      vars.extra_body = { image: referenceImages, mode: 'keyframes' };
    } else {
      // 图生视频
      vars.image = referenceImages[0];
      vars.mode = 'ti2vid';
    }
  }
  return vars;
}

async function submit(provider, model, opts) {
  const apiKey = provider.api_key;
  if (!apiKey) return { videoUrl: '', status: 'error', error: '服务商未配置 API Key' };

  const vars = buildAgnesVars(opts, model);
  const { submitEp, taskIdPath } = resolveAgnesEndpoint(provider, model);

  // 提交任务（create）
  let submitRes;
  try {
    submitRes = await callEndpoint(provider.base_url, submitEp, apiKey, vars);
  } catch (e) {
    return { videoUrl: '', status: 'error', error: `提交异常：${(e && e.message) || String(e)}`.slice(0, 160) };
  }
  const { status, body } = submitRes;
  if (status >= 400) return makeError(body, status, '视频任务提交失败');

  const taskId = String(getByPath(body, taskIdPath) ?? '').trim();
  if (!taskId) return { videoUrl: '', status: 'error', error: '未返回任务 ID（taskIdPath 配置？）' };
  // 提交成功：立即回传 provider 任务 ID，供上层持久化（崩溃恢复续轮询依赖它）。
  return { status: 'submitted', taskId, providerTaskId: taskId, videoUrl: '' };
}

// 续轮询：仅用 provider/model + providerTaskId 重建 pollEp（不依赖内存态），供崩溃恢复重启后复用。
// isCancelled：可选取消信号（dispatcher 注入 cancelledTasks 检查），命中即停止轮询。
async function poll(provider, model, taskId, startedAt = 0, isCancelled = null) {
  const apiKey = provider.api_key;
  const { pollEp } = resolveAgnesEndpoint(provider, model);
  const pollQueryParam = pollEp.taskQueryParam || 'video_id';
  return pollLoop({
    intervalMs: pollEp.taskPollIntervalMs || 8000, adaptive: true, startedAt, isCancelled,
    pollFn: async () => {
      const r = await callEndpoint(provider.base_url, pollEp, apiKey, { [pollQueryParam]: taskId });
      const st = String(getByPath(r.body, pollEp.taskStatusPath || 'status') ?? '').toLowerCase();
      const okVals = (pollEp.taskSuccessValues || ['completed']).map((s) => s.toLowerCase());
      if (okVals.includes(st)) {
        // 成功视频地址优先级：taskResultPath → metadata.url → 根 url（兼容旧版）
        let url = getByPath(r.body, pollEp.taskResultPath || 'metadata.url');
        if (!url) url = getByPath(r.body, 'metadata.url');
        if (!url) url = getByPath(r.body, 'url');
        return url
          ? { videoUrl: String(url), status: 'success' }
          : { videoUrl: '', status: 'error', error: '任务成功但未返回视频 URL（taskResultPath？）' };
      }
      if (st === 'failed' || st === 'error' || st === 'canceled' || st === 'cancelled') {
        // 生成端明确终态失败：用 terminal 'failed'（区别于瞬时 'error'）—— 上层据此立即终态化，
        // 绝不切下一个账号空转（每个 key 会新建真实 provider 任务并轮询到完成，多 key 下会卡 running 数小时）。
        return { videoUrl: '', status: 'failed', error: `视频生成失败：${JSON.stringify(r.body).slice(0, 160)}` };
      }
      return { videoUrl: '', status: 'pending' };
    },
  });
}

// 兼容包装：保持既有 videoGenerate 调用契约不变（提交后立刻轮询）。
async function submitAndPoll(provider, model, opts) {
  const s = await submit(provider, model, opts);
  if (s.status !== 'submitted') return s; // 提交阶段即错，直接透传 error
  return poll(provider, model, s.taskId);
}

module.exports = { submit, poll, submitAndPoll, resolveAgnesEndpoint, agnesRootBase, buildAgnesVars };
