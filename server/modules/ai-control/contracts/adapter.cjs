'use strict';
/**
 * M02-A AI Control Plane — Provider Adapter Contract
 *
 * 正式 adapter 契约。普通模块不得直接理解 api_key / provider internal credential /
 * provider-specific routing；一切经 adapter 边界。
 *
 * 契约方法（实现者必须提供，缺失即 fail-fast）：
 *   validate(providerConfig, logicalModel, input)        → {ok, errors}
 *   normalizeInput(logicalModel, input, params)          → provider wire body（纯，含 masked 之外的非敏感字段）
 *   estimateProviderCost(logicalModel, input)            → number|null（成本估算钩子）
 *   submit({ credential, endpoint, body })               → {status:'submitted', taskId} | {status:'error', error}
 *   poll({ credential, endpoint, taskId, ... })          → {status, url?, error?}
 *   cancel({ credential, endpoint, taskId })             → {status:'cancelled'|'not_supported'|'error', ...}
 *   normalizeStatus(raw)                                 → 标准 JOB_STATE（委托 domain/status）
 *   normalizeError(raw, httpStatus)                      → {code, message, retryable}（不泄漏 secret/stack）
 *   normalizeResult(raw)                                 → {url, ...}
 *   verifyWebhook?(headers, body, secret)                → boolean（可选，若 provider 支持）
 *
 * 注意：
 *  - submit/poll/cancel 只接收【已注入的 credential】（由 dispatcher/key-lease 选定后传入），
 *    adapter 本身不持有/选择 key —— 保持 credential authority 在 key pool。
 *  - normalizeInput 是纯函数，便于 compatibility proof（同一输入 → 同一 wire body）。
 */

const REQUIRED_METHODS = [
  'validate', 'normalizeInput', 'estimateProviderCost', 'submit',
  'poll', 'cancel', 'normalizeStatus', 'normalizeError', 'normalizeResult',
];

/**
 * 断言一个对象是合法 adapter（契约检查）。用于注册/装配时 fail-fast。
 * @param {object} adapter
 * @returns {{ok:true}|{ok:false,missing:string[]}}
 */
function assertAdapterContract(adapter) {
  if (!adapter || typeof adapter !== 'object') return { ok: false, missing: ['<adapter>'] };
  const missing = [];
  for (const m of REQUIRED_METHODS) {
    if (typeof adapter[m] !== 'function') missing.push(m);
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}

/**
 * 创建 adapter 注册表。adapter 按 (provider 类别 / protocol) 注册，resolve 时按 provider 解析。
 * 不引入 provider===x 的散判：解析由 resolveKey 策略（显式声明 > base_url 推断 > generic）驱动，
 * 策略本身可被 provider 行字段配置，而非硬编码在业务模块。
 */
function createAdapterRegistry() {
  const adapters = new Map();
  return {
    register(name, adapter) {
      const check = assertAdapterContract(adapter);
      if (!check.ok) throw new Error(`adapter '${name}' 不满足契约，缺失: ${check.missing.join(', ')}`);
      adapters.set(name, adapter);
      return this;
    },
    resolve(key) {
      return adapters.get(key) || null;
    },
    has(key) {
      return adapters.has(key);
    },
    names() {
      return [...adapters.keys()];
    },
  };
}

module.exports = { REQUIRED_METHODS, assertAdapterContract, createAdapterRegistry };
