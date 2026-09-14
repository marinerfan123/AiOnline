'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  distributedProviderAdmission,
  resolveQuotaScopes,
  evaluateScopeCapacity,
  parseScopeCapacity,
  quotaScopeAdmission,
  QUOTA_KINDS,
} = require('./provider-admission.cjs');

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

// ── Quota Scope Admission 专用 fake Redis（镜像 provider-admission.cjs 的 Lua 语义）──
function makeQuotaRedis() {
  const inflight = new Map(); // key -> Map(member -> expires)
  const rate = new Map();     // key -> Map(member -> ts)
  const bucket = new Map();   // key -> { tokens, ts }
  const evalCalls = [];
  return {
    evalCalls,
    async eval(lua, keyCount, ...args) {
      evalCalls.push({ lua, keyCount, args });
      const key = args[0];
      if (key.includes(':qscope:inflight:')) {
        if (lua.includes('ZADD')) {
          // acquire concurrency
          const now = Number(args[1]);
          const limit = Number(args[2]);
          const member = args[3];
          const expires = Number(args[4]);
          let set = inflight.get(key);
          if (!set) { set = new Map(); inflight.set(key, set); }
          for (const [m, exp] of set) if (exp <= now) set.delete(m);
          if (set.size >= limit) return 0;
          set.set(member, expires);
          return 1;
        }
        // release concurrency (ZREM)
        const member = args[1];
        const set = inflight.get(key);
        return set && set.delete(member) ? 1 : 0;
      }
      if (key.includes(':qscope:rate:')) {
        const now = Number(args[1]);
        const window = Number(args[2]);
        const limit = Number(args[3]);
        const member = args[4];
        let set = rate.get(key);
        if (!set) { set = new Map(); rate.set(key, set); }
        for (const [m, ts] of set) if (ts <= now - window) set.delete(m);
        if (set.size >= limit) return 0;
        set.set(member, now);
        return 1;
      }
      if (key.includes(':qscope:bucket:')) {
        const now = Number(args[1]);
        const burst = Number(args[2]);
        const sustained = Number(args[3]);
        let b = bucket.get(key);
        if (!b) { b = { tokens: burst, ts: now }; bucket.set(key, b); }
        const refilled = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * sustained);
        if (refilled < 1) { b.tokens = refilled; b.ts = now; return 0; }
        b.tokens = refilled - 1; b.ts = now;
        return 1;
      }
      throw new Error(`unexpected eval for quota redis: key=${key} lua=${lua.slice(0, 40)}`);
    },
    inflightCount(key) { return (inflight.get(key) || new Map()).size; },
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

// ═══════════════════════════════════════════════════════════════════════════
//  L35 — Quota Scope Admission 测试
// ═══════════════════════════════════════════════════════════════════════════

const FOUR_LEVEL_REGISTRY = [
  { scope_id: 'qs-g', scope_code: 'acct', kind: 'global', capacity: { limit_type: 'CONCURRENCY', limit_value: 100 } },
  { scope_id: 'qs-e', scope_code: '/v1/video', kind: 'endpoint', capacity: { limit_type: 'CONCURRENCY', limit_value: 5 } },
  { scope_id: 'qs-m', scope_code: 'veo3.1', kind: 'model', capacity: { limit_type: 'CONCURRENCY', limit_value: 2 } },
  { scope_id: 'qs-o', scope_code: 'txt2vid', kind: 'operation', capacity: { limit_type: 'RPM', limit_value: 10 } },
];

test('resolveQuotaScopes: 四级匹配序 global→endpoint→model→operation（自动派生）', () => {
  const r = resolveQuotaScopes(FOUR_LEVEL_REGISTRY, {
    model: 'veo3.1', operation: 'txt2vid', endpoint: '/v1/video',
  });
  assert.equal(r.ok, true);
  assert.equal(r.unmatched.length, 0);
  assert.deepStrictEqual(r.matched.map((s) => s.scope_id), ['qs-g', 'qs-e', 'qs-m', 'qs-o']);
  assert.deepStrictEqual(r.matched.map((s) => s.kind), QUOTA_KINDS);
});

test('resolveQuotaScopes: 上下文不匹配的 model/operation 不命中；global 恒命中', () => {
  // 无上下文：仅 global 命中
  const noCtx = resolveQuotaScopes(FOUR_LEVEL_REGISTRY, {});
  assert.deepStrictEqual(noCtx.matched.map((s) => s.scope_id), ['qs-g']);

  // model 不匹配 → 只 global + endpoint（若 endpoint 匹配）+ operation
  const wrongModel = resolveQuotaScopes(FOUR_LEVEL_REGISTRY, {
    model: 'kling-1', operation: 'txt2vid', endpoint: '/v1/video',
  });
  assert.deepStrictEqual(wrongModel.matched.map((s) => s.scope_id), ['qs-g', 'qs-e', 'qs-o']);
});

test('resolveQuotaScopes: 显式 scope_code 列表，未知 → unmatched', () => {
  const r = resolveQuotaScopes(FOUR_LEVEL_REGISTRY, { scopes: ['acct', 'veo3.1'] });
  assert.equal(r.ok, true);
  // 显式声明按 kind 序排序：global(acct) 在 model(veo3.1) 前
  assert.deepStrictEqual(r.matched.map((s) => s.scope_code), ['acct', 'veo3.1']);

  const unknown = resolveQuotaScopes(FOUR_LEVEL_REGISTRY, { scopes: ['acct', 'ghost'] });
  assert.equal(unknown.ok, false);
  assert.deepStrictEqual(unknown.unmatched, ['ghost']);
});

test('evaluateScopeCapacity: 容量边界（纯函数）', () => {
  const conc = { scope_id: 's1', scope_code: 'c', kind: 'model', capacity: { limit_type: 'CONCURRENCY', limit_value: 3 } };
  assert.equal(evaluateScopeCapacity(conc, 2).available, true);
  assert.equal(evaluateScopeCapacity(conc, 3).available, false);
  assert.equal(evaluateScopeCapacity(conc, 5).available, false);

  const rpm = { scope_id: 's2', scope_code: 'r', kind: 'operation', capacity: { limit_type: 'RPM', limit_value: 10, window_seconds: 60 } };
  assert.equal(evaluateScopeCapacity(rpm, 9).available, true);
  assert.equal(evaluateScopeCapacity(rpm, 10).available, false);

  const bucket = { scope_id: 's3', scope_code: 'b', kind: 'model', capacity: { limit_type: 'TOKEN_BUCKET' }, burst_sustained: { burst: 5, sustained: 1 } };
  assert.equal(evaluateScopeCapacity(bucket, 0).available, false);
  assert.equal(evaluateScopeCapacity(bucket, 1).available, true);

  const unlimited = { scope_id: 's4', scope_code: 'u', kind: 'global', capacity: {} };
  assert.equal(evaluateScopeCapacity(unlimited, 999).available, true);
  assert.equal(parseScopeCapacity(unlimited).limitType, 'UNLIMITED');
});

test('quotaScopeAdmission: ALL MATCHED 拒（任一命中 scope 超容 → 带 scope_code 拒）', async () => {
  const redis = makeQuotaRedis();
  const registry = [
    { scope_id: 'qs-g', scope_code: 'acct', kind: 'global', capacity: { limit_type: 'CONCURRENCY', limit_value: 5 } },
    { scope_id: 'qs-m', scope_code: 'veo3.1', kind: 'model', capacity: { limit_type: 'CONCURRENCY', limit_value: 1 } },
  ];
  const opts = { providerId: 'p1', scopeRegistry: registry, scopes: ['acct', 'veo3.1'], now: 1000000, ttlMs: 60000 };

  const a = await quotaScopeAdmission(redis, { ...opts, token: 'tok-a' });
  assert.equal(a.admitted, true, 'first admission should admit');
  assert.deepStrictEqual(a.matched.map((s) => s.scope_code), ['acct', 'veo3.1']);

  const b = await quotaScopeAdmission(redis, { ...opts, token: 'tok-b' });
  assert.equal(b.admitted, false, 'second admission should be denied (model concurrency exhausted)');
  assert.equal(b.code, 'ADMISSION_QUOTA_EXCEEDED');
  assert.equal(b.scopeCode, 'veo3.1');

  // 回滚：失败的第二次准入不得占住 global 槽位（release-on-fail）
  assert.equal(redis.inflightCount('generation-v2:qscope:inflight:p1:qs-g'), 1);
  assert.equal(redis.inflightCount('generation-v2:qscope:inflight:p1:qs-m'), 1);

  await a.release();
  assert.equal(redis.inflightCount('generation-v2:qscope:inflight:p1:qs-g'), 0);
  assert.equal(redis.inflightCount('generation-v2:qscope:inflight:p1:qs-m'), 0);
});

test('quotaScopeAdmission: 容量边界（并发 limit=2，第三个拒）', async () => {
  const redis = makeQuotaRedis();
  const registry = [
    { scope_id: 'qs-m', scope_code: 'veo3.1', kind: 'model', capacity: { limit_type: 'CONCURRENCY', limit_value: 2 } },
  ];
  const opts = { providerId: 'p1', scopeRegistry: registry, scopes: ['veo3.1'], now: 2000000, ttlMs: 60000 };
  const a = await quotaScopeAdmission(redis, { ...opts, token: 't1' });
  const b = await quotaScopeAdmission(redis, { ...opts, token: 't2' });
  const c = await quotaScopeAdmission(redis, { ...opts, token: 't3' });
  assert.equal(a.admitted, true);
  assert.equal(b.admitted, true);
  assert.equal(c.admitted, false);
  assert.equal(c.code, 'ADMISSION_QUOTA_EXCEEDED');
  assert.equal(c.scopeCode, 'veo3.1');

  await a.release();
  const d = await quotaScopeAdmission(redis, { ...opts, token: 't4' });
  assert.equal(d.admitted, true, 'release frees a slot → next admission admits');
  await Promise.all([b.release(), d.release()]);
});

test('quotaScopeAdmission: 无 scope 声明放行（兼容：空 registry / 空声明 / 无上下文）', async () => {
  const redis = makeQuotaRedis();
  // 空 registry（provider 未配任何 scope）
  const r1 = await quotaScopeAdmission(redis, { providerId: 'p-empty', scopeRegistry: [], scopes: [] });
  assert.equal(r1.admitted, true);
  assert.equal(r1.matched.length, 0);

  // 空显式声明 + 空 registry
  const r2 = await quotaScopeAdmission(redis, { providerId: 'p-empty', scopeRegistry: [], scopes: ['acct'] });
  assert.equal(r2.admitted, false, 'explicit scope against empty registry → unknown → 拒');
  assert.equal(r2.code, 'ADMISSION_QUOTA_EXCEEDED');

  // 有上下文但 registry 无匹配 scope（无 global / 无对应 model）→ 放行
  const r3 = await quotaScopeAdmission(redis, { providerId: 'p-empty', scopeRegistry: [], model: 'veo3.1' });
  assert.equal(r3.admitted, true);
});

test('quotaScopeAdmission: 未知 scope 拒（显式声明不存在的 scope_code）', async () => {
  const redis = makeQuotaRedis();
  const registry = [
    { scope_id: 'qs-g', scope_code: 'acct', kind: 'global', capacity: { limit_type: 'CONCURRENCY', limit_value: 5 } },
  ];
  const r = await quotaScopeAdmission(redis, { providerId: 'p1', scopeRegistry: registry, scopes: ['acct', 'ghost'] });
  assert.equal(r.admitted, false);
  assert.equal(r.code, 'ADMISSION_QUOTA_EXCEEDED');
  assert.equal(r.scopeCode, 'ghost');
  assert.match(r.reason, /unknown scope_code 'ghost'/);
});

test('quotaScopeAdmission: 非共享池（作用域内独立计数，禁跨 scope 借量）', async () => {
  const redis = makeQuotaRedis();
  const registry = [
    { scope_id: 'qs-a', scope_code: 'scopeA', kind: 'model', capacity: { limit_type: 'CONCURRENCY', limit_value: 1 } },
    { scope_id: 'qs-b', scope_code: 'scopeB', kind: 'operation', capacity: { limit_type: 'CONCURRENCY', limit_value: 1 } },
  ];
  const base = { providerId: 'p1', scopeRegistry: registry, now: 3000000, ttlMs: 60000 };

  // 占满 A（scopeA 并发 1）
  const a = await quotaScopeAdmission(redis, { ...base, scopes: ['scopeA'], token: 'a1' });
  assert.equal(a.admitted, true);

  // A 再进 → 拒（A 满）
  const a2 = await quotaScopeAdmission(redis, { ...base, scopes: ['scopeA'], token: 'a2' });
  assert.equal(a2.admitted, false);
  assert.equal(a2.scopeCode, 'scopeA');

  // B 独立计数 → 放行（A 满不占 B 的量，禁跨 scope 借量）
  const b = await quotaScopeAdmission(redis, { ...base, scopes: ['scopeB'], token: 'b1' });
  assert.equal(b.admitted, true, 'B 独立计数，A 已满不应阻止 B（非共享池）');

  // 同时要 A+B → 拒（A 满），且 B 槽位回滚不占用
  const ab = await quotaScopeAdmission(redis, { ...base, scopes: ['scopeA', 'scopeB'], token: 'ab1' });
  assert.equal(ab.admitted, false);
  assert.equal(ab.scopeCode, 'scopeA');

  assert.equal(redis.inflightCount('generation-v2:qscope:inflight:p1:qs-a'), 1);
  assert.equal(redis.inflightCount('generation-v2:qscope:inflight:p1:qs-b'), 1);

  await Promise.all([a.release(), b.release()]);
  assert.equal(redis.inflightCount('generation-v2:qscope:inflight:p1:qs-a'), 0);
  assert.equal(redis.inflightCount('generation-v2:qscope:inflight:p1:qs-b'), 0);
});

test('quotaScopeAdmission: RPM 窗口 + Token Bucket 边界（Redis 原子）', async () => {
  const redis = makeQuotaRedis();
  // RPM limit=2 / 60s
  const rpmScope = [{ scope_id: 'qs-r', scope_code: 'rpm', kind: 'operation', capacity: { limit_type: 'RPM', limit_value: 2, window_seconds: 60 } }];
  const a = await quotaScopeAdmission(redis, { providerId: 'p1', scopeRegistry: rpmScope, scopes: ['rpm'], now: 0 });
  const b = await quotaScopeAdmission(redis, { providerId: 'p1', scopeRegistry: rpmScope, scopes: ['rpm'], now: 0 });
  const c = await quotaScopeAdmission(redis, { providerId: 'p1', scopeRegistry: rpmScope, scopes: ['rpm'], now: 0 });
  assert.equal(a.admitted, true);
  assert.equal(b.admitted, true);
  assert.equal(c.admitted, false, 'RPM 窗口内第 3 次拒');
  assert.equal(c.code, 'ADMISSION_QUOTA_EXCEEDED');

  // Token bucket burst=3, sustained=0：3 次后拒
  const redis2 = makeQuotaRedis();
  const bucketScope = [{ scope_id: 'qs-t', scope_code: 'tb', kind: 'model', capacity: { limit_type: 'TOKEN_BUCKET' }, burst_sustained: { burst: 3, sustained: 0 } }];
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await quotaScopeAdmission(redis2, { providerId: 'p1', scopeRegistry: bucketScope, scopes: ['tb'], now: 5000000 + i }));
  }
  assert.deepStrictEqual(results.map((r) => r.admitted), [true, true, true, false]);
  assert.equal(results[3].code, 'ADMISSION_QUOTA_EXCEEDED');
  assert.equal(results[3].scopeCode, 'tb');
});

test('quotaScopeAdmission: Redis 不可用 fail-closed（命中 scope 时拒 ADMISSION_QUOTA_UNAVAILABLE）', async () => {
  const registry = [
    { scope_id: 'qs-m', scope_code: 'veo3.1', kind: 'model', capacity: { limit_type: 'CONCURRENCY', limit_value: 2 } },
  ];
  const r = await quotaScopeAdmission(null, { providerId: 'p1', scopeRegistry: registry, scopes: ['veo3.1'] });
  assert.equal(r.admitted, false);
  assert.equal(r.code, 'ADMISSION_QUOTA_UNAVAILABLE');
});
