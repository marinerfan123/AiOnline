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

module.exports = { distributedProviderAdmission, acquirePerKeyRpm };
