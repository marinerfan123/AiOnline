'use strict';
/**
 * M02-A AI Control Plane — module index / composition root
 *
 * 装配 domain + contracts + repository + service + 已认证 adapter（Agnes）。
 * 这是 control-plane 的唯一入口；server.js / Generation V2 上游配置解析层从这里
 * 拿 service（API projection）与 adapter registry（出站执行边界）。
 *
 * 不在此处搬迁旧 runtime；dispatcher/modelhub 仍是执行权威。本模块是它们的
 * 上游配置/解析/审计层（见 docs/system-v2/modules/M02A-ai-control-foundation.md）。
 */

const domain = {
  capability: require('./domain/capability.cjs'),
  status: require('./domain/status.cjs'),
  keypool: require('./domain/keypool.cjs'),
  health: require('./domain/health.cjs'),
  pricing: require('./domain/pricing.cjs'),
  routing: require('./domain/routing.cjs'),
  binding: require('./domain/binding.cjs'),
};
const contracts = {
  adapter: require('./contracts/adapter.cjs'),
};
const repositories = {
  aiControl: require('./repositories/aiControlRepository.cjs'),
};
const services = {
  aiControl: require('./services/aiControlService.cjs'),
};

const adapters = {
  agnes: require('./adapters/agnes.cjs'),
};

/** 创建已注册默认 adapter 的 registry（可扩展；register 会 fail-fast 校验契约）。 */
function createAdapterRegistry() {
  const reg = contracts.adapter.createAdapterRegistry();
  reg.register('agnes', adapters.agnes.createAgnesAdapter());
  return reg;
}

module.exports = {
  domain,
  contracts,
  repositories,
  services,
  adapters,
  createAdapterRegistry,
};
