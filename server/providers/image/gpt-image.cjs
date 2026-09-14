'use strict';
// OpenAI GPT Image 系图像适配器（gpt-image-1 / gpt-image-2 / gpt-image-1.5）
// 从 dispatcher.imageGenerate 的 isGptImageModel 分支抽离，行为与内联实现逐字段等价：
//   - 判定：model 上游 wire 名（upstreamModelName → model_id）含 gpt-image
//   - size 枚举：auto / 1024x1024 / 1536x1024(16:9) / 1024x1536(9:16)；其余比例回退 auto
//   - GPT-Image 官方端点不识别 ratio / resolution / negative_prompt，一律不发送
//     （官方忽略这些字段，但严格的中转站可能报错——negative 仍存库、UI 完整展示，由上层负责）
//   - 图生图/多图合成走顶层 images + extra_body.image（与其余家族共用 attachReferenceImages 规则）
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

const id = 'gpt-image';
const name = 'OpenAI GPT-Image（gpt-image-1/2/1.5）';

// 线格式请求体构造（纯函数，供字节级 wire 测试；与 dispatcher.imageGenerate GPT 分支等价）
function buildVars(payload, model, provider) {
  const p = payload || {};
  const wireName = (model && (model.upstreamModelName || model.model_id)) || '';
  const vars = {
    model: wireName,
    prompt: p.prompt,
    n: shared.clampCount(p.count),
    size: shared.gptImageSize(p.ratio),
  };
  // GPT-Image：不发送 ratio / resolution / negative_prompt（官方端点不识别）
  shared.attachReferenceImages(vars, p.referenceImages, provider, model);
  return vars;
}

async function call(ctx) {
  const vars = buildVars(ctx && ctx.payload, ctx && ctx.model, ctx && ctx.provider);
  return shared.generate(ctx, vars);
}

module.exports = { id, name, call, buildVars };
