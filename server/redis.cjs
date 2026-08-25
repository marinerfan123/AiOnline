// server/redis.cjs — Phase 0 优雅 Redis 层（CJS，供 ESM server.js 经 import 引用）
// 设计目标：
//   1. lazyConnect —— 启动不阻塞；首次命令才真正连接
//   2. 失败即降级 —— Redis 不可用（没装 / 挂了）时自动落到内存 Map，服务不崩
//   3. 统一异步 API —— kvGet/kvSet/kvIncr/kvExpire 全部返回 Promise，调用方可直接 await
const Redis = require('ioredis');
require('dotenv').config();

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

let redis = null;
let redisUp = false;

// 内存兜底存储（带 TTL）：仅在 Redis 不可用时使用
const mem = new Map(); // key -> { value, expiresAt(ms|null) }

function memSweep() {
  if (mem.size === 0) return;
  const now = Date.now();
  for (const [k, v] of mem) {
    if (v.expiresAt && now >= v.expiresAt) mem.delete(k);
  }
}

try {
  redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    // 前几次指数退避重试，超过 4 次直接放弃（转入内存兜底，不再重试）
    retryStrategy: (times) => (times > 4 ? null : Math.min(times * 200, 1000)),
  });
  redis.on('error', (err) => {
    // 连接级错误不向上抛，仅记录；kv* 调用会自动降级
    if (redisUp) console.warn('[Redis] 连接断开，降级内存:', err.message);
    redisUp = false;
  });
} catch (e) {
  console.warn('[Redis] 初始化失败，使用内存兜底:', e.message);
  redis = null;
}

// 启动期尝试连接；失败不影响服务启动（后续 kv* 走内存兜底）
// If the existing client is stuck in reconnecting/closed state, replace it.
async function initRedis() {
  // If the client exists but is unrecoverable, replace it with a fresh one.
  if (redis && ['reconnecting', 'close', 'end'].includes(redis.status)) {
    try { redis.disconnect(); } catch (_) {}
    redis = null;
  }
  if (!redis) {
    try {
      redis = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        retryStrategy: (times) => (times > 4 ? null : Math.min(times * 200, 1000)),
      });
      redis.on('error', (err) => {
        if (redisUp) console.warn('[Redis] 连接断开，降级内存:', err.message);
        redisUp = false;
      });
    } catch (e) {
      console.warn('[Redis] 初始化失败，使用内存兜底:', e.message);
      redisUp = false;
      return false;
    }
  }
  try {
    await redis.connect();
    redisUp = true;
    console.log('[Redis] 连接成功');
  } catch (e) {
    redisUp = false;
    console.warn('[Redis] 不可用，降级内存兜底:', e.message);
  }
  return redisUp;
}

function isRedisUp() { return redisUp; }

// ── kv API ──
async function kvGet(key) {
  memSweep();
  if (redisUp) {
    try {
      const v = await redis.get(key);
      return v === null ? null : v;
    } catch (e) {
      redisUp = false;
      console.warn('[Redis] kvGet 失败，降级内存:', e.message);
    }
  }
  const e = mem.get(key);
  if (!e) return null;
  if (e.expiresAt && Date.now() >= e.expiresAt) { mem.delete(key); return null; }
  return e.value;
}

async function kvSet(key, value, ttlSec) {
  if (redisUp) {
    try {
      if (ttlSec && ttlSec > 0) await redis.set(key, String(value), 'EX', ttlSec);
      else await redis.set(key, String(value));
      return;
    } catch (e) {
      redisUp = false;
      console.warn('[Redis] kvSet 失败，降级内存:', e.message);
    }
  }
  mem.set(key, { value: String(value), expiresAt: ttlSec && ttlSec > 0 ? Date.now() + ttlSec * 1000 : null });
}

// 固定窗口计数：INCR + 首次设置过期；返回当前窗口内计数
async function kvIncr(key, windowSec) {
  if (redisUp) {
    try {
      const n = await redis.incr(key);
      if (n === 1 && windowSec && windowSec > 0) await redis.expire(key, windowSec);
      return n;
    } catch (e) {
      redisUp = false;
      console.warn('[Redis] kvIncr 失败，降级内存:', e.message);
    }
  }
  // 内存兜底
  memSweep();
  const now = Date.now();
  const e = mem.get(key);
  if (!e || (e.expiresAt && now >= e.expiresAt)) {
    mem.set(key, { value: '1', expiresAt: windowSec && windowSec > 0 ? now + windowSec * 1000 : null });
    return 1;
  }
  const next = parseInt(e.value, 10) + 1;
  e.value = String(next);
  return next;
}

async function kvExpire(key, ttlSec) {
  if (redisUp) {
    try { await redis.expire(key, ttlSec); return; } catch (e) {
      redisUp = false;
      console.warn('[Redis] kvExpire 失败，降级内存:', e.message);
    }
  }
  const e = mem.get(key);
  if (e) e.expiresAt = ttlSec && ttlSec > 0 ? Date.now() + ttlSec * 1000 : null;
}

// Graceful shutdown — disconnects ioredis and prevents background reconnect retries.
// Call this at process exit or test cleanup to drain the event loop.
async function quit() {
  if (!redis) return;
  try {
    redisUp = false;
    await redis.quit();
  } catch (e) {
    // quit may fail if already disconnected — that's fine
  }
  redis = null;
}

// Hard disconnect — stops reconnect attempts immediately.
// Use this during outage simulation to prevent ioredis background timers
// from keeping the event loop alive. Reconnect with initRedis() later.
async function disconnect() {
  if (!redis) return;
  redisUp = false;
  try { redis.disconnect(); } catch (_) {}
}

module.exports = { initRedis, isRedisUp, kvGet, kvSet, kvIncr, kvExpire, getRedis: () => redisUp ? redis : null, disconnect, quit };
