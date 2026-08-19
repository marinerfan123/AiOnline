'use strict';
// ─── Redis 共享限流（多 worker / 多实例安全，#360 硬约束解法）───
// 替代 dispatcher 原进程内 GLOBAL_ACTIVE / ACCT[pid].bucket / ACCT[pid].conc：
//   · 全局并发 + per-provider 并发  → Redis ZSET 租约（成员带过期分，进程崩溃自动回收，防计数泄漏）
//   · per-provider RPM 令牌桶        → Lua 原子脚本（refill + 扣减一步完成，跨进程一致）
// Redis 可用时为「跨进程权威闸」；Redis 不可用（dev / 抖动）时降级为内存态，
// 与原单进程限流语义一致，保证不下线、不放开限流。

const crypto = require('crypto');

let _redis = null;
let _redisUp = false;
function redis() {
  if (_redis && _redisUp) return _redis;
  try {
    const mod = require('./redis.cjs');
    const r = mod.getRedis && mod.getRedis();
    if (r && mod.isRedisUp && mod.isRedisUp()) { _redis = r; _redisUp = true; return r; }
  } catch (e) { /* redis 未就绪 → 降级内存态 */ }
  return null;
}

// 本地乐观估计（仅用于编排层快速预判，非权威；权威以 Redis 为准）。崩溃/释放不同步时只会「保守低估」→ 安全。
let localGlobal = 0;
const CONC_TTL_MS = 120000; // 单任务最长占用槽位的 TTL（崩溃回收用，须 > 单次生成最长耗时）

// ── 全局并发 ──
const GLOBAL_KEY = 'moling:rl:global:conc';
const globalLua = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
return 1
`;
async function acquireGlobalSlot(max) {
  const id = crypto.randomUUID();
  const r = redis();
  if (!r) { if (localGlobal < max) { localGlobal++; return id; } return null; }
  const now = Date.now();
  try {
    const ok = await r.eval(globalLua, 1, GLOBAL_KEY, String(now), String(max), String(now + CONC_TTL_MS), id);
    if (ok === 1) { localGlobal++; return id; }
    return null;
  } catch (e) { if (localGlobal < max) { localGlobal++; return id; } return null; }
}
async function releaseGlobalSlot(id) {
  if (!id) return;
  localGlobal = Math.max(0, localGlobal - 1);
  const r = redis(); if (!r) return;
  try { await r.eval(`redis.call('ZREM', KEYS[1], ARGV[1])`, 1, GLOBAL_KEY, id); } catch (e) {}
}
function globalIsFull(max) { return localGlobal >= max; }

// ── per-provider 并发 ──
const _provConc = new Map(); // 降级内存态：pid -> Set<id>
function provConcKey(pid) { return `moling:rl:prov:conc:${pid}`; }
const provConcLua = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[2]) then return '' end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
return ARGV[4]
`;
async function incrProviderConc(pid, cap) {
  const id = crypto.randomUUID();
  const r = redis();
  if (!r) {
    let s = _provConc.get(pid);
    if (!s) { s = new Set(); _provConc.set(pid, s); }
    if (s.size < cap) { s.add(id); return id; }
    return null;
  }
  const now = Date.now();
  try {
    const res = await r.eval(provConcLua, 1, provConcKey(pid), String(now), String(cap), String(now + CONC_TTL_MS), id);
    return res ? res : null;
  } catch (e) {
    let s = _provConc.get(pid);
    if (!s) { s = new Set(); _provConc.set(pid, s); }
    if (s.size < cap) { s.add(id); return id; }
    return null;
  }
}
async function decProviderConc(pid, id) {
  if (!id) return;
  const r = redis();
  if (!r) { const s = _provConc.get(pid); if (s) s.delete(id); return; }
  try { await r.eval(`redis.call('ZREM', KEYS[1], ARGV[1])`, 1, provConcKey(pid), id); } catch (e) {}
}

// ── per-provider RPM 令牌桶（Lua 原子）──
const _bucket = new Map(); // 降级内存态：pid -> {tokens, cap, last}
function bucketKey(pid) { return `moling:rl:prov:bucket:${pid}`; }
const bucketLua = `
local cap = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'last', 'cap')
local tokens = tonumber(data[1])
local last = tonumber(data[2])
local storedCap = tonumber(data[3])
if not tokens or not last then tokens = cap; last = now; storedCap = cap end
if storedCap ~= cap then storedCap = cap; tokens = math.min(cap, tokens) end
local dt = (now - last) / 1000
if dt > 0 then tokens = math.min(cap, tokens + dt * (cap / 60)) end
last = now
if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last', last, 'cap', cap)
  return 1
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last', last, 'cap', cap)
return 0
`;
const bucketRefundLua = `
local cap = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'cap')
local tokens = tonumber(data[1]) or 0
local storedCap = tonumber(data[2]) or cap
if storedCap ~= cap then storedCap = cap end
tokens = math.min(cap, tokens + cost)
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'cap', cap)
return tokens
`;
async function tryProviderBucket(pid, cost, cap, now) {
  const r = redis();
  if (!r) {
    let b = _bucket.get(pid);
    if (!b) { b = { tokens: cap, cap, last: now }; _bucket.set(pid, b); }
    if (b.cap !== cap) { b.cap = cap; b.tokens = Math.min(cap, b.tokens); }
    const dt = (now - b.last) / 1000;
    if (dt > 0) b.tokens = Math.min(b.cap, b.tokens + dt * (b.cap / 60));
    b.last = now;
    if (b.tokens >= cost) { b.tokens -= cost; return true; }
    return false;
  }
  try {
    const ok = await r.eval(bucketLua, 1, bucketKey(pid), String(cap), String(cost), String(now));
    return ok === 1;
  } catch (e) { return true; } // 异常放行（降级），避免限流故障阻断生成
}
async function refundProviderBucket(pid, cost, cap) {
  const r = redis();
  if (!r) {
    const b = _bucket.get(pid);
    if (b) { if (b.cap !== cap) b.cap = cap; b.tokens = Math.min(b.cap, b.tokens + cost); }
    return;
  }
  try { await r.eval(bucketRefundLua, 1, bucketKey(pid), String(cap), String(cost)); } catch (e) {}
}

module.exports = {
  acquireGlobalSlot, releaseGlobalSlot, globalIsFull,
  incrProviderConc, decProviderConc,
  tryProviderBucket, refundProviderBucket,
};
