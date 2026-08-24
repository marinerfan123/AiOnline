'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { distributedProviderAdmission } = require('./provider-admission.cjs');

function makeRedis({ fail = false } = {}) {
  const leases = new Map();
  const rpm = new Map();
  return {
    calls: [],
    async eval(lua, keyCount, ...args) {
      this.calls.push({ lua, keyCount, args });
      if (fail) throw new Error('Redis unavailable');
      if (/keyrpm/.test(args[0] || '') || /ZCARD/.test(lua)) {
        const key = args[0];
        const limit = Number(args[3]);
        const n = rpm.get(key) || 0;
        if (n >= limit) return 0;
        rpm.set(key, n + 1);
        return 1;
      }
      if (/ZREM/.test(lua) && keyCount === 1) {
        const keyId = args[1];
        const token = args[2];
        const member = `${keyId}|${token}`;
        const existed = leases.delete(member);
        return existed ? 1 : 0;
      }
      const candidates = JSON.parse(args.at(-1));
      for (const k of candidates) {
        const active = [...leases.keys()].filter(m => m.startsWith(`${k.id}|`)).length;
        if (active < k.maxConcurrent) {
          const token = args[5];
          leases.set(`${k.id}|${token}`, true);
          return [k.id, token, String(Number(args[3]) + Number(args[4]))];
        }
      }
      return null;
    },
    activeLeases() { return leases.size; },
  };
}

test('two independent nodes sharing Redis cannot exceed per-key concurrency', async () => {
  const redis = makeRedis();
  const opts = { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 1, rpm: 10, token: 'node-a' };
  const a = await distributedProviderAdmission(redis, opts);
  const b = await distributedProviderAdmission(redis, { ...opts, token: 'node-b' });
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(redis.activeLeases(), 1);
  await a.release();
  assert.equal(redis.activeLeases(), 0);
});

test('per-key RPM is authoritative across nodes and releases lease on RPM deny', async () => {
  const redis = makeRedis();
  const a = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 5, rpm: 1, token: 'a' });
  const b = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 5, rpm: 1, token: 'b' });
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(redis.activeLeases(), 1, 'second lease must be released after RPM denial');
  await a.release();
});

test('Redis coordination failure fails closed for new shared-key admission', async () => {
  const redis = makeRedis({ fail: true });
  const r = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 1, rpm: 1 });
  assert.equal(r, null);
});

test('release token cannot release another request lease', async () => {
  const redis = makeRedis();
  const a = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 1, rpm: 10, token: 'owned' });
  assert.ok(a);
  const wrong = await require('./key-lease.cjs').releaseKeyLease(redis, { providerId: 'p1', keyId: 'k1', token: 'wrong' });
  assert.equal(wrong, false);
  assert.equal(redis.activeLeases(), 1);
  await a.release();
  assert.equal(redis.activeLeases(), 0);
});
