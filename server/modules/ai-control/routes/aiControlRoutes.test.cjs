'use strict';
/**
 * G19 — aiControlRoutes dry-run write-path tests.
 *
 * Coverage:
 *   1. Every write op (POST /providers, PATCH /providers/:id, POST …/enable,
 *      POST …/keys, PATCH …/keys/:keyId, DELETE …/keys/:keyId,
 *      POST …/keys/:keyId/cooldown) with dryRun (body.dryRun:true OR
 *      query.dryRun=true) → runs the full service validation (field schema,
 *      existence, optimistic lock, guard) against the fake pg but records
 *      ZERO INSERT/UPDATE/DELETE, fires NO dispatcher onPoolChanged side
 *      effect, and answers { ok:true, dryRun:true, would:{…} }.
 *   2. Dry-run validation failures still return the same 4xx as the real path.
 *   3. Regression: real path (dryRun absent / false) persists exactly as
 *      before — write SQL reaches pg, dispatcher sync fires, payload shape
 *      unchanged.
 * No real DB is used.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiControlRouter } = require('./aiControlRoutes.cjs');

// ── fixture helpers ────────────────────────────────────────────────────────
function providerRow(id, over = {}) {
  return {
    id, name: `Provider ${id}`, type: 'official', base_url: 'https://api.example.test/v1',
    api_key: `sk-legacy-${id}-abcdef1234567890`, supported_types: ['image'],
    enabled: true, protocol: 'openai-compatible', remark: '', revision: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    updated_by: 'seed', ...over,
  };
}

function apiKeyRow(id, providerId, over = {}) {
  return {
    id, provider_id: providerId, api_key: `sk-pool-${id}-abcdefghijklmnopqrstuvwxyz`,
    label: `label-${id}`, status: 'active', weight: 100, rpm: null, concurrency: null,
    health: 'UNKNOWN', cooldown_until: null, last_used_at: null, last_error_code: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...over,
  };
}

const K1_SECRET = apiKeyRow('k1', 'p1').api_key;

/** 状态化 fake pg：读真实求值、写真实变更（仅 real 路径使用）并全部留痕。 */
function fakePg() {
  const providers = [providerRow('p1', { revision: 3 })];
  const apiKeys = [
    apiKeyRow('k1', 'p1', { label: 'agnes-1' }),
    apiKeyRow('k2', 'p1', { label: 'old', status: 'disabled', weight: 0 }),
  ];
  const reads = [];
  const writes = [];
  const fired = [];

  function evalCond(rows, condSql, params) {
    const parts = String(condSql).split(/\s+AND\s+/i);
    return rows.filter((r) => parts.every((p) => {
      const mm = p.match(/^\s*([A-Za-z_]+)\s*=\s*\$(\d+)\s*$/i);
      if (!mm) return true; // 非平凡条件在测试夹具里不出现 → 视为命中
      const v = params[Number(mm[2]) - 1];
      return String(r[String(mm[1]).toLowerCase()] ?? '') === String(v ?? '');
    }));
  }

  const db = {
    providers, apiKeys, reads, writes, fired,
    async query(sql, params = []) {
      const S = String(sql);
      const U = S.toUpperCase().trim();

      if (/^(INSERT|UPDATE|DELETE)\b/.test(U)) writes.push({ sql: S, params: [...params] });

      if (/^INSERT INTO PROVIDERS\b/i.test(U)) {
        const row = {
          id: params[0], name: params[1], type: params[2], base_url: params[3], api_key: params[4],
          supported_types: params[5], enabled: params[6] !== false, protocol: params[7],
          remark: params[8], revision: 1, created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(), updated_by: params[9] ?? '',
        };
        if (providers.some((x) => x.id === row.id)) return { rows: [], rowCount: 0 };
        providers.push(row);
        return { rows: [], rowCount: 1 };
      }

      if (/^INSERT INTO API_KEYS\b/i.test(U)) {
        const row = {
          id: params[0], provider_id: params[1], api_key: String(params[2] ?? '').trim(),
          label: params[3] ?? '', status: 'active', weight: Number.isFinite(params[4]) ? params[4] : 100,
          rpm: null, concurrency: null, health: 'UNKNOWN', cooldown_until: null,
          last_used_at: null, last_error_code: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        if (apiKeys.some((x) => x.provider_id === row.provider_id && x.api_key === row.api_key)) {
          return { rows: [], rowCount: 0 };
        }
        apiKeys.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      if (/^UPDATE PROVIDERS\b/i.test(U)) {
        const setRaw = U.slice(U.indexOf('SET ') + 4, U.indexOf(' WHERE'));
        const assigns = setRaw.split(',').map((a) => a.trim());
        const condMatch = S.match(/\bWHERE\s+id=\$(\d+)\s+AND\s+revision=\$(\d+)/i);
        const idIdx = condMatch ? Number(condMatch[1]) : -1;
        const revIdx = condMatch ? Number(condMatch[2]) : -1;
        const target = providers.find((p) => p.id === params[idIdx - 1] && p.revision === params[revIdx - 1]);
        if (!target) return { rows: [], rowCount: 0 };
        for (const a of assigns) {
          const m = a.match(/^([A-Za-z_]+)\s*=\s*\$(\d+)$/i);
          if (m) target[m[1].toLowerCase()] = params[Number(m[2]) - 1];
        }
        target.revision += 1;
        target.updated_at = new Date().toISOString();
        return { rows: [{ revision: target.revision }], rowCount: 1 };
      }

      if (/^UPDATE API_KEYS\b/i.test(U)) {
        const setRaw = U.slice(U.indexOf('SET ') + 4, U.indexOf(' WHERE'));
        const assigns = setRaw.split(',').map((a) => a.trim());
        const condMatch = S.match(/\bWHERE\s+id=\$(\d+)\s+AND\s+provider_id=\$(\d+)/i);
        const idIdx = condMatch ? Number(condMatch[1]) : -1;
        const pidIdx = condMatch ? Number(condMatch[2]) : -1;
        const target = apiKeys.find((k) => k.id === params[idIdx - 1] && k.provider_id === params[pidIdx - 1]);
        if (!target) return { rows: [], rowCount: 0 };
        for (const a of assigns) {
          const m = a.match(/^([A-Za-z_]+)\s*=\s*\$(\d+)$/i);
          if (m) target[m[1].toLowerCase()] = params[Number(m[2]) - 1];
        }
        target.updated_at = new Date().toISOString();
        return { rows: [{ id: target.id }], rowCount: 1 };
      }

      if (/^DELETE FROM API_KEYS\b/i.test(U)) {
        const condMatch = S.match(/\bWHERE\s+id=\$(\d+)\s+AND\s+provider_id=\$(\d+)/i);
        const idIdx = condMatch ? Number(condMatch[1]) : -1;
        const pidIdx = condMatch ? Number(condMatch[2]) : -1;
        const ix = apiKeys.findIndex((k) => k.id === params[idIdx - 1] && k.provider_id === params[pidIdx - 1]);
        if (ix < 0) return { rows: [], rowCount: 0 };
        const [removed] = apiKeys.splice(ix, 1);
        return { rows: [{ id: removed.id }], rowCount: 1 };
      }

      reads.push({ sql: S, params: [...params] });

      // ── dry-run 写模拟用的只读命中判定 ──
      if (/SELECT 1 AS HIT FROM PROVIDERS\b/i.test(U)) {
        const hit = evalCond(providers, S.replace(/.*\bWHERE\s+/i, ''), params);
        return { rows: hit.map(() => ({ hit: 1 })) };
      }
      if (/SELECT 1 AS HIT FROM API_KEYS\b/i.test(U)) {
        const hit = evalCond(apiKeys, S.replace(/.*\bWHERE\s+/i, ''), params);
        return { rows: hit.map(() => ({ hit: 1 })) };
      }

      if (/^SELECT ID FROM PROVIDERS WHERE ID=\$1$/i.test(U)) {
        return { rows: providers.filter((p) => p.id === params[0]) };
      }
      if (/^SELECT REVISION FROM PROVIDERS WHERE ID=\$1$/i.test(U)) {
        const p = providers.find((x) => x.id === params[0]);
        return { rows: p ? [{ revision: p.revision }] : [] };
      }
      if (/^SELECT \* FROM PROVIDERS WHERE ID=\$1$/i.test(U)) {
        const p = providers.find((x) => x.id === params[0]);
        return { rows: p ? [{ ...p }] : [] };
      }
      if (/^SELECT ID, PROVIDER_ID, API_KEY, LABEL, STATUS, WEIGHT, RPM, CONCURRENCY, HEALTH, COOLDOWN_UNTIL, LAST_USED_AT, LAST_ERROR_CODE, CREATED_AT, UPDATED_AT FROM API_KEYS WHERE ID=\$1$/i.test(U)) {
        const k = apiKeys.find((x) => x.id === params[0]);
        return { rows: k ? [{ ...k }] : [] };
      }
      if (/FROM API_KEYS WHERE PROVIDER_ID=\$1 AND API_KEY=\$2$/i.test(U)) {
        const key = String(params[1] ?? '').trim();
        return { rows: apiKeys.filter((x) => x.provider_id === params[0] && x.api_key === key).map((k) => ({ ...k })) };
      }
      if (/^SELECT API_KEY FROM API_KEYS WHERE PROVIDER_ID=\$1$/i.test(U)) {
        return { rows: apiKeys.filter((x) => x.provider_id === params[0]).map((k) => ({ api_key: k.api_key })) };
      }
      if (/FROM API_KEYS WHERE PROVIDER_ID=\$1 ORDER BY CREATED_AT$/i.test(U)) {
        return { rows: apiKeys.filter((x) => x.provider_id === params[0]).map((k) => ({ ...k })) };
      }
      if (/^SELECT COUNT\(\*\)/i.test(U)) {
        return { rows: [{ c: apiKeys.filter((x) => x.provider_id === params[0]).length }] };
      }
      if (/SELECT ID, PROVIDER_ID, API_KEY, LABEL, STATUS, WEIGHT FROM API_KEYS WHERE PROVIDER_ID=\$1/i.test(U)) {
        return { rows: apiKeys.filter((x) => x.provider_id === params[0]).map((k) => ({ ...k })) };
      }
      if (/FROM PROVIDER_MODEL_BINDINGS\b/i.test(U)) return { rows: [] };
      if (/FROM MODELS\b/i.test(U)) return { rows: [] };
      return { rows: [] };
    },
  };
  return db;
}

// ── router harness ─────────────────────────────────────────────────────────
function harness({ authed = true, admin = true } = {}) {
  const db = fakePg();
  let last = null;
  const router = createAiControlRouter({
    pg: db,
    adminRequire: () => admin,
    sessionUser: () => (authed ? { id: 'admin-1', role: 'admin' } : null),
    onPoolChanged: async () => { db.fired.push('onPoolChanged'); },
    sendJSON: (_res, code, data) => { last = { code, data }; },
    parseBody: async (req) => (req.__hasBody ? req.__body : null),
  });

  async function call(method, path, { body, query } = {}) {
    last = null;
    const res = {};
    const req = {
      method, url: path,
      __hasBody: body !== undefined,
      __body: body !== undefined ? body : null,
      query: query || {},
    };
    const urlPath = path.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    await router.handle(req, res, urlPath, method);
    return last;
  }

  return {
    db, router,
    call,
    writes: () => db.writes.map((w) => w.sql),
    writeKinds: () => db.writes.map((w) => w.sql.trim().slice(0, 6).toUpperCase()),
    readCount: () => db.reads.length,
    poolFired: () => db.fired.length,
  };
}

const U = 'https://unit.local/api/v2/ai-control';

// ── 1) dry-run 各写路径：零 DB 写 + 摘要响应 ───────────────────────────────
test('dryRun POST /providers (body) → 201 would summary, zero writes', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-new', name: 'New Provider', apiKey: 'sk-abcdefghij123456', dryRun: true },
  });
  assert.equal(r.code, 201);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.would.action, 'createProvider');
  assert.equal(r.data.would.provider_id, 'p-new');
  assert.equal(h.writeKinds().length, 0, 'dry-run must not persist');
  assert.ok(h.readCount() > 0, 'validation reads must still run');
  assert.equal(h.db.providers.some((p) => p.id === 'p-new'), false);
});

test('dryRun PATCH /providers/:id (body) → 200 fields+revision, zero writes', async () => {
  const h = harness();
  const r = await h.call('PATCH', `${U}/providers/p1`, {
    body: { revision: 3, name: 'Renamed', remark: 'x', dryRun: true },
  });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.deepEqual(r.data.would.fields, ['name', 'remark']);
  assert.equal(r.data.would.revision, 4);
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.db.providers.find((p) => p.id === 'p1').name, 'Provider p1', 'row must not mutate');
});

test('dryRun POST /providers/:id/enable (query) → 200 would enabled, zero writes', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/enable`, {
    body: { enabled: false }, query: { dryRun: 'true' },
  });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.would.action, 'setProviderEnabled');
  assert.equal(r.data.would.enabled, false);
  assert.equal(r.data.would.revision, 4);
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.db.providers.find((p) => p.id === 'p1').enabled, true);
});

test('dryRun POST /providers/:id/keys (body) → 201 would_add digest, zero writes, no pool sync', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys`, {
    body: { apiKeys: ['sk-new-key-abcdefgh123456', 'sk-new-key-abcdefgh123456', K1_SECRET], dryRun: true },
  });
  assert.equal(r.code, 201);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.would.action, 'addKeysBatch');
  assert.equal(r.data.would.keys_valid, 2, 'batch dedupes itself');
  assert.equal(r.data.would.would_add, 1, 'only the genuinely new key');
  assert.equal(r.data.would.would_skip, 1);
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.poolFired(), 0, 'dispatcher must not be touched in dry-run');
  assert.equal(h.db.apiKeys.length, 2);
});

test('dryRun PATCH /providers/:id/keys/:keyId (body) → 200 fields, zero writes, no pool sync', async () => {
  const h = harness();
  const r = await h.call('PATCH', `${U}/providers/p1/keys/k1`, {
    body: { label: 'edited', weight: 5, dryRun: true },
  });
  assert.equal(r.code, 200);
  assert.equal(r.data.dryRun, true);
  assert.deepEqual(r.data.would.fields, ['label', 'weight']);
  assert.equal(r.data.would.key_id, 'k1');
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.poolFired(), 0);
  assert.equal(h.db.apiKeys.find((k) => k.id === 'k1').label, 'agnes-1');
});

test('dryRun DELETE /providers/:id/keys/:keyId (body) → 200 would delete, zero writes', async () => {
  const h = harness();
  const r = await h.call('DELETE', `${U}/providers/p1/keys/k2`, { body: { dryRun: true } });
  assert.equal(r.code, 200);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.would.action, 'deleteKey');
  assert.equal(r.data.would.key_id, 'k2');
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.poolFired(), 0);
  assert.equal(h.db.apiKeys.length, 2, 'key must not be removed');
});

test('dryRun DELETE key via query.dryRun=true (no body) → 200', async () => {
  const h = harness();
  const r = await h.call('DELETE', `${U}/providers/p1/keys/k2`, { query: { dryRun: 'true' } });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun POST /providers/:id/keys/:keyId/cooldown (body) → 200 would cooldown, zero writes', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys/k1/cooldown`, {
    body: { cooldownMs: 60_000, dryRun: true },
  });
  assert.equal(r.code, 200);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.would.action, 'setKeyCooldown');
  assert.equal(r.data.would.cooldown_ms, 60000);
  assert.ok(typeof r.data.would.cooldown_until === 'string' && r.data.would.cooldown_until.length > 0);
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.poolFired(), 0);
  assert.equal(h.db.apiKeys.find((k) => k.id === 'k1').cooldown_until, null);
});

test('dryRun cooldown clear (cooldownMs=0) → would.cooldown_until null', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys/k1/cooldown`, {
    body: { cooldownMs: 0, dryRun: true },
  });
  assert.equal(r.code, 200);
  assert.equal(r.data.would.cooldown_ms, 0);
  assert.equal(r.data.would.cooldown_until, null);
  assert.equal(h.writeKinds().length, 0);
});

// ── 2) dry-run 校验失败仍 4xx（与真实一致）──────────────────────────────
test('dryRun create duplicate provider → 409, zero writes', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers`, {
    body: { id: 'p1', name: 'Dup', dryRun: true },
  });
  assert.equal(r.code, 409);
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /已存在/);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun create provider missing name → 400', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers`, { body: { id: 'p-x', dryRun: true } });
  assert.equal(r.code, 400);
  assert.equal(r.data.ok, false);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun PATCH provider without revision → 400', async () => {
  const h = harness();
  const r = await h.call('PATCH', `${U}/providers/p1`, { body: { name: 'x', dryRun: true } });
  assert.equal(r.code, 400);
  assert.match(r.data.error, /revision/);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun PATCH provider with stale revision → 409 (current revision read back)', async () => {
  const h = harness();
  const r = await h.call('PATCH', `${U}/providers/p1`, { body: { revision: 99, name: 'x', dryRun: true } });
  assert.equal(r.code, 409);
  assert.match(r.data.error, /revision 不匹配/);
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.db.providers.find((p) => p.id === 'p1').revision, 3);
});

test('dryRun PATCH provider that does not exist → 404', async () => {
  const h = harness();
  const r = await h.call('PATCH', `${U}/providers/nope`, { body: { revision: 1, name: 'x', dryRun: true } });
  assert.equal(r.code, 404);
  assert.equal(r.data.ok, false);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun enable nonexistent provider → 404', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/nope/enable`, { body: { enabled: true, dryRun: true } });
  assert.equal(r.code, 404);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun keys POST for nonexistent provider → 404', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/nope/keys`, {
    body: { apiKeys: ['sk-abcdefgh123456'], dryRun: true },
  });
  assert.equal(r.code, 404);
  assert.match(r.data.error, /服务商不存在/);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun keys POST with placeholder key → 400', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys`, {
    body: { apiKeys: ['sk-abc*defghij'], dryRun: true },
  });
  assert.equal(r.code, 400);
  assert.match(r.data.error, /无效的 key/);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun keys POST with no valid keys → 400', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys`, { body: { apiKeys: ['abc'], dryRun: true } });
  assert.equal(r.code, 400);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun PATCH nonexistent key → 404', async () => {
  const h = harness();
  const r = await h.call('PATCH', `${U}/providers/p1/keys/nope`, { body: { label: 'x', dryRun: true } });
  assert.equal(r.code, 404);
  assert.match(r.data.error, /key 不存在/);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun DELETE nonexistent key → 404', async () => {
  const h = harness();
  const r = await h.call('DELETE', `${U}/providers/p1/keys/nope`, { query: { dryRun: 'true' } });
  assert.equal(r.code, 404);
  assert.match(r.data.error, /key 不存在/);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun cooldown nonexistent key → 404', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys/nope/cooldown`, {
    body: { cooldownMs: 1000, dryRun: true },
  });
  assert.equal(r.code, 404);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun key in another provider → 404 (scoped existence)', async () => {
  const h = harness();
  // k1 属于 p1：对不存在的 provider p2 范围操作 k1 必须 404
  const r = await h.call('DELETE', `${U}/providers/p2/keys/k1`, { query: { dryRun: 'true' } });
  assert.equal(r.code, 404);
  assert.equal(h.writeKinds().length, 0);
});

test('dryRun without session → 401, DB untouched', async () => {
  const h = harness({ authed: false });
  const r = await h.call('POST', `${U}/providers`, { body: { id: 'p-x', dryRun: true } });
  assert.equal(r.code, 401);
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.readCount(), 0);
});

test('dryRun without admin → 403, DB untouched', async () => {
  const h = harness({ admin: false });
  const r = await h.call('PATCH', `${U}/providers/p1`, { body: { revision: 3, dryRun: true } });
  assert.equal(r.code, 403);
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.readCount(), 0);
});

// ── 3) 真实路径回归（dryRun 缺省 false，行为不变）───────────────────────
test('real POST /providers persists (INSERT providers) and returns provider', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-real', name: 'Real', apiKey: 'sk-realsecret-abcdefgh123456' },
  });
  assert.equal(r.code, 201);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.provider.id, 'p-real');
  assert.equal(r.data.revision, 1);
  assert.ok(h.writeKinds().includes('INSERT'), 'real path must write');
  assert.ok(h.db.providers.some((p) => p.id === 'p-real'));
});

test('real PATCH /providers persists (UPDATE providers, revision bumps)', async () => {
  const h = harness();
  const r = await h.call('PATCH', `${U}/providers/p1`, { body: { revision: 3, name: 'Renamed' } });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.revision, 4);
  assert.ok(h.writeKinds().includes('UPDATE'));
  assert.equal(h.db.providers.find((p) => p.id === 'p1').name, 'Renamed');
});

test('real enable persists and bumps revision', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/enable`, { body: { enabled: false } });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(h.db.providers.find((p) => p.id === 'p1').enabled, false);
  assert.ok(h.writeKinds().includes('UPDATE'));
});

test('real keys POST adds new key + fires dispatcher sync', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys`, {
    body: { apiKeys: ['sk-real-new-abcdefgh123456'] },
  });
  assert.equal(r.code, 201);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.added, 1);
  assert.ok(h.writeKinds().includes('INSERT'));
  assert.equal(h.poolFired(), 1, 'real path must sync the dispatcher pool');
  assert.equal(h.db.apiKeys.length, 3);
});

test('real keys POST duplicate is skipped, not persisted again', async () => {
  const h = harness();
  const before = h.db.apiKeys.length;
  const r = await h.call('POST', `${U}/providers/p1/keys`, { body: { apiKeys: [K1_SECRET] } });
  assert.equal(r.code, 201);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.added, 0);
  assert.equal(r.data.skipped, 1);
  assert.equal(h.db.apiKeys.length, before);
});

test('real PATCH key persists + syncs pool', async () => {
  const h = harness();
  const r = await h.call('PATCH', `${U}/providers/p1/keys/k1`, { body: { label: 'edited', status: 'disabled' } });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(h.db.apiKeys.find((k) => k.id === 'k1').label, 'edited');
  assert.equal(h.db.apiKeys.find((k) => k.id === 'k1').status, 'disabled');
  assert.equal(h.poolFired(), 1);
});

test('real DELETE key removes row + syncs pool', async () => {
  const h = harness();
  const r = await h.call('DELETE', `${U}/providers/p1/keys/k2`, {});
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.deleted, 'k2');
  assert.equal(h.db.apiKeys.some((k) => k.id === 'k2'), false);
  assert.equal(h.poolFired(), 1);
});

test('real cooldown persists cooldown_until', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys/k1/cooldown`, { body: { cooldownMs: 5000 } });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.ok(r.data.cooldown_until);
  assert.ok(h.db.apiKeys.find((k) => k.id === 'k1').cooldown_until);
});

test('dryRun:false explicitly behaves like the real path', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers/p1/keys`, {
    body: { apiKeys: ['sk-real-new2-abcdefgh123456'], dryRun: false },
  });
  assert.equal(r.code, 201);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, undefined);
  assert.ok(h.writeKinds().includes('INSERT'), 'dryRun:false must persist');
});

test('real GET /providers still lists (reads untouched)', async () => {
  const h = harness();
  const r = await h.call('GET', `${U}/providers`, {});
  assert.equal(r.code, 200);
  assert.ok(Array.isArray(r.data.providers));
  assert.equal(h.writeKinds().length, 0);
});
