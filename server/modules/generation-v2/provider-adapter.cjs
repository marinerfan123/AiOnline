'use strict';

async function loadItemContext(pg, itemId) {
  const r = await pg.query(
    `SELECT i.*,b.model_id,b.content_type,b.request_payload,b.user_id,b.idempotency_key
       FROM generation_items_v2 i
       JOIN generation_batches_v2 b ON b.batch_id=i.batch_id
      WHERE i.item_id=$1`, [itemId]);
  return r.rows && r.rows[0] ? r.rows[0] : null;
}

function buildSingleImagePayload(item) {
  const src = item.request_payload || {};
  const pendingIds = Array.isArray(src.pendingIds) && src.pendingIds[item.item_index] != null
    ? [src.pendingIds[item.item_index]] : [];
  return {
    ...src,
    model: item.model_id,
    modelId: item.model_id,
    contentType: item.content_type || 'image',
    count: 1,
    idempotencyKey: item.client_request_id || src.idempotencyKey,
    clientRequestId: item.client_request_id || null,
    pendingIds,
  };
}

function normalizeProviderResult(result) {
  const r = result || {};
  if (r.status === 'success') {
    const providerUrl = Array.isArray(r.images) ? r.images[0] : (r.providerUrl || r.imageUrl || null);
    return { status:'success',providerUrl,providerId:r.providerId||null,keyId:r.keyId||null,providerRequestId:r.providerTaskId||r.providerRequestId||null,httpStatus:r.httpStatus||200 };
  }
  return {
    status:'error',providerId:r.providerId||null,keyId:r.keyId||null,
    providerRequestId:r.providerTaskId||r.providerRequestId||null,
    httpStatus:r.httpStatus||(r.rateLimited?429:null),
    errorCode:r.errorCode||(r.rateLimited?'RATE_LIMITED':'PROVIDER_ERROR'),
    errorMessage:r.error||r.errorMessage||'provider error',retryAfter:r.retryAfter||null,
  };
}

function createProviderAdapter({ dispatchSingle } = {}) {
  if (typeof dispatchSingle !== 'function') throw new TypeError('dispatchSingle is required');
  return async function providerGenerate(item) {
    const payload = buildSingleImagePayload(item);
    return normalizeProviderResult(await dispatchSingle(payload,item));
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// §22-23 Driver Contract (L22, 组G1) — 统一 Driver 接口 + 三归一 + compile() 边界 + 工厂
// ═══════════════════════════════════════════════════════════════════════════
// 归一化状态契约（与 applyProviderEvent / queryProviderStatus 返回值「同形」，provider-status-router.cjs）：
//   { status: 'success'|'failed'|'pending'|'not_found'|'unknown', providerUrl?, errorCode?, errorMessage? }
// 三归一：normalizeStatus / normalizeError / normalizeResult 把三种原始输入（状态词 / 错误 / 结果）
//   统一收敛到上述同一契约形状 —— 上层（applyProviderEvent）只认这一个形状，不再猜各家字段。
//
// 统一 Driver 接口（§22 子集，L22 交付）：{ submit, poll, fetch, cancel, compile }。
//   · submit / poll / fetch / cancel：一次 provider 交互的四个运行时动作。
//   · compile()：Provider 差异的唯一边界（§23）——业务输入(Model Operation Input)→provider request，
//     禁 quota/billing/routing 等业务逻辑；Provider 参数不得泄漏回上层(Canvas/Studio/Billing/Router)。
//   其余 §22 方法（capabilities/validateProviderConstraints/prepareAssets/estimateCost/getStatus/
//   getResult/verifyWebhook）属后续 L23-26，本层不强制。

const NORMALIZED_STATUSES = Object.freeze(['success', 'failed', 'pending', 'not_found', 'unknown']);

// 统一 Driver 接口的四个运行时方法（compile 单独校验，见 REQUIRED_DRIVER_SHAPE）。
const DRIVER_METHODS = Object.freeze(['submit', 'poll', 'fetch', 'cancel']);

// 完整接口形状：四个运行时方法 + compile 边界点。
const REQUIRED_DRIVER_SHAPE = Object.freeze([...DRIVER_METHODS, 'compile']);

// driver_kind 词表（单一来源；DB 不设 CHECK，见 0064_driver_contract.sql）。
// 具体 driver（volcengine/fal/vidu + 包装 legacy agnes/minimax/volcano）在 L23-25(组E)
// 通过 registerDriver 注册进来；本层(L22)只定义契约与工厂。
const DRIVER_KINDS = Object.freeze({
  AGNES: 'agnes',
  MINIMAX: 'minimax',
  VOLCANO: 'volcano',
  GENERIC_VIDEO: 'generic-video',
  IMAGE_SYNC: 'image-sync',
  // L22-25 直连 driver（volcengine/fal/vidu）——静态工厂注册（§138 无副作用）后 fromContract 可解析。
  VOLCENGINE: 'volcengine',
  FAL: 'fal',
  VIDU: 'vidu',
});

// 错误码（§70 Error Taxonomy 子集 + 契约层专用码）。三归一与工厂只产出这些码。
const DRIVER_ERROR = Object.freeze({
  UNKNOWN_DRIVER_KIND: 'UNKNOWN_DRIVER_KIND',
  DRIVER_NOT_INSTANTIATED: 'DRIVER_NOT_INSTANTIATED',
  CONTRACT_MISSING: 'CONTRACT_MISSING',
  DRIVER_INTERFACE_INCOMPLETE: 'DRIVER_INTERFACE_INCOMPLETE',
  UNSUPPORTED: 'UNSUPPORTED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMIT',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  CONTENT_POLICY: 'CONTENT_POLICY',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN: 'UNKNOWN',
});

class DriverContractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DriverContractError';
    this.code = code;
    this.status = 'error';
  }
}

// 状态词表（与 providers/video/shared.normalizeVideoStatus、status.cjs 成功/失败集合对齐）。
const SUCCESS_WORDS = ['succeeded', 'success', 'succeed', 'done', 'completed', 'complete', 'finished'];
const FAIL_WORDS = ['failed', 'error', 'cancelled', 'canceled', 'expired', 'rejected'];
const PENDING_WORDS = ['pending', 'processing', 'queued', 'running', 'in_progress', 'submitted', 'created', 'started', 'waiting'];

// 终态失败码（§70）：provider 已确认失败 / 永久性输入与内容错误 → 'failed'。
// 其余（限流/并发/配额/忙/超时/网络/内部/未知）一律 'unknown'——「UNKNOWN 绝不当 FAILED」，
// 与 provider-status-router 头部安全约定一致。
const FAILED_CODES = new Set([
  'AUTH_ERROR', 'INVALID_INPUT', 'UNSUPPORTED_OPERATION', 'UNSUPPORTED_PARAMETER',
  'ASSET_INVALID', 'CONTENT_POLICY', 'PROVIDER_FAILED', 'PROVIDER_TASK_EXPIRED', 'OUTPUT_INVALID',
]);

// ─── 三归一 · normalizeStatus：原始状态词 → 规范枚举 ───
function normalizeStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (SUCCESS_WORDS.includes(s)) return 'success';
  if (FAIL_WORDS.includes(s)) return 'failed';
  if (['not_found', 'notfound', 'missing'].includes(s)) return 'not_found';
  if (PENDING_WORDS.includes(s)) return 'pending';
  return 'unknown';
}

// ─── 三归一 · normalizeError：错误 → { status, errorCode, errorMessage, retryAfter? } ───
function normalizeError(err) {
  const e = (err instanceof Error)
    ? { code: err.code, message: err.message, httpStatus: err.httpStatus, retryAfter: err.retryAfter }
    : (typeof err === 'string' ? { message: err } : (err || {}));
  const rawCode = String(e.code || e.errorCode || '').toUpperCase() || DRIVER_ERROR.UNKNOWN;
  const httpStatus = Number(e.httpStatus || e.statusCode || 0);
  const message = String(e.message || e.errorMessage || '').slice(0, 200) || 'provider error';

  let status;
  if (rawCode === 'NOT_FOUND' || rawCode === 'PROVIDER_TASK_NOT_FOUND' || httpStatus === 404) {
    status = 'not_found';
  } else if (FAILED_CODES.has(rawCode)) {
    status = 'failed';
  } else {
    // 限流/并发/配额/忙/超时/网络/内部/未知 → 'unknown'（可重试、task 未必已建，绝不判 provider failed）
    status = 'unknown';
  }

  const out = { status, errorCode: rawCode, errorMessage: message };
  if (e.retryAfter != null) out.retryAfter = e.retryAfter;
  return out;
}

// ─── 三归一 · normalizeResult：provider 结果 → { status:'success', providerUrl, ... } ───
function normalizeResult(result) {
  const r = result || {};
  const st = normalizeStatus(r.status);
  if (st === 'success') {
    const providerUrl =
      r.providerUrl || r.videoUrl ||
      (Array.isArray(r.images) ? r.images[0] : null) || r.imageUrl || r.url || null;
    const out = { status: 'success', providerUrl: String(providerUrl || '') };
    if (r.providerId != null) out.providerId = r.providerId;
    if (r.keyId != null) out.keyId = r.keyId;
    if (r.providerRequestId != null || r.providerTaskId != null) {
      out.providerRequestId = r.providerRequestId != null ? r.providerRequestId : r.providerTaskId;
    }
    if (r.expiresAt != null) out.expiresAt = r.expiresAt;
    if (r.httpStatus != null) out.httpStatus = r.httpStatus;
    return out;
  }
  // 非成功：保留 pending/not_found 语义（与 queryProviderStatus 同形），失败/未知收敛到 error 分支。
  // 绝不 return null 让调用方猜（§22）。
  if (st === 'pending') return { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'still processing' };
  if (st === 'not_found') return normalizeError({ code: 'NOT_FOUND', message: r.errorMessage || r.error });
  return normalizeError(r.errorCode || r.code ? { code: r.errorCode || r.code, message: r.errorMessage || r.error } : r);
}

// ─── 接口形状校验：缺 submit/poll/fetch/cancel/compile 任一 → DRIVER_INTERFACE_INCOMPLETE ───
function assertDriverShape(driver, { throwError = true } = {}) {
  const missing = [];
  for (const m of REQUIRED_DRIVER_SHAPE) {
    if (!driver || typeof driver[m] !== 'function') missing.push(m);
  }
  if (missing.length) {
    if (throwError) {
      throw new DriverContractError(
        DRIVER_ERROR.DRIVER_INTERFACE_INCOMPLETE,
        `driver missing required methods: ${missing.join(', ')}`
      );
    }
    return missing;
  }
  return [];
}

// ─── compile() 边界（§23）：业务输入→provider request 的唯一封装点，只做委托，禁业务逻辑 ───
function compile(driver, businessInput) {
  if (!driver || typeof driver.compile !== 'function') {
    throw new DriverContractError(DRIVER_ERROR.DRIVER_INTERFACE_INCOMPLETE, 'driver.compile is required (§23)');
  }
  return driver.compile(businessInput);
}

// ─── 工厂 fromContract(providerId, contractRow) → adapter ───
// contractRow：provider_driver_contracts 表行
//   { provider_id, driver_kind, contract_version, capabilities, schema_hash, status }。
// 未知 driver_kind → 抛 DriverContractError(code='UNKNOWN_DRIVER_KIND')（错误码，非 null）。
// 注册表用 Object.create(null) 防 prototype 链键穿透（与 providers/video/index.cjs hasAdapter 同款）。
const _registry = Object.create(null);

// 静态工厂注册表（§138 无副作用）：driver 模块加载时登记 factory 函数引用，
// 不实例化、不 I/O。fromContract 经注入 instantiate（DI 层提供 http/credentials）延迟实例化。
// 与 _registry（完整实例）分离，避免工厂误当作实例被 assertDriverShape 校验。
const _factoryRegistry = Object.create(null);

function registerDriver(driverKind, impl) {
  if (!driverKind || typeof driverKind !== 'string') {
    throw new DriverContractError(DRIVER_ERROR.CONTRACT_MISSING, 'registerDriver: driverKind required');
  }
  assertDriverShape(impl);
  _registry[driverKind] = impl;
  return impl;
}

// 静态工厂注册：仅登记工厂引用（无副作用，不校验形状、不实例化）。
// driverKind 必须是 string，factory 必须是 function。返回 factory。
function registerDriverFactory(driverKind, factory) {
  if (!driverKind || typeof driverKind !== 'string') {
    throw new DriverContractError(DRIVER_ERROR.CONTRACT_MISSING, 'registerDriverFactory: driverKind required');
  }
  if (typeof factory !== 'function') {
    throw new DriverContractError(DRIVER_ERROR.CONTRACT_MISSING, 'registerDriverFactory: factory must be a function');
  }
  _factoryRegistry[driverKind] = factory;
  return factory;
}

function registeredDriverKinds() {
  return Object.keys(_registry);
}

function registeredDriverFactories() {
  return Object.keys(_factoryRegistry);
}

function fromContract(providerId, contractRow, { drivers, instantiate } = {}) {
  if (!providerId || typeof providerId !== 'string') {
    throw new DriverContractError(DRIVER_ERROR.CONTRACT_MISSING, 'fromContract: providerId required');
  }
  const row = contractRow || {};
  const driverKind = row.driver_kind;
  if (!driverKind || typeof driverKind !== 'string') {
    throw new DriverContractError(DRIVER_ERROR.CONTRACT_MISSING, 'fromContract: contractRow.driver_kind required');
  }
  // 解析优先级：显式 drivers 注入 > 静态实例注册表 > 静态工厂注册表（需 instantiate 延迟实例化）。
  let impl;
  if (drivers) {
    impl = drivers[driverKind];
  } else {
    impl = _registry[driverKind];
    if (!impl && _factoryRegistry[driverKind]) {
      // 静态工厂注册（§138 无副作用）：经注入 instantiate 延迟实例化。
      // 未注入 instantiate → 明确报 DRIVER_NOT_INSTANTIATED（非 UNKNOWN_DRIVER_KIND，kind 是已知的）。
      if (typeof instantiate !== 'function') {
        throw new DriverContractError(
          DRIVER_ERROR.DRIVER_NOT_INSTANTIATED,
          `driver_kind "${driverKind}" is registered as a factory; provide fromContract(..., { instantiate }) to resolve`,
        );
      }
      impl = instantiate(_factoryRegistry[driverKind], driverKind);
    }
  }
  if (!impl) {
    throw new DriverContractError(DRIVER_ERROR.UNKNOWN_DRIVER_KIND, `unknown driver_kind: ${driverKind}`);
  }
  assertDriverShape(impl);

  // adapter：统一接口（四方法 + compile 边界）+ 三归一，全部委托 impl。
  // 三归一优先用 impl 自身的（provider-specific 映射），缺省回退本模块规范实现（§22 统一）。
  const adapter = {
    providerId,
    driverKind,
    contractVersion: row.contract_version != null ? row.contract_version : null,
    schemaHash: row.schema_hash != null ? row.schema_hash : null,
    capabilities: row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {},
    contractStatus: row.status != null ? row.status : null,
    submit: (...a) => impl.submit(...a),
    poll: (...a) => impl.poll(...a),
    fetch: (...a) => impl.fetch(...a),
    cancel: (...a) => impl.cancel(...a),
    compile: (input) => compile(impl, input),
    normalizeStatus: (raw) => (typeof impl.normalizeStatus === 'function' ? impl.normalizeStatus(raw) : normalizeStatus(raw)),
    normalizeError: (e) => (typeof impl.normalizeError === 'function' ? impl.normalizeError(e) : normalizeError(e)),
    normalizeResult: (r) => (typeof impl.normalizeResult === 'function' ? impl.normalizeResult(r) : normalizeResult(r)),
  };
  return adapter;
}

module.exports = {
  loadItemContext, buildSingleImagePayload, normalizeProviderResult, createProviderAdapter,
  // §22-23 Driver Contract (L22)
  NORMALIZED_STATUSES, DRIVER_METHODS, REQUIRED_DRIVER_SHAPE, DRIVER_KINDS, DRIVER_ERROR,
  DriverContractError,
  normalizeStatus, normalizeError, normalizeResult,
  assertDriverShape, compile, fromContract, registerDriver, registeredDriverKinds,
  registerDriverFactory, registeredDriverFactories,
};
