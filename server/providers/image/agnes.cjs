'use strict';
// Agnes AI 图像适配器（base_url 含 agnes-ai.cn 的 openai-compatible relay）
// 从 dispatcher.imageGenerate 的 isAgnes/sizeFormat='agnes' 分支抽离，行为与内联实现逐字段等价：
//   - sizeFormat='agnes'：size = 分辨率档位字符串（String(resolution || '1k').toUpperCase() → '1K'/'2K'…）
//   - 不发送 resolution / negative_prompt（agnes 图像端点规范不含 negative_prompt，
//     发送会被其严格校验拒绝；negative 仍存库、UI 完整展示，由上层负责）；ratio 正常发送
//   - sizeFormat 可被 model.endpoint.sizeFormat / provider.default_endpoint.sizeFormat 显式覆盖为
//     'openai'（此时走 openai 尺寸表 + 发送 resolution/negative_prompt，与 dispatcher 语义一致）
//   - 图生图/多图合成：顶层 images（兼容 relay）+ extra_body.image（agnes 要求，默认开启）
//
// 契约（与 video/index + video/* 同构的命名/错误码/超时语义）：
//   导出 { id, name, call(ctx), buildVars(payload, model, provider) }
//   call(ctx) → 统一返回：
//     { ok: true,  result: { images: string[] } }
//     { ok: false, code, retryable, message?, httpStatus?, retryAfterMs? }
//   code ∈ NO_API_KEY | UNAUTHORIZED | BAD_REQUEST | RATE_LIMITED | UPSTREAM |
//          TIMEOUT | NETWORK | EMPTY_RESPONSE（超时默认 60s，可经 ctx.timeoutMs 覆盖）
//   ctx：{ apiKey, payload, provider, model, timeoutMs?, fetch? }（fetch 可注入假上游做测试）
const shared = require('./shared.cjs');

const id = 'agnes';
const name = 'Agnes AI 图像（openai-compatible relay）';

// 线格式请求体构造（纯函数，供字节级 wire 测试；与 dispatcher.imageGenerate agnes 分支等价）
function buildVars(payload, model, provider) {
  const p = payload || {};
  const me = (model && model.endpoint) || {};
  const de = (provider && (provider.default_endpoint || provider.defaultEndpoint)) || {};
  const sizeFormat = me.sizeFormat || de.sizeFormat || 'agnes';
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
  // ratio 正常发送（仅 GPT-Image 系列不发）；resolution/negative_prompt 仅 openai 风格发送
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
