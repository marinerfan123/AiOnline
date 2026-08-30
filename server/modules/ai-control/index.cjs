'use strict';
/**
 * M02-A/C AI Control Plane — module index / composition root
 *
 * 装配 domain + contracts + repository + service + 已认证 adapter（Agnes）。
 * 这是 control-plane 的唯一入口；server.js / Generation V2 上游配置解析层从这里
 * 拿 service（API projection）与 adapter registry（出站执行边界）。
 *
 * M02-C 新增 domain: revision, grant, routing-policy
 */

const domain = {
  capability: require('./domain/capability.cjs'),
  status: require('./domain/status.cjs'),
  keypool: require('./domain/keypool.cjs'),
  health: require('./domain/health.cjs'),
  pricing: require('./domain/pricing.cjs'),
  routing: require('./domain/routing.cjs'),
  binding: require('./domain/binding.cjs'),
  revision: require('./domain/revision.cjs'),
  grant: require('./domain/grant.cjs'),
  'routing-policy': require('./domain/routing-policy.cjs'),
};
const contracts = {
  adapter: require('./contracts/adapter.cjs'),
};
const repositories = {
  aiControl: require('./repositories/aiControlRepository.cjs'),
};
const services = {
  aiControl: require('./services/aiControlService.cjs'),
  provider: require('./services/providerService.cjs'),
};
const routes = {
  aiControl: require('./routes/aiControlRoutes.cjs'),
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
  routes,
  adapters,
  createAdapterRegistry,
};
