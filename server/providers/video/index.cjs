'use strict';
// 视频 provider 路由：把 (provider, model) 映射到具体适配器。
// 解析优先级：
//   1. 显式声明：model.endpoint.videoAdapter 或 provider.default_endpoint.videoAdapter（值 'agnes'|'minimax'|'volcano'）
//   2. base_url 正则推断：agnes-ai.cn → agnes；minimax → minimax；volces/ark.cn-beijing/volcano → volcano
//   3. 兜底 'generic'（dispatcher 内联处理 openai-compatible / custom bodyTemplate 视频端点）
const agnes = require('./agnes.cjs');
const minimax = require('./minimax.cjs');
const volcano = require('./volcano.cjs');

const adapters = { agnes, minimax, volcano };

// 只认自有键：adapters 是普通对象字面量，裸 adapters[v] 会让 'constructor'/'__proto__' 等
// prototype 链键穿透路由（命中 Object.prototype）并让后续 submitAndPoll 抛 TypeError。
const hasAdapter = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(adapters, v);

function resolveKey(provider, model) {
  const me = (model && model.endpoint) || {};
  const pe = (provider && (provider.default_endpoint || provider.defaultEndpoint)) || {};
  const v = me.videoAdapter || pe.videoAdapter;
  if (hasAdapter(v)) return v;
  const base = (provider && provider.base_url) || '';
  if (/agnes-ai\.cn/i.test(base)) return 'agnes';
  if (/minimax/i.test(base)) return 'minimax';
  if (/volces|ark\.cn-beijing|volcano/i.test(base)) return 'volcano';
  return 'generic';
}

async function submitAndPoll(provider, model, opts) {
  const key = resolveKey(provider, model);
  const ad = adapters[key];
  if (!ad) return { videoUrl: '', status: 'error', error: `未找到视频适配器：${key}` };
  return ad.submitAndPoll(provider, model, opts);
}

// 仅提交：返回 { status:'submitted', taskId, providerTaskId } 或 { status:'error', error }。
// 供 dispatcher 在提交后立即持久化 provider task id（崩溃恢复地基）。
async function submit(provider, model, opts) {
  const key = resolveKey(provider, model);
  const ad = adapters[key];
  if (!ad || !ad.submit) return { videoUrl: '', status: 'error', error: `未找到视频适配器或缺少 submit：${key}` };
  return ad.submit(provider, model, opts);
}

// 续轮询：用已持久化的 provider task id 重建轮询（不依赖内存态），供崩溃恢复重启后复用。
// isCancelled：可选取消信号，透传给适配器（命中即停止轮询，返回 canceled）。
async function poll(provider, model, taskId, startedAt = 0, isCancelled = null) {
  const key = resolveKey(provider, model);
  const ad = adapters[key];
  if (!ad || !ad.poll) return { videoUrl: '', status: 'error', error: `未找到视频适配器或缺少 poll：${key}` };
  return ad.poll(provider, model, taskId, startedAt, isCancelled);
}

module.exports = { adapters, resolveKey, submit, poll, submitAndPoll };
