'use strict';
const crypto = require('crypto');
const { releaseKeyLease } = require('./key-lease.cjs');

/**
 * Provider admission（分布式准入门，跨 API/worker 副本权威）
 *
 * 权威层级：
 *   - PostgreSQL 是持久任务/账务权威；
 *   - Redis 只做协调（key 租约 + per-key RPM 滑动窗口），不是持久任务权威；
 *   - Redis 协调不可用时一律 fail-closed（返回 null），绝不无限放行：
 *     上层必须把 null 解释为「暂不可受理」，把 item 留在持久队列（queued/retry_wait），
 *     由持久 reaper 稍后重试 —— 任何副本、任何故障形态下都不会出现无限接受。
 *
 * 返回值的语义（调用方必须区分处理，不能一律当作"没有可用 key"）：
 *   - { providerId, keyId, token, expiresAt, release }  —— 准入成功，持租约 + RPM 额度
 *   - { denied:'capacity' } —— 协调成功但所有候选 key 并发满 → 容量背压，短延迟重试
 *   - { denied:'rpm', untilAt } —— 协调成功但所有候选 key 的 per-key RPM 耗尽 → 限速背压，
 *                                  untilAt 为最早腾挪时刻（精确设置 next_attempt_at，避免轮询风暴）
 *   - null                  —— 协调不可用（fail-closed）→ 短延迟重试，不惩罚任何 key
 */

// 原子占位：key 租约（并发上限 + 429 冷却）+ per-key RPM 滑动窗口，一次 EVAL 完成。
// 关键正确性点（相对旧版两阶段实现）：
//   1. 多候选 key 由 Lua 内原子轮换（旧版 JS 侧只传 1 把 key：并发请求各自选各自的 key，
//      跨副本时同一 key 并发会超限 → 429 风暴；现在任一 key 全局占满即拒绝）；
//   2. RPM 检查与租约占用同一 Lua 内完成，RPM 拒绝时不残留租约（旧版 RPM 拒绝依赖 JS 侧
//      补释放，异常路径泄漏并发 slot 直至 TTL 过期）；
//   3. 返回拒绝原因 + RPM 窗口剩余毫秒，调用方据此设置精确的 next_attempt_at。
const ADMIT_LUA = `
local leases=KEYS[1]
local cooldown=KEYS[2]
local cursor=KEYS[3]
local now=tonumber(ARGV[1])
local ttl=tonumber(ARGV[2])
local leaseToken=ARGV[3]
local candidates=cjson.decode(ARGV[4])
local window=tonumber(ARGV[5])
local limit=tonumber(ARGV[6])
local prov=ARGV[7]
redis.call('ZREMRANGEBYSCORE',leases,'-inf',now)
local start=tonumber(redis.call('GET',cursor) or '0')
local rpmDenyUntil=0
for step=0,#candidates-1 do
 local idx=((start+step)%#candidates)+1
 local k=candidates[idx]
 local cooldownUntil=tonumber(redis.call('HGET',cooldown,k.id) or tostring(k.cooldown or 0))
 local rpmKey='generation-v2:keyrpm:'..prov..':'..k.id
 redis.call('ZREMRANGEBYSCORE',rpmKey,'-inf',now-window)
 local count=redis.call('ZCARD',rpmKey)
 if cooldownUntil<=now and count<limit then
  local keyActive=0
  local prefix=k.id..'|'
  local members=redis.call('ZRANGEBYSCORE',leases,'('..now,'+inf')
  for _,m in ipairs(members) do if string.sub(m,1,string.len(prefix))==prefix then keyActive=keyActive+1 end end
  local maxConcurrent=tonumber(k.maxConcurrent or 1)
  if keyActive<maxConcurrent then
   local expires=now+ttl
   redis.call('ZADD',leases,expires,prefix..leaseToken)
   redis.call('ZADD',rpmKey,now,leaseToken)
   redis.call('PEXPIRE',rpmKey,window)
   redis.call('SET',cursor,(idx%#candidates))
   return {'ok',k.id,leaseToken,tostring(expires)}
  end
 end
 if count>=limit then
  local oldest=redis.call('ZRANGE',rpmKey,0,0,'WITHSCORES')
  local oldestScore=0
  if oldest and #oldest>=2 then oldestScore=tonumber(oldest[2]) end
  local freeAt=oldestScore+window-now
  if freeAt>rpmDenyUntil then rpmDenyUntil=freeAt end
 end
end
return {'deny',tostring(rpmDenyUntil)}`;

// 释放时归还本次 RPM 额度（member = leaseToken，准入时写入同一 token）。
const RPM_RELEASE_LUA = `
redis.call('ZREM',ARGV[1],ARGV[2])
return 1`;

// 429 冷却写入共享 Redis（跨副本立即生效；只升不降，避免旧节点覆盖新冷却）。
const COOLDOWN_SET_LUA = `
local cooldown=KEYS[1]
local keyId=ARGV[1]
local untilMs=tonumber(ARGV[2])
local now=tonumber(ARGV[3])
local cur=tonumber(redis.call('HGET',cooldown,keyId) or '0')
if untilMs>cur then redis.call('HSET',cooldown,keyId,tostring(untilMs)) end
local ttl=(math.max(cur,untilMs)-now)/1000
if ttl>0 then redis.call('PEXPIRE',cooldown,ttl*1000) end
return 1`;

function admissionDenied(reason, extra = {}) {
  return Object.assign(Object.create(null), { denied: reason, ...extra });
}

/**
 * 分布式 key 准入（一次原子调用）。
 * @returns Promise<{providerId,keyId,token,expiresAt,release} | {denied, untilAt?} | null>
 *   null = 协调不可用，fail-closed。
 */
async function distributedProviderAdmission(redis, {
  providerId,
  keys,
  key,
  rpm = 60,
  maxConcurrent = 1,
  ttlMs = 120000,
  now = Date.now(),
  token = crypto.randomUUID(),
  failClosed = true,
} = {}) {
  if (!providerId) throw new TypeError('providerId is required');
  const list = (Array.isArray(keys) ? keys : (key ? [key] : []))
    .filter((k) => k && k.id)
    .slice(0, 500)
    .map((k) => ({
      id: String(k.id),
      maxConcurrent: Math.max(1, Number(k.maxConcurrent) || maxConcurrent || 1),
      cooldown: Number(k.cooldownUntil) || 0,
    }));
  if (!list.length) throw new TypeError('at least one key is required');
  if (!redis || typeof redis.eval !== 'function') {
    if (failClosed) return null;
    throw new Error('Redis coordination unavailable');
  }
  const b = `generation-v2:keylease:${providerId}`;
  const nowMs = Number(now) || Date.now();
  let r;
  try {
    r = await redis.eval(
      ADMIT_LUA,
      3,
      `${b}:leases`,
      `${b}:cooldown`,
      `${b}:cursor`,
      nowMs,
      Math.max(1000, Math.min(15 * 60 * 1000, Number(ttlMs) || 120000)),
      String(token),
      JSON.stringify(list),
      60000,
      Math.max(1, Number(rpm) || 60),
      String(providerId),
    );
  } catch (err) {
    if (failClosed) return null;
    throw err;
  }
  if (!r || !Array.isArray(r) || String(r[0]) !== 'ok') {
    const rpmDenyUntil = Number(r && r[1]) || 0;
    if (rpmDenyUntil > 0) {
      return admissionDenied('rpm', { untilAt: nowMs + rpmDenyUntil });
    }
    return admissionDenied('capacity', {});
  }
  const keyId = String(r[1]);
  const leaseToken = String(r[2]);
  const expiresAt = Number(r[3]);
  return {
    providerId,
    keyId,
    token: leaseToken,
    expiresAt,
    async release() {
      const ok = await releaseKeyLease(redis, { providerId, keyId, token: leaseToken });
      // 归还本次 RPM 额度：旧版 RPM 只进不出，失败/取消的调用也永久吃掉一个 RPM 槽位，
      // 冷却期内额度虚高 → 放大 429 背压。best-effort：最坏由 60s 窗口 TTL 自愈。
      try {
        await redis.eval(RPM_RELEASE_LUA, 0, `generation-v2:keyrpm:${providerId}:${keyId}`, leaseToken);
      } catch (_) { /* best-effort */ }
      return ok;
    },
  };
}

/**
 * 把 key 的 429 冷却写入共享 Redis（跨副本立即生效，准入/pickKey 都会跳过它）。
 * 失败不抛 —— 冷却缺失只影响背压强度，不影响正确性（fail-open 在冷却上可接受：
 * 上游 429 本身会再次触发冷却）。
 */
async function markProviderKeyCooldown(redis, { providerId, keyId, untilMs, now = Date.now() } = {}) {
  if (!redis || typeof redis.eval !== 'function' || !providerId || !keyId) return false;
  try {
    await redis.eval(COOLDOWN_SET_LUA, 1, `generation-v2:keylease:${providerId}:cooldown`, String(keyId), String(Number(untilMs) || now), String(now));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * per-key RPM 独立检查（兼容旧调用方；内部权威路径已并入 ADMIT_LUA）。
 * Redis 不可用时返回 false（fail-closed 语义与准入一致，绝不无限放行）。
 */
async function acquirePerKeyRpm(redis, { providerId, keyId, rpm, now = Date.now() } = {}) {
  if (!redis || typeof redis.eval !== 'function') return false;
  const safeRpm = Math.max(1, Number(rpm) || 60);
  const windowMs = 60000;
  const bucketKey = `generation-v2:keyrpm:${providerId}:${keyId}`;
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
  try {
    return Number(await redis.eval(lua, 1, bucketKey, now, windowMs, safeRpm, crypto.randomUUID())) === 1;
  } catch (_) {
    return false;
  }
}

module.exports = { distributedProviderAdmission, acquirePerKeyRpm, markProviderKeyCooldown, admissionDenied, ADMIT_LUA };
