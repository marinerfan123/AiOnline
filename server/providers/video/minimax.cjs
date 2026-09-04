'use strict';
// MiniMax H3 视频 V2 适配器（Hailuo-03）
// 提交：POST {base}/v2/video_generation  Bearer
// 轮询：GET  {base}/v2/query/video_generation/{id}
// 说明：provider.base_url 应配置为 https://api.minimaxi.com/v2 （含 /v2），
//       适配器在该 base 上拼 /video_generation 与 /query/video_generation/{id}。
// 字段要点：
//   content[] 数组，text 用 { type:'text', content:prompt }（content 必填）
//   image 用 { type:'image_url', role, content:url }，role ∈ first_frame/last_frame/reference_image
//   顶层 resolution ∈ {768P,2K}、duration 整数 4..15、ratio（文生必填非 adaptive，图生恒 adaptive）
//   结果在 task.content.url
const { buildVideoContent, deriveVideoMode, normalizeVideoStatus, pollLoop, makeError, fetchJson } = require('./shared.cjs');

// MiniMax 真实分辨率枚举；传入已是枚举则透传，否则把抽象档位映射过去
const MINIMAX_RES = ['768P', '2K'];
function toMiniMaxResolution(res) {
  if (MINIMAX_RES.includes(res)) return res;
  const map = { '1k': '768P', '2k': '768P', '3k': '2K', '4k': '2K', '8k': '2K' };
  return map[String(res || '1k').toLowerCase()] || '768P';
}

async function submit(provider, model, opts) {
  const apiKey = provider.api_key;
  if (!apiKey) return { videoUrl: '', status: 'error', error: '服务商未配置 API Key' };

  const prompt = opts.prompt || '';
  const refs = opts.referenceImages || [];
  const mode = opts.videoMode || deriveVideoMode(refs);
  const content = buildVideoContent(refs, mode, prompt, 'minimax');

  // 文生视频 ratio 必填且非 adaptive；图生/参考视频 ratio 恒 adaptive
  let ratio = opts.ratio || '16:9';
  if (mode !== 't2v') ratio = 'adaptive';

  // duration 整数 4..15
  let duration = Math.round(Number(opts.durationSec) || 6);
  duration = Math.min(15, Math.max(4, duration));

  const resolution = toMiniMaxResolution(opts.resolution);

  const body = {
    model: model.upstreamModelName || model.model_id, // Phase 2：上游 wire name 取自 binding（兜底 model_id）
    content,
    resolution,
    duration,
    ratio,
  };

  const base = (provider.base_url || 'https://api.minimaxi.com/v2').replace(/\/+$/, '');
  let submitRes;
  try {
    submitRes = await fetchJson(`${base}/video_generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
    });
  } catch (e) {
    // 网络错 / 上游 60s 超时归一：不得向上抛（与 agnes.submit 提交异常口径一致），
    // 交上层按瞬时 error 冷却本账号后切换下一家（任务可能未创建，无重复计费风险）。
    const name = (e && e.name) || '';
    const msg = (e && e.message) || String(e);
    const cause = (e && e.cause && e.cause.message) ? `（${e.cause.message}）` : '';
    const reason = name === 'AbortError' ? `上游请求超时（60s 无响应）：${msg}` : `${msg}${cause}`;
    return { videoUrl: '', status: 'error', images: [], error: `提交异常：${reason}`.slice(0, 160) };
  }
  if (submitRes.status >= 400) return makeError(submitRes.body, submitRes.status, '视频任务提交失败');

  // 返回结构：{ task_id, base_resp:{status_code,status_msg} } 或错误体
  const b = submitRes.body || {};
  if (b.base_resp && b.base_resp.status_code && b.base_resp.status_code !== 0 && b.base_resp.status_code !== 1000) {
    return { videoUrl: '', status: 'error', error: `提交失败：${b.base_resp.status_msg || JSON.stringify(b).slice(0, 140)}` };
  }
  const taskId = String(b.task_id || '').trim();
  if (!taskId) return { videoUrl: '', status: 'error', error: `未返回任务 ID：${JSON.stringify(b).slice(0, 160)}` };
  // 提交成功：立即回传 provider 任务 ID，供上层持久化（崩溃恢复续轮询依赖它）。
  return { status: 'submitted', taskId, providerTaskId: taskId, videoUrl: '' };
}

// 续轮询：仅用 base + providerTaskId 重建轮询端点（不依赖内存态），供崩溃恢复重启后复用。
// isCancelled：可选取消信号（dispatcher 注入 cancelledTasks 检查），命中即停止轮询。
async function poll(provider, model, taskId, startedAt = 0, isCancelled = null) {
  const apiKey = provider.api_key;
  const base = (provider.base_url || 'https://api.minimaxi.com/v2').replace(/\/+$/, '');
  const pollUrl = `${base}/query/video_generation/${taskId}`;
  return pollLoop({
    intervalMs: 10000, adaptive: true, startedAt, isCancelled,
    pollFn: async () => {
      const r = await fetchJson(pollUrl, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
      const b2 = r.body || {};
      const task = b2.task || b2;
      const st = normalizeVideoStatus(task.status, 'minimax');
      if (st === 'success') {
        const url = String((task.content && task.content.url) || b2.video_url || '');
        return url ? { videoUrl: url, status: 'success' } : { videoUrl: '', status: 'error', error: '任务成功但未返回视频 URL' };
      }
      if (st === 'failed') return { videoUrl: '', status: 'failed', error: `视频生成失败：${JSON.stringify(task).slice(0, 160)}` };
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

module.exports = { submit, poll, submitAndPoll };
