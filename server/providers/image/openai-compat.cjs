'use strict';
// OpenAI 兼容 / 自定义端点图像适配器（DALL-E 3 / SD / relay / custom bodyTemplate 端点）
// 从 dispatcher.imageGenerate 的默认分支（protocol 非 custom 的标准 images/generations）
// + custom protocol 分支（callEndpoint + bodyTemplate + imageFieldPath）抽离，行为与内联实现逐字段等价：
//   - sizeFormat 默认 'openai'：ratio → size 表（1792x1024 等）+ resolution 倍增（1k/2k/4k/8k）
//   - sizeFormat 可被 model.endpoint.sizeFormat / provider.default_endpoint.sizeFormat 显式覆盖为
//     'agnes'（此时走档位字符串 + 跳过 resolution/negative_prompt，与 dispatcher 语义一致）
//   - 发送 ratio / resolution / negative_prompt（SD/自定义端点支持；negative 缺失则不发送该字段）
//   - protocol === 'custom' 且配置了 generate 端点 → 走 custom 传输：bodyTemplate 占位替换 /
//     端点级 headers / imageFieldPath 提取；custom 也由本适配器承接（本家族 = dispatcher 默认兜底）
//
// 契约（与 video/index + video/* 同构的命名/错误码/超时语义）：
//   导出 { id, name, call(ctx), buildVars(payload, model, provider) }
//   call(ctx) → 统一返回：
//     { ok: true,  result: { images: string[] } }
//     { ok: false, code, retryable, message?, httpStatus?, retryAfterMs? }
//   code ∈ NO_API_KEY | UNAUTHORIZED | BAD_REQUEST | RATE_LIMITED | UPSTREAM |
//          TIMEOUT | NETWORK | EMPTY_RESPONSE | UNKNOWN_PROVIDER（超时默认 60s，可经 ctx.timeoutMs 覆盖）
//   ctx：{ apiKey, payload, provider, model, timeoutMs?, fetch? }（fetch 可注入假上游做测试）
const shared = require('./shared.cjs');

const id = 'openai-compat';
const name = 'OpenAI 兼容 / 自定义端点（默认）';

// 线格式请求体构造（纯函数，供字节级 wire 测试；与 dispatcher.imageGenerate 默认分支等价）
function buildVars(payload, model, provider) {
  const p = payload || {};
  const me = (model && model.endpoint) || {};
  const de = (provider && (provider.default_endpoint || provider.defaultEndpoint)) || {};
  const sizeFormat = me.sizeFormat || de.sizeFormat || 'openai';
  const wireName = (model && (model.upstreamModelName || model.model_id)) || '';
  const agnesStyle = sizeFormat === 'agnes';

  const vars = {
    model: wireName,
    prompt: p.prompt,
    n: shared.clampCount(p.count),
    size: agnesStyle
      ? shared.agnesImageSize(p.resolution)
      : shared.openaiImageSize(p.ratio, p.resolution),
  };
  vars.ratio = p.ratio;
  if (!agnesStyle) {
    vars.resolution = p.resolution;
    if (p.negative) vars.negative_prompt = p.negative;
  }
  shared.attachReferenceImages(vars, p.referenceImages, provider, model);
  return vars;
}

async function call(ctx) {
  const vars = buildVars(ctx && ctx.payload, ctx && ctx.model, ctx && ctx.provider);
  return shared.generate(ctx, vars);
}

module.exports = { id, name, call, buildVars };
