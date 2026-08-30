'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { distributedProviderAdmission, admissionDenied } = require('./provider-admission.cjs');

function makeRedis({ fail = false } = {}) {
  // Track lease members: 'k1|token' -> { expires, rpmKey }
  const leases = new Map();
  // Track RPM records by key: rpmKey -> Set of tokens
  const rpmRecords = new Map();

  return {
    calls: [],
    async eval(lua, keyCount, ...args) {
      this.calls.push({ lua, keyCount, args });
      if (fail) throw new Error('Redis unavailable');

      // RPM release: ZREM with keyCount=0, args[0]=rpmKey, args[1]=token
      if (keyCount === 0 && lua.includes('ZREM')) {
        const rpmKey = args[0];
        const token = args[1];
        const tokens = rpmRecords.get(rpmKey);
        if (tokens && tokens.has(token)) {
          tokens.delete(token);
        }
        return 1;
      }

      // Lease release: ZREM with keyCount=1, args[0]=leasesKey, args[1]=keyId, args[2]=token
      if (keyCount === 1 && lua.includes('ZREM')) {
        const leaseKey = args[0];
        const keyId = args[1];
        const token = args[2];
        const member = `${keyId}|${token}`;
        const existed = leases.delete(member);
        return existed ? 1 : 0;
      }

      // Admission (ADMIT_LUA): has 'leases=KEYS[1]'
      if (lua.includes('leases=KEYS[1]')) {
        // Args layout:
        // [0]=KEYS[1] lease key, [1]=KEYS[2] cooldown key, [2]=KEYS[3] cursor key
        // [3]=ARGV[1] now, [4]=ARGV[2] ttl, [5]=ARGV[3] token
        // [6]=ARGV[4] JSON candidates, [7]=ARGV[5] window, [8]=ARGV[6] limit, [9]=ARGV[7] prov
        const prov = args[9];
        const list = JSON.parse(args[6]);
        const now = Number(args[3]);
        const ttl = Number(args[4]);
        const token = args[5];
        const window = Number(args[7]);
        const limit = Number(args[8]);

        for (const k of list) {
          const rpmKey = `generation-v2:keyrpm:${prov}:${k.id}`;
          const currentRpm = (rpmRecords.get(rpmKey) || new Set()).size;
          const prefix = `${k.id}|`;
          const activeLeases = [...leases.keys()].filter(m => m.startsWith(prefix)).length;

          if (activeLeases < k.maxConcurrent && currentRpm < limit) {
            const member = `${k.id}|${token}`;
            leases.set(member, { expires: now + ttl, rpmKey });
            if (!rpmRecords.has(rpmKey)) {
              rpmRecords.set(rpmKey, new Set());
            }
            rpmRecords.get(rpmKey).add(token);
            return ['ok', k.id, token, String(now + ttl)];
          }
        }
        return ['deny', '0'];
      }

      // Cooldown set
      if (lua.includes('HSET') && lua.includes('cooldown')) {
        return 1;
      }

      return ['ok', 'k1', 'token', '12345'];
    },
    activeLeases() {
      return leases.size;
    },
    getRpmCount(key) {
      return (rpmRecords.get(key) || new Set()).size;
    },
  };
}

test('two independent nodes sharing Redis cannot exceed per-key concurrency', async () => {
  const redis = makeRedis();
  const opts = { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 1, rpm: 10, token: 'node-a' };
  const a = await distributedProviderAdmission(redis, opts);
  const b = await distributedProviderAdmission(redis, { ...opts, token: 'node-b' });
  assert.ok(a);
  assert.ok(b.denied === 'capacity');
  assert.equal(redis.activeLeases(), 1);
  await a.release();
  assert.equal(redis.activeLeases(), 0);
});

test('per-key RPM is authoritative across nodes and releases lease on RPM deny', async () => {
  const redis = makeRedis();
  const a = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 5, rpm: 1, token: 'a' });
  const b = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 5, rpm: 1, token: 'b' });
  assert.ok(a);
  assert.ok(b.denied === 'rpm' || b.denied === 'capacity');
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

test('admissionDenied creates structured denial object', () => {
  const denied = admissionDenied('capacity');
  assert.equal(denied.denied, 'capacity');
  assert.equal(Object.getPrototypeOf(denied), null);
});

test('RPM denial includes untilAt timestamp', async () => {
  const redis = makeRedis();
  const a = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 5, rpm: 1, token: 'a' });
  const b = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 5, rpm: 1, token: 'b' });
  assert.ok(a);
  if (b.denied === 'rpm') {
    assert.ok(typeof b.untilAt === 'number');
    assert.ok(b.untilAt > Date.now());
  }
  await a.release();
});

test('release returns true when lease exists', async () => {
  const redis = makeRedis();
  const a = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 1, rpm: 10, token: 'test' });
  assert.ok(a);
  const result = await a.release();
  assert.equal(result, true);
});

test('release decrements RPM count', async () => {
  const redis = makeRedis();
  const a = await distributedProviderAdmission(redis, { providerId: 'p1', key: { id: 'k1' }, maxConcurrent: 5, rpm: 10, token: 'test' });
  assert.ok(a);
  const rpmKey = 'generation-v2:keyrpm:p1:k1';
  assert.equal(redis.getRpmCount(rpmKey), 1);
  await a.release();
  assert.equal(redis.getRpmCount(rpmKey), 0);
});
