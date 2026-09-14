'use strict';
const crypto = require('crypto');
const { acquireKeyLease, releaseKeyLease } = require('./key-lease.cjs');

function createTokenBucket() {
  return { tokens: new Map(), expires: new Map() };
}

async function distributedProviderAdmission(redis, {
  providerId,
  key,
  rpm = 60,
  maxConcurrent = 1,
  ttlMs = 120000,
  now = Date.now(),
  token = crypto.randomUUID(),
  failClosed = true,
} = {}) {
  if (!providerId) throw new TypeError('providerId is required');
  if (!key || !key.id) throw new TypeError('key.id is required');
  if (!redis || typeof redis.eval !== 'function') {
    if (failClosed) return null;
    throw new Error('Redis coordination unavailable');
  }
  const lease = await acquireKeyLease(redis, {
    providerId,
    keys: [{ id: key.id, maxConcurrent, cooldownUntil: key.cooldownUntil || 0 }],
    ttlMs,
    now,
    token,
  });
  if (!lease) return null;

  try {
    const rpmOk = await acquirePerKeyRpm(redis, { providerId, keyId: key.id, rpm, now });
    if (!rpmOk) {
      await releaseKeyLease(redis, { providerId, keyId: key.id, token: lease.token });
      return null;
    }
    return {
      providerId,
      keyId: key.id,
      token: lease.token,
      expiresAt: lease.expiresAt,
      async release() {
        return releaseKeyLease(redis, { providerId, keyId: key.id, token: lease.token });
      },
    };
  } catch (err) {
    await releaseKeyLease(redis, { providerId, keyId: key.id, token: lease.token });
    if (failClosed) return null;
    throw err;
  }
}

async function acquirePerKeyRpm(redis, { providerId, keyId, rpm, now = Date.now() } = {}) {
  const safeRpm = Math.max(1, Number(rpm) || 60);
  const windowMs = 60000;
  const bucketKey = `generation-v2:keyrpm:${providerId}:${keyId}`;
  if (typeof redis.eval === 'function') {
    const lua = `
local key=KEYS[1]
local now=tonumber(ARGV[1])
local window=tonumber(ARGV[2])
local limit=tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE',key,'-inf',now-window)
local count=redis.call('ZCARD',key)
if count>=limit then return 0 end
redis.call('ZADD',key,now,tostring(now)..'-'..ARGV[4])
redis.call('PEXPIRE',key,window)
return 1`;
    return Number(await redis.eval(lua, 1, bucketKey, now, windowMs, safeRpm, crypto.randomUUID())) === 1;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
//  L35 — Quota Scope Admission（§24-27，EXTEND 于 provider-admission.cjs）
//
//  背景（差距 G11）：旧 provider_resource_pool 是「一个 provider 一个并发池」；
//   §24 起改为多维度 scope（global/endpoint/model/operation）叠加作用于同一
//   provider，不再共享单池。本模块在既有「密钥租约 + per-key RPM」之上新增
//   quota scope 准入门：提交前解析命中的全部 scope，ALL MATCHED 才放行。
//
//  裁决依据（实查 0067_quota_cert.sql + §24-26 后定）：
//   · capacity JSONB = { limit_type, limit_value, window_seconds }（§24 词表），
//     默认 '{}' = 无约束（UNLIMITED）。准入门支持 limit_type：
//       CONCURRENCY   → limit_value = 作用域内最大并发（对应旧 max_concurrent）
//       OUTSTANDING   → limit_value = 作用域内最大 in-flight（对应 max_inflight）
//       RPM / RPS     → limit_value = 窗口内请求数，window_seconds 默认 60 / 1
//       TOKEN_BUCKET  → 由 burst_sustained JSONB 裁决（§26）
//   · burst_sustained JSONB = { burst, sustained }：burst = 桶容量，sustained =
//     refill rate（tokens/秒）。仅 TOKEN_BUCKET 使用。
//   · 非共享池：每个 scope 独立 Redis 计数键（键含 scope_id），禁跨 scope 借量。
//   · 四级匹配序：global → endpoint → model → operation；global 恒命中。
// ═══════════════════════════════════════════════════════════════════════════

const QUOTA_KINDS = ['global', 'endpoint', 'model', 'operation'];

// §24 limit_type 词表中「准入门可裁决」的子集（其余 DAILY_*/MONTHLY_*/COST 属账务维度，
// 本门不做裁决 → 对未知/不支持的 limit_type 一律 fail-closed 拒）。
const ADMISSIBLE_LIMIT_TYPES = new Set([
  'CONCURRENCY', 'OUTSTANDING', 'RPM', 'RPS', 'TOKEN_BUCKET',
]);

function scopeBaseKey(providerId, scopeId, kind) {
  return `generation-v2:qscope:${kind}:${providerId}:${scopeId}`;
}

/**
 * 解析单个 scope 的 capacity 裁决配置（纯函数，不做 usage 比较）。
 * @param {object} scope  provider_quota_scopes 行（含 scope_id/scope_code/kind/capacity/burst_sustained）
 * @returns {{valid:boolean, limitType:string, limit:number|null, windowMs:number|null,
 *            burst:number|null, sustained:number|null, reason:string|null}}
 */
function parseScopeCapacity(scope) {
  const cap = (scope && scope.capacity) || {};
  const limitType = String((cap.limit_type || '')).toUpperCase();
  if (!limitType) {
    return { valid: true, limitType: 'UNLIMITED', limit: null, windowMs: null, burst: null, sustained: null, reason: null };
  }
  if (!ADMISSIBLE_LIMIT_TYPES.has(limitType)) {
    return { valid: false, limitType, limit: null, windowMs: null, burst: null, sustained: null, reason: `unsupported limit_type '${cap.limit_type}'` };
  }
  // TOKEN_BUCKET 的裁决量来自 burst_sustained（§26），不使用 limit_value。
  if (limitType === 'TOKEN_BUCKET') {
    const bs = (scope && scope.burst_sustained) || {};
    const burst = Number(bs.burst);
    const sustained = Number(bs.sustained);
    if (!Number.isFinite(burst) || burst < 1 || !Number.isFinite(sustained) || sustained < 0) {
      return { valid: false, limitType, limit: null, windowMs: null, burst: null, sustained: null, reason: 'invalid burst_sustained (require {burst>=1, sustained>=0})' };
    }
    return { valid: true, limitType, limit: null, windowMs: null, burst, sustained, reason: null };
  }
  const limitValue = Number(cap.limit_value);
  if (!Number.isFinite(limitValue) || limitValue < 0) {
    return { valid: false, limitType, limit: null, windowMs: null, burst: null, sustained: null, reason: `invalid limit_value ${JSON.stringify(cap.limit_value)}` };
  }
  const defaultWindow = limitType === 'RPS' ? 1 : 60;
  const windowSeconds = Number(cap.window_seconds);
  const windowMs = (Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : defaultWindow) * 1000;
  return { valid: true, limitType, limit: limitValue, windowMs, burst: null, sustained: null, reason: null };
}

/**
 * 裁决单个 scope 在当前 usage 下是否可放行（纯函数，容量边界测试入口）。
 * usage 语义随 limit_type：CONCURRENCY/OUTSTANDING/RPM/RPS = 当前计数；
 * TOKEN_BUCKET = 当前剩余 token 数。
 * @returns {{available:boolean, limitType:string, limit:number|null, reason:string|null}}
 */
function evaluateScopeCapacity(scope, usage) {
  const c = parseScopeCapacity(scope);
  if (!c.valid) return { available: false, limitType: c.limitType, limit: c.limit, reason: c.reason };
  if (c.limitType === 'UNLIMITED') return { available: true, limitType: c.limitType, limit: Infinity, reason: null };
  if (c.limitType === 'TOKEN_BUCKET') {
    const tokens = Number(usage);
    return { available: tokens > 0, limitType: c.limitType, limit: c.burst, reason: tokens > 0 ? null : 'token bucket exhausted' };
  }
  const used = Number(usage);
  return { available: used < c.limit, limitType: c.limitType, limit: c.limit, reason: used < c.limit ? null : `usage ${used} >= limit ${c.limit}` };
}

/**
 * 解析一次提交命中的 quota scope 集合（纯函数）。
 *
 * 声明路径（二选一）：
 *   1. 显式声明 scopes: scope_code[] —— 每个 scope_code 必须存在于 scopeRegistry
 *      （provider_quota_scopes 该 provider 的 scope 行），未知 scope_code → unmatched。
 *   2. 自动派生：按四级匹配序 global → endpoint → model → operation 从上下文
 *      （endpoint/model/operation）与 scopeRegistry 的 kind 匹配：
 *        · global    恒命中（所有 kind='global' 的 scope）
 *        · endpoint  命中 scope_code === endpoint 的 kind='endpoint' scope
 *        · model     命中 scope_code === model 的 kind='model' scope
 *        · operation 命中 scope_code === operation 的 kind='operation' scope
 *
 * 返回的 matched 按 kind 序排序（global→endpoint→model→operation），同 kind 保持
 * 输入顺序（确定性）；「多 scope 交集」即 matched 全集，须 ALL MATCHED 才放行。
 *
 * @param {Array<object>} scopeRegistry  provider 的 provider_quota_scopes 行数组
 * @param {{scopes?:string[], model?:string, operation?:string, endpoint?:string}} [ctx]
 * @returns {{ok:boolean, matched:Array<object>, unmatched:string[]}}
 */
function resolveQuotaScopes(scopeRegistry, ctx = {}) {
  const rows = Array.isArray(scopeRegistry) ? scopeRegistry : [];
  const byCode = new Map();
  for (const r of rows) if (r && typeof r.scope_code === 'string') byCode.set(r.scope_code, r);

  const explicit = Array.isArray(ctx.scopes) ? ctx.scopes.filter((s) => typeof s === 'string' && s !== '') : [];
  let matched = [];
  const unmatched = [];

  if (explicit.length > 0) {
    // 显式声明：逐个必查；未知 → unmatched（拒）
    for (const code of explicit) {
      const row = byCode.get(code);
      if (row) matched.push(row);
      else unmatched.push(code);
    }
  } else {
    // 自动派生：四级匹配序
    for (const kind of QUOTA_KINDS) {
      const ctxVal = kind === 'endpoint' ? ctx.endpoint
        : kind === 'model' ? ctx.model
        : kind === 'operation' ? ctx.operation
        : null;
      for (const r of rows) {
        if (!r || r.kind !== kind) continue;
        if (kind === 'global' || (ctxVal != null && ctxVal !== '' && r.scope_code === ctxVal)) {
          matched.push(r);
        }
      }
    }
  }

  // 四级匹配序排序：kind 序稳定（同 kind 保持命中顺序）
  const rank = new Map(QUOTA_KINDS.map((k, i) => [k, i]));
  matched = matched
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ka = rank.get(a.r.kind) ?? 99;
      const kb = rank.get(b.r.kind) ?? 99;
      return ka - kb || a.i - b.i;
    })
    .map((x) => x.r);

  return { ok: unmatched.length === 0, matched, unmatched };
}

// ── Redis 原子计数（非共享池：键含 scope_id，禁跨 scope 借量）─────────────

const SCOPE_CONCURRENCY_LUA = `
local key=KEYS[1]
local now=tonumber(ARGV[1])
local limit=tonumber(ARGV[2])
local member=ARGV[3]
local expires=tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE',key,'-inf',now)
local active=redis.call('ZCARD',key)
if active>=limit then return 0 end
redis.call('ZADD',key,expires,member)
redis.call('PEXPIRE',key,expires-now)
return 1`;

const SCOPE_RELEASE_LUA = `return redis.call('ZREM',KEYS[1],ARGV[1])`;

const SCOPE_RATE_LUA = `
local key=KEYS[1]
local now=tonumber(ARGV[1])
local window=tonumber(ARGV[2])
local limit=tonumber(ARGV[3])
local member=ARGV[4]
redis.call('ZREMRANGEBYSCORE',key,'-inf',now-window)
local count=redis.call('ZCARD',key)
if count>=limit then return 0 end
redis.call('ZADD',key,now,member)
redis.call('PEXPIRE',key,window)
return 1`;

const SCOPE_BUCKET_LUA = `
local key=KEYS[1]
local now=tonumber(ARGV[1])
local burst=tonumber(ARGV[2])
local sustained=tonumber(ARGV[3])
local tokens=tonumber(redis.call('HGET',key,'tokens'))
local ts=tonumber(redis.call('HGET',key,'ts'))
if not tokens then tokens=burst end
if not ts then ts=now end
local refilled=tokens + ((now-ts)/1000)*sustained
if refilled>burst then refilled=burst end
if refilled<1 then
  redis.call('HSET',key,'tokens',tostring(refilled),'ts',tostring(now))
  return 0
end
redis.call('HSET',key,'tokens',tostring(refilled-1),'ts',tostring(now))
redis.call('PEXPIRE',key,3600000)
return 1`;

async function acquireScopeConcurrency(redis, { providerId, scopeId, token, limit, ttlMs, now }) {
  const key = scopeBaseKey(providerId, scopeId, 'inflight');
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const expires = Number(now) + Math.max(1000, Number(ttlMs) || 120000);
  return Number(await redis.eval(SCOPE_CONCURRENCY_LUA, 1, key, Number(now), safeLimit, token, expires)) === 1;
}

async function releaseScopeConcurrency(redis, { providerId, scopeId, token }) {
  const key = scopeBaseKey(providerId, scopeId, 'inflight');
  return Number(await redis.eval(SCOPE_RELEASE_LUA, 1, key, token)) >= 0;
}

async function acquireScopeRate(redis, { providerId, scopeId, limit, windowMs, now }) {
  const key = scopeBaseKey(providerId, scopeId, 'rate');
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const safeWindow = Math.max(1000, Number(windowMs) || 60000);
  return Number(await redis.eval(SCOPE_RATE_LUA, 1, key, Number(now), safeWindow, safeLimit, crypto.randomUUID())) === 1;
}

async function acquireScopeBucket(redis, { providerId, scopeId, burst, sustained, now }) {
  const key = scopeBaseKey(providerId, scopeId, 'bucket');
  return Number(await redis.eval(SCOPE_BUCKET_LUA, 1, key, Number(now), Number(burst), Number(sustained))) === 1;
}

/**
 * 单个 scope 的准入获取（裁决 + Redis 原子计数）。
 * @returns {Promise<{ok:boolean, kind:string, reason?:string}>}
 */
async function acquireScopeSlot(redis, { providerId, scope, token, ttlMs, now }) {
  const c = parseScopeCapacity(scope);
  if (!c.valid) return { ok: false, kind: 'invalid', reason: c.reason };
  if (c.limitType === 'UNLIMITED') return { ok: true, kind: 'unlimited' };
  const scopeId = scope.scope_id;
  if (c.limitType === 'CONCURRENCY' || c.limitType === 'OUTSTANDING') {
    const ok = await acquireScopeConcurrency(redis, { providerId, scopeId, token, limit: c.limit, ttlMs, now });
    return ok ? { ok: true, kind: 'concurrency' } : { ok: false, kind: 'concurrency', reason: `${c.limitType} limit ${c.limit} reached` };
  }
  if (c.limitType === 'RPM' || c.limitType === 'RPS') {
    const ok = await acquireScopeRate(redis, { providerId, scopeId, limit: c.limit, windowMs: c.windowMs, now });
    return ok ? { ok: true, kind: 'rate' } : { ok: false, kind: 'rate', reason: `${c.limitType} limit ${c.limit}/${Math.round(c.windowMs / 1000)}s reached` };
  }
  if (c.limitType === 'TOKEN_BUCKET') {
    const ok = await acquireScopeBucket(redis, { providerId, scopeId, burst: c.burst, sustained: c.sustained, now });
    return ok ? { ok: true, kind: 'bucket' } : { ok: false, kind: 'bucket', reason: 'token bucket exhausted' };
  }
  return { ok: false, kind: 'invalid', reason: `unsupported limit_type '${c.limitType}'` };
}

/** 释放已获取的并发型 scope 槽位（rate/bucket 无释放语义）。 */
async function releaseScopeSlots(redis, { providerId, acquired, token }) {
  for (const { scope, kind } of acquired || []) {
    if (kind === 'concurrency') {
      await releaseScopeConcurrency(redis, { providerId, scopeId: scope.scope_id, token }).catch(() => {});
    }
  }
  return true;
}

/**
 * Quota Scope Admission（L35）。
 *
 * @param {object} redis        Redis 客户端（需 redis.eval）
 * @param {object} opts
 *   - providerId       (required) 服务商 id
 *   - scopeRegistry    provider 的 provider_quota_scopes 行数组（含 scope_id/scope_code/kind/capacity/burst_sustained）
 *   - scopes           显式声明的 scope_code 列表（省略则自动派生）
 *   - model/operation/endpoint   自动派生上下文（四级匹配）
 *   - ttlMs/now/token/failClosed 同 distributedProviderAdmission
 * @returns {Promise<{admitted:boolean, code?:string, scopeCode?:string, reason?:string,
 *                    matched:Array<object>, release?:Function}>}
 *   拒：{ admitted:false, code:'ADMISSION_QUOTA_EXCEEDED', scopeCode, reason }
 *       或 { admitted:false, code:'ADMISSION_QUOTA_UNAVAILABLE', reason }（fail-closed）
 *   放行：{ admitted:true, matched:[...], release():Promise<boolean> }
 */
async function quotaScopeAdmission(redis, opts = {}) {
  const {
    providerId,
    scopeRegistry = [],
    scopes,
    model,
    operation,
    endpoint,
    ttlMs = 120000,
    now = Date.now(),
    token = crypto.randomUUID(),
    failClosed = true,
  } = opts;

  if (!providerId) throw new TypeError('providerId is required');

  // 1) 解析命中 scope（四级匹配 / 显式声明）
  const resolved = resolveQuotaScopes(scopeRegistry, { scopes, model, operation, endpoint });
  if (!resolved.ok) {
    const code = resolved.unmatched[0];
    return { admitted: false, code: 'ADMISSION_QUOTA_EXCEEDED', scopeCode: code, reason: `unknown scope_code '${code}'`, matched: resolved.matched };
  }

  // 2) 无命中 scope → 兼容放行（旧绑定无 quota 引用 / provider 未配任何 scope）
  if (resolved.matched.length === 0) {
    return { admitted: true, matched: [], release: async () => true };
  }

  // 3) 命中 scope 须 Redis 原子裁决
  if (!redis || typeof redis.eval !== 'function') {
    if (failClosed) {
      return { admitted: false, code: 'ADMISSION_QUOTA_UNAVAILABLE', scopeCode: resolved.matched[0].scope_code, reason: 'Redis coordination unavailable', matched: resolved.matched };
    }
    throw new Error('Redis coordination unavailable');
  }

  // 4) ALL MATCHED：逐个获取；任一失败 → 回滚已获取并拒（带 scope_code）
  const acquired = [];
  try {
    for (const scope of resolved.matched) {
      const r = await acquireScopeSlot(redis, { providerId, scope, token, ttlMs, now });
      if (!r.ok) {
        await releaseScopeSlots(redis, { providerId, acquired, token });
        return { admitted: false, code: 'ADMISSION_QUOTA_EXCEEDED', scopeCode: scope.scope_code, reason: r.reason, matched: resolved.matched };
      }
      acquired.push({ scope, kind: r.kind });
    }
  } catch (e) {
    await releaseScopeSlots(redis, { providerId, acquired, token }).catch(() => {});
    if (failClosed) return { admitted: false, code: 'ADMISSION_QUOTA_UNAVAILABLE', reason: e.message, matched: resolved.matched };
    throw e;
  }

  return {
    admitted: true,
    matched: resolved.matched,
    async release() {
      return releaseScopeSlots(redis, { providerId, acquired, token });
    },
  };
}

module.exports = {
  distributedProviderAdmission,
  acquirePerKeyRpm,
  // L35 Quota Scope Admission
  QUOTA_KINDS,
  ADMISSIBLE_LIMIT_TYPES,
  parseScopeCapacity,
  evaluateScopeCapacity,
  resolveQuotaScopes,
  quotaScopeAdmission,
  releaseScopeSlots,
};
