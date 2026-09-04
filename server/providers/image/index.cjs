'use strict';
// 图像 provider 路由：把 (provider, model) 映射到具体图像适配器（与 providers/video/index.cjs 同构）。
// 解析优先级：
//   1. 显式声明：model.endpoint.imageAdapter 或 provider.default_endpoint.imageAdapter
//      （值 'gpt-image' | 'agnes' | 'openai-compat'）——新供应商可不开代码先配置路由
//   2. model 上游 wire 名含 gpt-image → 'gpt-image'（GPT-Image 官方端点尺寸枚举与线格式特殊）
//   3. base_url 含 agnes-ai.cn → 'agnes'
//   4. 兜底 'openai-compat'（标准 OpenAI 兼容 / custom protocol 端点）
//
// 与 video/index 的差异（有意为之）：video 有 'generic' 伞（dispatcher 内联承接），未注册的显式值
// 可静默回落 base_url 推断；image 无 generic 伞、每家都有独特线格式，显式声明了未注册适配器 = 配置笔误，
// 必须显式拒（resolveKey → null → generate 返 UNKNOWN_PROVIDER），而非静默发错误格式的请求。
const gptImage = require('./gpt-image.cjs');
const agnes = require('./agnes.cjs');
const openaiCompat = require('./openai-compat.cjs');
const { isGptImageModel } = require('./shared.cjs');

const adapters = {
  [gptImage.id]: gptImage,
  [agnes.id]: agnes,
  [openaiCompat.id]: openaiCompat,
};

function resolveKey(provider, model) {
  const me = (model && model.endpoint) || {};
  const pe = (provider && (provider.default_endpoint || provider.defaultEndpoint)) || {};
  const explicit = me.imageAdapter || pe.imageAdapter;
  // 显式声明只接受已注册适配器；未注册（含 constructor/__proto__ 等原型键，hasOwnProperty 防注入）→ null，
  // 由 generate() 统一拒（UNKNOWN_PROVIDER），绝不静默回落推断。
  if (explicit) return Object.prototype.hasOwnProperty.call(adapters, explicit) ? explicit : null;
  if (isGptImageModel(model)) return 'gpt-image';
  const base = (provider && provider.base_url) || '';
  if (/agnes-ai\.cn/i.test(base)) return 'agnes';
  return 'openai-compat';
}

// 统一入口：路由 + 归一返回 { ok, result } | { ok:false, code, retryable, message? }
// ctx：{ apiKey, payload: ImageTask, provider, model, timeoutMs?, fetch? }（见各 adapter 头契约）
async function generate(ctx) {
  if (!ctx || !ctx.provider || !ctx.model) {
    return { ok: false, code: 'UNKNOWN_PROVIDER', retryable: false, message: '缺少 provider/model 配置，无法路由图像服务商' };
  }
  const key = resolveKey(ctx.provider, ctx.model);
  const ad = Object.prototype.hasOwnProperty.call(adapters, key) ? adapters[key] : null;
  if (!ad || typeof ad.call !== 'function') {
    const label = (ctx.provider.id || ctx.provider.provider_id || '') || JSON.stringify(ctx.provider).slice(0, 80);
    return { ok: false, code: 'UNKNOWN_PROVIDER', retryable: false, message: `未知图像服务商（${key ? `adapter='${key}'` : '显式适配器未注册或缺失配置'}，provider=${label}）` };
  }
  return ad.call(ctx);
}

// 可选能力面：按外部任务标识查询结果（crash-recovery 自动对账用，statusById 钩子）。
// ctx：{ provider, model, providerTaskId?, clientRequestId? }（payload 由具体适配器按需）
// 现有三家适配器（agnes / gpt-image / openai-compat）均为同步 POST images/generations：
//   - 请求体不接收 client_request_id（无法以外部标识幂等/关联上游）
//   - 响应只含图片、无异步任务 id
//   - 无「按 client_request_id / 外部 task 查询结果」的端点
// → queryById 统一返 UNSUPPORTED（statusById 能力缺省 null = 上游不支持，dispatcher 侧钩子保持 null）。
// 未来某适配器若支持异步提交 + 按 id 查询，在该模块导出 queryById(ctx)（与视频适配层 poll 同构）即自动启用：
//   返回 { ok:true, result:{ status:'done'|'pending'|'failed', images?, videoUrl?, consumption?, error? } }
//   或 { ok:false, code, retryable, message? }
async function queryById(ctx) {
  if (!ctx || !ctx.provider || !ctx.model) {
    return { ok: false, code: 'UNSUPPORTED', retryable: false, message: '图像适配层缺失 ctx（provider/model）' };
  }
  const key = resolveKey(ctx.provider, ctx.model);
  const ad = Object.prototype.hasOwnProperty.call(adapters, key) ? adapters[key] : null;
  if (ad && typeof ad.queryById === 'function') {
    try {
      return await ad.queryById(ctx);
    } catch (e) {
      return { ok: false, code: 'UNSUPPORTED', retryable: false, message: `queryById 异常：${(e && e.message) || e}` };
    }
  }
  return {
    ok: false, code: 'UNSUPPORTED', retryable: false,
    message: `图像适配器 '${key || '?'}' 不支持按外部任务标识查询结果（同步 images/generations，无查询端点）`,
  };
}

module.exports = { adapters, resolveKey, generate, queryById };
