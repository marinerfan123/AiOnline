'use strict';
/**
 * G19 — aiControlRoutes dry-run write-path + approval-pending-closure tests.
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
 *   4. G19 approval 门 + pending 闭环（收口）：
 *      - agent 身份真实写 required kind（provider.create / provider.enable /
 *        provider.key.create / provider.key.delete）→ 202 {ok,pendingId,kind,
 *        expiresAt} 入队，绝不执行真实写（代替历史裸 402）；deny 单元（user /
 *        词表外角色）仍 403 APPROVAL_DENIED；agent cooldown(auto) 与 admin 全
 *        kind 直接放行执行；dryRun 恒定放行；PATCH 元数据写不入门。
 *      - admin 审批面（/api/v2/ai-admin/approvals/*，走同一 guard）：
 *        listPending、approve（先重放 APPLY[kind](payload) 成功再
 *        decide(APPROVED)）、重放失败 → decide(DENIED, note=execution-error)
 *        + 402 EXECUTION_ERROR、deny、终态（APPROVED/DENIED/EXPIRED）再审批
 *        → 409 TERMINAL_STATE、sweepExpired 过期清扫。
 *   No real DB is used.
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
// 测试用假密钥（>=6 位、无占位符字符；仅本文件内部使用）。
const KEY_A = `sk-route-new-a-${'abcdefghij'}`;
const KEY_B = `sk-route-new-b-${'klmnopqrst'}`;
const SECRET_A = `sk-route-create-${'abcdef1234567890'}`;

/** 状态化 fake pg：读真实求值、写真实变更（仅 real 路径使用）并全部留痕。 */
function fakePg() {
  const baseTime = Date.now();
  const providers = [providerRow('p1', { revision: 3 })];
  const apiKeys = [
    apiKeyRow('k1', 'p1', { label: 'agnes-1' }),
    apiKeyRow('k2', 'p1', { label: 'old', status: 'disabled', weight: 0 }),
  ];
  const reads = [];
  const writes = [];
  const fired = [];
  // G19 — pending_actions 内存表（镜像 store SQL 语义：PK、四态、decide CAS）。
  const pendingActions = new Map();
  const pendingNow = () => new Date(baseTime + pendingActions.size);

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
    providers, apiKeys, reads, writes, fired, pendingActions,
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

      // ── G19 pending_actions（pendingActionStore SQL 形状；node-pg 语义镜像）──
      if (/^INSERT INTO PENDING_ACTIONS\b/i.test(U)) {
        const [id, kind, actorId, actorRole, payloadJson, expiresAt] = params;
        const row = {
          id, kind,
          actor_id: actorId === null || actorId === undefined ? null : actorId,
          actor_role: actorRole,
          payload: JSON.parse(String(payloadJson)),
          status: 'PENDING',
          created_at: pendingNow(),
          decided_at: null,
          decided_by: null,
          decision_note: null,
          expires_at: expiresAt instanceof Date ? expiresAt : new Date(expiresAt),
        };
        pendingActions.set(id, row);
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/^UPDATE PENDING_ACTIONS\b/i.test(U)) {
        if (U.includes("SET STATUS = 'EXPIRED'")) {
          // expireOverdue：PENDING 且 expires_at < now（严格小于），幂等。
          const [bound] = params;
          const expired = [];
          for (const row of pendingActions.values()) {
            if (row.status === 'PENDING' && row.expires_at.getTime() < new Date(bound).getTime()) {
              row.status = 'EXPIRED';
              expired.push({ id: row.id });
            }
          }
          return { rows: expired, rowCount: expired.length };
        }
        // decide CAS：WHERE status='PENDING' 终态锁；不存在/终态 → rowCount 0。
        const [id, target, decidedBy, note] = params;
        const row = pendingActions.get(id);
        if (!row || row.status !== 'PENDING') return { rows: [], rowCount: 0 };
        row.status = target;
        row.decided_at = pendingNow();
        row.decided_by = decidedBy;
        row.decision_note = note === undefined || note === null ? null : note;
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/^SELECT STATUS FROM PENDING_ACTIONS\b/i.test(U)) {
        const [id] = params;
        const row = pendingActions.get(id);
        return row ? { rows: [{ status: row.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/FROM PENDING_ACTIONS\b/i.test(U) && /ORDER BY CREATED_AT ASC, ID ASC/i.test(U)) {
        // listPending：仅 PENDING，FIFO（created_at, id）；可选 actor_role 纯过滤。
        const hasRoleFilter = U.includes('AND ACTOR_ROLE = $1');
        const role = hasRoleFilter ? params[0] : null;
        const rows = [...pendingActions.values()]
          .filter((r) => r.status === 'PENDING' && (!hasRoleFilter || r.actor_role === role))
          .sort((a, b) => {
            const d = a.created_at.getTime() - b.created_at.getTime();
            return d !== 0 ? d : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
          })
          .map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      if (/^SELECT ID, KIND, ACTOR_ID/i.test(U) && /FROM PENDING_ACTIONS\b/i.test(U)) {
        // get(id)：任意状态单行读取。
        const [id] = params;
        const row = pendingActions.get(id);
        return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
function harness({ authed = true, admin = true, role = 'admin', id = 'admin-1' } = {}) {
  const db = fakePg();
  let last = null;
  // 可变会话用户：gate 测试先以 agent 入队、再以 admin 走审批面，只需 setUser 切换。
  const state = { id, role };
  const router = createAiControlRouter({
    pg: db,
    adminRequire: () => admin,
    sessionUser: () => (authed ? { id: state.id, role: state.role } : null),
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
    /** 切换后续请求的会话用户（approver 等）。 */
    setUser: (nextRole, nextId) => { state.role = nextRole; if (nextId !== undefined) state.id = nextId; },
    /** 真实写 SQL（排除 pending_actions 自身入队写，用于「未执行」断言）。 */
    realWrites: () => db.writes.filter((w) => !/pending_actions/i.test(w.sql)).map((w) => w.sql),
    writes: () => db.writes.map((w) => w.sql),
    writeKinds: () => db.writes.map((w) => w.sql.trim().slice(0, 6).toUpperCase()),
    readCount: () => db.reads.length,
    poolFired: () => db.fired.length,
    pending: (id) => db.pendingActions.get(id),
    pendingRows: () => [...db.pendingActions.values()],
  };
}

const U = 'https://unit.local/api/v2/ai-control';
const A = 'https://unit.local/api/v2/ai-admin';

// ── 1) dry-run 各写路径：零 DB 写 + 摘要响应 ───────────────────────────────
test('dryRun POST /providers (body) → 201 would summary, zero writes', async () => {
  const h = harness();
  const r = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-new', name: 'New Provider', apiKey: SECRET_A, dryRun: true },
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
    body: { apiKeys: [KEY_A, KEY_A, K1_SECRET], dryRun: true },
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
    body: { apiKeys: [KEY_A], dryRun: true },
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
    body: { id: 'p-real', name: 'Real', apiKey: SECRET_A },
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
    body: { apiKeys: [KEY_A] },
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
    body: { apiKeys: [KEY_A], dryRun: false },
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

// ── 4) G19 approval 门 + pending 闭环（写路径接线 + admin 审批面）───────
// 说明：真实服务里 ai-control 写面在 admin.requireAdmin 之后（admin/system 才
// 可达），agent 角色当前无签发路径。下面用 harness 注入 role:'agent' 的身份直接
// 测 approvalGate 决策单元在写路径上的接线 —— 等价于未来 agent/system 内部调用
// 面接入后的行为。admin 审批面（approvals/*）用 setUser('admin') 切换审批人。
const AGENT = { role: 'agent', id: 'agent-1' };

function assertPendingQueued(r, kind) {
  assert.equal(r.code, 202, 'required → 入队回 202（代替裸 402）');
  assert.equal(r.data.ok, true);
  assert.equal(r.data.kind, kind);
  assert.equal(r.data.status, 'PENDING');
  assert.match(r.data.pendingId, /^pa-/);
  assert.ok(r.data.expiresAt, '202 须回 expiresAt');
  assert.ok(typeof r.data.message === 'string');
}

function assertNoRealWrite(h) {
  assert.equal(h.realWrites().length, 0, '门命中 required → 绝不执行真实写');
}

function assertDenied(r, kind) {
  assert.equal(r.code, 403);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.error, 'APPROVAL_DENIED');
  assert.equal(r.data.kind, kind);
  assert.equal(typeof r.data.message, 'string', '拒绝响应须带 message');
}

// ── 4a) required kind：入队 202 + pending 行（净化 payload），不执行 ──
test('agent real POST /providers → 202 pending (provider.create); payload snapshot kept; nothing executed', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-agent', name: 'Agent Prov', apiKey: SECRET_A },
  });
  assertPendingQueued(r, 'provider.create');
  const row = h.pending(r.data.pendingId);
  assert.ok(row, 'pending 行已落');
  assert.equal(row.status, 'PENDING');
  assert.equal(row.kind, 'provider.create');
  assert.equal(row.actor_role, 'agent');
  assert.equal(row.actor_id, 'agent-1');
  assert.deepEqual(Object.keys(row.payload).sort(), ['apiKey', 'enabled', 'name', 'providerId'].sort(), 'payload = 提供的净化写参数字段（undefined 不入 JSONB）');
  assert.equal(row.payload.providerId, 'p-agent');
  assert.equal(row.payload.name, 'Agent Prov');
  assert.equal(row.payload.apiKey, SECRET_A, 'payload 保留完整 secret 供重放');
  assertNoRealWrite(h);
  assert.equal(h.poolFired(), 0);
  assert.equal(h.db.providers.some((p) => p.id === 'p-agent'), false);
});

test('agent real POST /providers/:id/enable → 202 pending (provider.enable) freezing revision; nothing executed', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('POST', `${U}/providers/p1/enable`, { body: { enabled: false } });
  assertPendingQueued(r, 'provider.enable');
  const row = h.pending(r.data.pendingId);
  assert.ok(row);
  assert.equal(row.payload.providerId, 'p1');
  assert.equal(row.payload.enabled, false);
  assert.equal(row.payload.revision, 3, '乐观锁基线 revision 入 payload');
  assertNoRealWrite(h);
  assert.equal(h.poolFired(), 0);
  assert.equal(h.db.providers.find((p) => p.id === 'p1').enabled, true, 'must stay enabled');
});

test('agent real POST /providers/:id/keys → 202 pending (provider.key.create) with normalized keys; nothing executed', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('POST', `${U}/providers/p1/keys`, {
    body: { apiKeys: [KEY_A, KEY_A, K1_SECRET] },
  });
  assertPendingQueued(r, 'provider.key.create');
  const row = h.pending(r.data.pendingId);
  assert.ok(row);
  assert.equal(row.payload.providerId, 'p1');
  assert.deepEqual(row.payload.keys, [KEY_A, K1_SECRET], 'keys 归一化（去重）后入 payload');
  assertNoRealWrite(h);
  assert.equal(h.poolFired(), 0);
  assert.equal(h.db.apiKeys.length, 2);
});

test('agent real DELETE /providers/:id/keys/:keyId → 202 pending (provider.key.delete); nothing executed', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('DELETE', `${U}/providers/p1/keys/k2`, {});
  assertPendingQueued(r, 'provider.key.delete');
  const row = h.pending(r.data.pendingId);
  assert.ok(row);
  assert.equal(row.payload.providerId, 'p1');
  assert.equal(row.payload.keyId, 'k2');
  assertNoRealWrite(h);
  assert.equal(h.poolFired(), 0);
  assert.equal(h.db.apiKeys.some((k) => k.id === 'k2'), true, 'key must survive');
});

test('agent 入队前对 payload 跑真实校验：duplicate provider create → 409，不建 pending', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('POST', `${U}/providers`, { body: { id: 'p1', name: 'Dup', apiKey: SECRET_A } });
  assert.equal(r.code, 409);
  assert.match(r.data.error, /已存在/);
  assert.equal(h.pendingRows().length, 0, '注定失败的写不入队');
  assertNoRealWrite(h);
});

test('agent 入队前校验：missing name → 400，不建 pending', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('POST', `${U}/providers`, { body: { id: 'p-x', apiKey: SECRET_A } });
  assert.equal(r.code, 400);
  assert.equal(h.pendingRows().length, 0);
  assertNoRealWrite(h);
});

test('agent 入队前校验：DELETE 不存在的 key → 404，不建 pending', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('DELETE', `${U}/providers/p1/keys/nope`, {});
  assert.equal(r.code, 404);
  assert.match(r.data.error, /key 不存在/);
  assert.equal(h.pendingRows().length, 0);
  assertNoRealWrite(h);
});

// ── 4b) deny / auto / dryRun 语义不变 ──
test('agent real cooldown (auto per DEFAULT_POLICY) executes → auto-approve bypass', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('POST', `${U}/providers/p1/keys/k1/cooldown`, { body: { cooldownMs: 5000 } });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.ok(r.data.cooldown_until, 'cooldown must persist under auto');
  assert.ok(h.writeKinds().includes('UPDATE'));
  assert.equal(h.poolFired(), 1);
  assert.ok(h.db.apiKeys.find((k) => k.id === 'k1').cooldown_until);
});

test('user role real write → 403 APPROVAL_DENIED (user deny, no approval path)', async () => {
  const h = harness({ role: 'user', id: 'user-1' });
  const r = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-user', name: 'U', apiKey: SECRET_A },
  });
  assertDenied(r, 'provider.create');
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.pendingRows().length, 0, 'deny 不建 pending');
});

test('out-of-vocabulary actor role → 403 APPROVAL_DENIED (fail closed)', async () => {
  const h = harness({ role: 'staff', id: 's-1' });
  const r = await h.call('POST', `${U}/providers/p1/keys`, { body: { apiKeys: [KEY_A] } });
  assertDenied(r, 'provider.key.create');
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.pendingRows().length, 0);
});

test('dryRun overrides the gate: agent dryRun create → 201 summary, nothing persisted', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-gdr', name: 'Dry Agent', apiKey: SECRET_A, dryRun: true },
  });
  assert.equal(r.code, 201);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.would.action, 'createProvider');
  assert.equal(h.writeKinds().length, 0, 'dry-run never writes, gate or not');
  assert.equal(h.pendingRows().length, 0, 'dry-run 不入队');
});

test('dryRun overrides the gate: agent dryRun DELETE key (query) → 200 summary, nothing persisted', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('DELETE', `${U}/providers/p1/keys/k2`, { query: { dryRun: 'true' } });
  assert.equal(r.code, 200);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.would.action, 'deleteKey');
  assert.equal(h.writeKinds().length, 0);
  assert.equal(h.db.apiKeys.length, 2);
});

test('unknown kind stays status quo: agent real PATCH /providers/:id is not gated → executes', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('PATCH', `${U}/providers/p1`, { body: { revision: 3, name: 'AgentRenamed' } });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.revision, 4);
  assert.ok(h.writeKinds().includes('UPDATE'));
  assert.equal(h.db.providers.find((p) => p.id === 'p1').name, 'AgentRenamed');
});

test('unknown kind stays status quo: agent real PATCH key metadata is not gated → executes', async () => {
  const h = harness({ role: AGENT.role, id: AGENT.id });
  const r = await h.call('PATCH', `${U}/providers/p1/keys/k1`, { body: { label: 'agent-edited' } });
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.equal(h.db.apiKeys.find((k) => k.id === 'k1').label, 'agent-edited');
  assert.ok(h.writeKinds().includes('UPDATE'));
});

// ── 4c) admin 审批面：list / approve / deny / 终态 / 过期 ──────────────
test('admin GET approvals/pending with empty queue → 200 {ok, pendingActions:[]}', async () => {
  const h = harness();
  const r = await h.call('GET', `${A}/approvals/pending`, {});
  assert.equal(r.code, 200);
  assert.equal(r.data.ok, true);
  assert.deepEqual(r.data.pendingActions, []);
  assert.equal(r.data.count, 0);
});

test('admin approvals list: FIFO 全量 rows, payload secrets masked in response', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-l1', name: 'L1', apiKey: SECRET_A },
  });
  const pa1 = r1.data.pendingId;
  const r2 = await h.call('POST', `${U}/providers/p1/keys`, { body: { apiKeys: [KEY_B] } });
  const pa2 = r2.data.pendingId;
  h.setUser('admin', 'admin-1');
  const list = await h.call('GET', `${A}/approvals/pending`, {});
  assert.equal(list.code, 200);
  assert.equal(list.data.ok, true);
  assert.equal(list.data.count, 2);
  assert.deepEqual(list.data.pendingActions.map((p) => p.id), [pa1, pa2], 'FIFO（created_at ASC）');
  const row1 = list.data.pendingActions[0];
  assert.equal(row1.status, 'PENDING');
  assert.equal(row1.kind, 'provider.create');
  assert.equal(row1.actorRole, 'agent');
  assert.equal(row1.payload.providerId, 'p-l1');
  assert.ok(row1.payload.apiKey !== SECRET_A, 'response 不回显完整 secret');
  assert.match(row1.payload.apiKey, /^\u2022{4}/, 'payload.apiKey 已 mask');
  const row2 = list.data.pendingActions[1];
  assert.equal(row2.kind, 'provider.key.create');
  assert.equal(row2.payload.keys.length, 1);
  assert.ok(row2.payload.keys[0] !== KEY_B);
  assert.match(row2.payload.keys[0], /^\u2022{4}/, 'payload.keys 每项已 mask');
  // DB 行保持完整（重放必需），未被执行。
  assert.equal(h.pending(pa1).payload.apiKey, SECRET_A);
  assert.equal(h.db.apiKeys.length, 2);
  assertNoRealWrite(h);
});

test('approve replay success (provider.create) → 200 APPROVED + 执行落库', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-ok', name: 'OK', apiKey: SECRET_A },
  });
  const id = r1.data.pendingId;
  h.setUser('admin', 'admin-2');
  const app = await h.call('POST', `${A}/approvals/${id}/approve`, {});
  assert.equal(app.code, 200);
  assert.equal(app.data.ok, true);
  assert.equal(app.data.kind, 'provider.create');
  assert.equal(app.data.applied.ok, true);
  assert.equal(app.data.applied.provider.id, 'p-ok');
  assert.equal(app.data.pendingAction.status, 'APPROVED');
  assert.equal(app.data.pendingAction.decidedBy, 'admin-2');
  assert.ok(app.data.pendingAction.decidedAt, 'decided_at 落库');
  assert.equal(h.pending(id).status, 'APPROVED', 'decide 已把行迁出 PENDING');
  assert.ok(h.db.providers.some((p) => p.id === 'p-ok'), '重放真实执行');
  assert.ok(h.realWrites().length > 0);
});

test('approve replay success (provider.enable) uses frozen revision; provider disabled', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers/p1/enable`, { body: { enabled: false } });
  const id = r1.data.pendingId;
  assert.equal(h.pending(id).payload.revision, 3);
  h.setUser('admin', 'admin-1');
  const app = await h.call('POST', `${A}/approvals/${id}/approve`, {});
  assert.equal(app.code, 200);
  assert.equal(app.data.pendingAction.status, 'APPROVED');
  assert.equal(h.db.providers.find((p) => p.id === 'p1').enabled, false);
  assert.equal(h.db.providers.find((p) => p.id === 'p1').revision, 4);
});

test('approve replay success (provider.key.create) adds keys + fires dispatcher sync', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers/p1/keys`, { body: { apiKeys: [KEY_A] } });
  const id = r1.data.pendingId;
  h.setUser('admin', 'admin-1');
  const app = await h.call('POST', `${A}/approvals/${id}/approve`, {});
  assert.equal(app.code, 200);
  assert.equal(app.data.pendingAction.status, 'APPROVED');
  assert.equal(app.data.applied.added, 1);
  assert.equal(h.db.apiKeys.length, 3);
  assert.equal(h.poolFired(), 1, '重放触发 dispatcher 同步');
});

test('approve replay failure (target already gone) → decide DENIED(execution-error) + 402 EXECUTION_ERROR', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('DELETE', `${U}/providers/p1/keys/k2`, {});
  const id = r1.data.pendingId;
  // 审批前目标 key 已被真实删除（重放将 404）。
  h.setUser('admin', 'admin-1');
  const del = await h.call('DELETE', `${U}/providers/p1/keys/k2`, {});
  assert.equal(del.code, 200);
  const app = await h.call('POST', `${A}/approvals/${id}/approve`, {});
  assert.equal(app.code, 402, '重放失败 → 402');
  assert.equal(app.data.ok, false);
  assert.equal(app.data.error, 'EXECUTION_ERROR');
  assert.equal(app.data.kind, 'provider.key.delete');
  assert.equal(app.data.status, 404);
  assert.match(app.data.message, /驳回|execution-error/);
  assert.equal(app.data.pendingAction.status, 'DENIED', '决定落 DENIED，不留 APPROVED 悬空态');
  const row = h.pending(id);
  assert.equal(row.status, 'DENIED');
  assert.equal(row.decided_by, 'admin-1');
  assert.ok(String(row.decision_note).startsWith('execution-error:'), `note 带 execution-error: ${row.decision_note}`);
});

test('approve replay failure (stale revision on enable) → 409 re-validated, DENIED + 402', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers/p1/enable`, { body: { enabled: false } });
  const id = r1.data.pendingId;
  h.setUser('admin', 'admin-1');
  // 审批前 revision 已被他人推进（乐观锁 409 语义在重放时重新求值）。
  const bump = await h.call('PATCH', `${U}/providers/p1`, { body: { revision: 3, name: 'Bumped' } });
  assert.equal(bump.code, 200);
  const app = await h.call('POST', `${A}/approvals/${id}/approve`, {});
  assert.equal(app.code, 402);
  assert.equal(app.data.error, 'EXECUTION_ERROR');
  assert.equal(app.data.status, 409);
  assert.equal(app.data.pendingAction.status, 'DENIED');
  assert.ok(String(h.pending(id).decision_note).startsWith('execution-error:'));
  assert.equal(h.db.providers.find((p) => p.id === 'p1').enabled, true, '重放失败未生效');
});

test('admin deny → 200 DENIED; row terminal; disappears from pending list', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers/p1/keys`, { body: { apiKeys: [KEY_A] } });
  const id = r1.data.pendingId;
  h.setUser('admin', 'admin-1');
  const before = h.db.apiKeys.length;
  const den = await h.call('POST', `${A}/approvals/${id}/deny`, { body: { note: 'rejected: no budget' } });
  assert.equal(den.code, 200);
  assert.equal(den.data.ok, true);
  assert.equal(den.data.pendingId, id);
  assert.equal(den.data.pendingAction.status, 'DENIED');
  assert.equal(den.data.pendingAction.decisionNote, 'rejected: no budget');
  const row = h.pending(id);
  assert.equal(row.status, 'DENIED');
  assert.equal(row.decided_by, 'admin-1');
  assert.equal(h.db.apiKeys.length, before, 'deny 不执行');
  assert.equal(h.poolFired(), 0);
  const list = await h.call('GET', `${A}/approvals/pending`, {});
  assert.equal(list.data.count, 0, '终态行不再出现在 pending 列表');
});

test('deny on unknown id → 404 PENDING_ACTION_NOT_FOUND', async () => {
  const h = harness();
  const r = await h.call('POST', `${A}/approvals/pa-nope/deny`, {});
  assert.equal(r.code, 404);
  assert.equal(r.data.error, 'PENDING_ACTION_NOT_FOUND');
});

test('approve on unknown id → 404 PENDING_ACTION_NOT_FOUND', async () => {
  const h = harness();
  const r = await h.call('POST', `${A}/approvals/pa-nope/approve`, {});
  assert.equal(r.code, 404);
  assert.equal(r.data.error, 'PENDING_ACTION_NOT_FOUND');
});

test('terminal state: approve again after APPROVED → 409 TERMINAL_STATE, write not re-run', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-t1', name: 'T1', apiKey: SECRET_A },
  });
  const id = r1.data.pendingId;
  h.setUser('admin', 'admin-1');
  const ok = await h.call('POST', `${A}/approvals/${id}/approve`, {});
  assert.equal(ok.code, 200);
  const before = h.db.providers.filter((p) => p.id === 'p-t1').length;
  const again = await h.call('POST', `${A}/approvals/${id}/approve`, {});
  assert.equal(again.code, 409);
  assert.equal(again.data.ok, false);
  assert.equal(again.data.error, 'TERMINAL_STATE');
  assert.equal(again.data.status, 'APPROVED');
  assert.match(again.data.message, /终态/);
  assert.equal(h.db.providers.filter((p) => p.id === 'p-t1').length, before, '终态拒绝，不重放');
});

test('terminal state: deny after DENIED → 409 TERMINAL_STATE', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers/p1/keys`, { body: { apiKeys: [KEY_A] } });
  const id = r1.data.pendingId;
  h.setUser('admin', 'admin-1');
  const den = await h.call('POST', `${A}/approvals/${id}/deny`, {});
  assert.equal(den.code, 200);
  const again = await h.call('POST', `${A}/approvals/${id}/deny`, {});
  assert.equal(again.code, 409);
  assert.equal(again.data.error, 'TERMINAL_STATE');
  assert.equal(again.data.status, 'DENIED');
});

test('sweepExpired marks overdue PENDING → EXPIRED (idempotent); approve after expiry → 409', async () => {
  const h = harness({ role: AGENT.role, id: 'agent-1' });
  const r1 = await h.call('POST', `${U}/providers`, {
    body: { id: 'p-exp', name: 'Exp', apiKey: SECRET_A },
  });
  const id = r1.data.pendingId;
  assert.equal(h.pending(id).status, 'PENDING');
  // 定时清扫（server.js 未来挂载；本叶导出钩子）：now 推到 2h 后 → 过期。
  const future = new Date(Date.now() + 2 * 3600_000);
  const sweep = await h.router.sweepExpired(future);
  assert.equal(sweep.ok, true);
  assert.ok(sweep.expired >= 1, `expired=${sweep.expired}`);
  assert.equal(h.pending(id).status, 'EXPIRED');
  const sweep2 = await h.router.sweepExpired(future);
  assert.equal(sweep2.expired, 0, '幂等：已 EXPIRED 不重复计数');
  const list = await h.call('GET', `${A}/approvals/pending`, {});
  assert.equal(list.data.count, 0, 'EXPIRED 不进 pending 列表');
  h.setUser('admin', 'admin-1');
  const app = await h.call('POST', `${A}/approvals/${id}/approve`, {});
  assert.equal(app.code, 409);
  assert.equal(app.data.error, 'TERMINAL_STATE');
  assert.equal(app.data.status, 'EXPIRED');
  assert.equal(h.db.providers.some((p) => p.id === 'p-exp'), false, '过期行不可再审批执行');
});

test('admin approvals guard: non-admin → 403 (same route guard)', async () => {
  const h = harness({ admin: false });
  const r = await h.call('GET', `${A}/approvals/pending`, {});
  assert.equal(r.code, 403);
  assert.match(r.data.error, /管理员/);
  assert.equal(h.pendingRows().length, 0);
});

test('admin approvals guard: no session → 401', async () => {
  const h = harness({ authed: false });
  const r = await h.call('GET', `${A}/approvals/pending`, {});
  assert.equal(r.code, 401);
});

test('unknown /api/v2/ai-admin sub-route → 404', async () => {
  const h = harness();
  const r = await h.call('GET', `${A}/other`, {});
  assert.equal(r.code, 404);
  const r2 = await h.call('POST', `${A}/approvals/pending`, {});
  assert.equal(r2.code, 404);
});

test('router exposes PREFIX / ADMIN_PREFIX / sweepExpired for server.js wiring', async () => {
  const h = harness();
  assert.equal(h.router.PREFIX, '/api/v2/ai-control');
  assert.equal(h.router.ADMIN_PREFIX, '/api/v2/ai-admin');
  assert.equal(typeof h.router.sweepExpired, 'function');
  const ok = await h.router.sweepExpired(new Date());
  assert.equal(ok.ok, true);
});
