'use strict';
// 火山方舟 Seedance 视频适配器（doubao-seedance-*）
// 提交：POST {base}/contents/generations/tasks  Bearer ARK_API_KEY
// 轮询：GET  {base}/contents/generations/tasks/{id}
// 说明：provider.base_url 应配置为 https://ark.cn-beijing.volces.com/api/v3 （含 /api/v3）
// 字段要点：
//   content[] 数组，text 用 { type:'text', text:prompt }
//   image 用 { type:'image_url', role, image_url:{ url } }（url 嵌套），role ∈ first_frame/last_frame/reference_image
//   顶层 resolution ∈ {480p,720p,1080p,4k}、ratio、duration、seed、camera_fixed、watermark 等可选
//   结果在 video_url（成功态）
const { buildVideoContent, deriveVideoMode, normalizeVideoStatus, pollLoop, makeError, fetchJson } = require('./shared.cjs');

// Volcano 真实分辨率枚举；传入已是枚举则透传，否则把抽象档位映射过去
const VOLCANO_RES = ['480p', '720p', '1080p', '4k'];
function toVolcanoResolution(res) {
  if (VOLCANO_RES.includes(res)) return res;
  const map = { '1k': '480p', '2k': '720p', '3k': '1080p', '4k': '4k', '8k': '4k' };
  return map[String(res || '1k').toLowerCase()] || '720p';
}

// ─── Seedance 系列时长规则（依官方文档）───
//   Seedance 2.5       ：默认 -1（智能选时长）；显式取值 [4, 30]；支持 -1
//   Seedance 2.0 系列  ：取值 [4, 15]；支持 -1
//   Seedance 1.5 pro   ：取值 [4, 12]；支持 -1
//   Seedance 1.0 pro   ：取值 [2, 12]；不支持 -1（智能时退回 max）
const DURATION_RULES = {
  '2.5': { min: 4, max: 30, smart: true },
  '2.0': { min: 4, max: 15, smart: true },
  '1.5': { min: 4, max: 12, smart: true },
  '1.0': { min: 2, max: 12, smart: false },
};
function resolveSeedanceFamily(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.includes('seedance-2-5') || id.includes('seedance2.5')) return '2.5';
  if (id.includes('seedance-2-0') || id.includes('seedance2.0')) return '2.0';
  if (id.includes('seedance-1-5') || id.includes('seedance1.5')) return '1.5';
  if (id.includes('seedance-1-0') || id.includes('seedance1.0')) return '1.0';
  return null; // 未知 → 最宽松兜底
}
// 把前端 duration（-1 表示智能，或正整数秒）映射为火山合法 duration：
//   - -1 且系列支持智能 → 透传 -1
//   - -1 但系列不支持（1.0）→ 退回 max
//   - 显式正整数秒 → 夹到 [min, max]（取整数）
function toVolcanoDuration(durationSec, modelId) {
  const fam = resolveSeedanceFamily(modelId);
  const rule = fam ? DURATION_RULES[fam] : { min: 2, max: 30, smart: true };
  let raw = (durationSec === undefined || durationSec === null) ? -1 : Number(durationSec);
  if (!Number.isFinite(raw)) raw = -1;
  if (raw === -1) return rule.smart ? -1 : rule.max;
  return Math.min(rule.max, Math.max(rule.min, Math.round(raw)));
}

async function submit(provider, model, opts) {
  const apiKey = provider.api_key;
  if (!apiKey) return { videoUrl: '', status: 'error', error: '服务商未配置 API Key' };

  const prompt = opts.prompt || '';
  const refs = opts.referenceImages || [];
  const mode = opts.videoMode || deriveVideoMode(refs);
  const content = buildVideoContent(refs, mode, prompt, 'volcano');

  // 比例处理（依官方文档 ratio 适配规则）：
  //   - 文生视频(t2v)            ：比例可选（含 adaptive），透传用户选择（默认 16:9）
  //   - 首帧/首尾帧生视频(i2v)   ：Seedance 2.5 输出自动保持首帧宽高比，仅支持 adaptive（强制）
  //   - 多模态参考生视频(reference_image)：比例可选（含 adaptive），透传用户选择（默认 adaptive）
  let ratio = opts.ratio || (mode === 't2v' ? '16:9' : 'adaptive');
  const fam = resolveSeedanceFamily(model.model_id);
  if ((mode === 'i2v_first' || mode === 'i2v_first_last') && fam === '2.5') {
    ratio = 'adaptive'; // Seedance 2.5 图生视频仅支持 adaptive
  }

  const resolution = toVolcanoResolution(opts.resolution);
  const duration = toVolcanoDuration(opts.durationSec, model.model_id);

  const body = {
    model: model.upstreamModelName || model.model_id, // Phase 2：上游 wire name 取自 binding（兜底 model_id）；家族/时长判定仍用 model.model_id
    content,
    resolution,
    ratio,
    duration,
  };
  // 可选增强参数：seed / camera_fixed / watermark / generate_audio / frames / priority
  // 当前仅透传模型已配置在 endpoint 里的扩展（保持薄适配）；如需开放，由后台 param_template 控制。

  const base = (provider.base_url || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  let submitRes;
  try {
    submitRes = await fetchJson(`${base}/contents/generations/tasks`, {
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

  // 返回结构：{ id, ... } 或 { data:{ id } } 或错误体 { error:{ code, message } }
  const b = submitRes.body || {};
  const taskId = String(b.id || (b.data && b.data.id) || '').trim();
  if (!taskId) {
    const errMsg = (b.error && (b.error.message || b.error.msg)) || (b.message) || JSON.stringify(b).slice(0, 140);
    return { videoUrl: '', status: 'error', error: `未返回任务 ID：${errMsg}` };
  }
  // 提交成功：立即回传 provider 任务 ID，供上层持久化（崩溃恢复续轮询依赖它）。
  return { status: 'submitted', taskId, providerTaskId: taskId, videoUrl: '' };
}

// 续轮询：仅用 base + providerTaskId 重建轮询端点（不依赖内存态），供崩溃恢复重启后复用。
// isCancelled：可选取消信号（dispatcher 注入 cancelledTasks 检查），命中即停止轮询。
async function poll(provider, model, taskId, startedAt = 0, isCancelled = null) {
  const apiKey = provider.api_key;
  const base = (provider.base_url || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const pollUrl = `${base}/contents/generations/tasks/${taskId}`;
  return pollLoop({
    intervalMs: 5000, adaptive: true, startedAt, isCancelled,
    pollFn: async () => {
      const r = await fetchJson(pollUrl, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
      const root = r.body || {};
      const obj = (root.data && typeof root.data === 'object') ? root.data : root;
      const st = normalizeVideoStatus(obj.status || root.status, 'volcano');
      if (st === 'success') {
        const url = String(obj.video_url || root.video_url || '');
        return url ? { videoUrl: url, status: 'success' } : { videoUrl: '', status: 'error', error: '任务成功但未返回 video_url' };
      }
      if (st === 'failed') return { videoUrl: '', status: 'failed', error: `视频生成失败：${JSON.stringify(obj).slice(0, 160)}` };
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
