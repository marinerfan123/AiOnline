'use strict';
/**
 * G19 — pendingActionStore.cjs unit tests（mock pg 按 SQL 形状路由，复刻真实
 * PostgreSQL 的 pending_actions 语义：PK(id)、status CHECK 四态、decide 的
 * WHERE(status='PENDING') 原子 CAS + 终态锁、expireOverdue 的 PENDING &
 * expires_at < now 严格边界、listPending 仅 PENDING 且 FIFO）。
 *
 * 跨角色可见性口径（与迁移 0056 / store 头注一致）：listPending 全量返回，不
 * 做行级鉴权裁剪 —— 「admin 全见 / actor 只见自己」由调用方按 actorId/actorRole
 * 过滤，本测试显式验证 store 层不隐藏他人行，并演示调用方过滤的职责边界。
 * 断言以 mock 行状态 + store 返回值双轨验证。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const approvalGate = require('./approvalGate.cjs');
const { createPendingActionStore, DDL } = require('./pendingActionStore.cjs');

const DEFAULT_TTL_MS = approvalGate.DEFAULT_TTL_MS;

/**
 * 内存版 pending_actions。行按 snake_case 存（镜像 node-pg 返回），payload 存
 * 为已 parse 对象；created_at / decided_at 取确定性单调时钟（base + seq ms），
 * expires_at 保留 store 落参的 Date —— 到期边界断言精确到毫秒。
 */
function createMockPg() {
  const rowsById = new Map();
  const calls = [];
  let createCalls = 0;
  let seq = 0;
  const base = Date.now();

  const now = () => new Date(base + seq++);
  const full = (row) => ({ ...row });

  function rowFor(id) { return rowsById.get(id) || null; }

  function insertRow({ id, kind, actor_id, actor_role, payload, expires_at }) {
    if (rowsById.has(id)) {
      const e = new Error('duplicate key value violates unique constraint "pending_actions_pkey"');
      e.code = '23505'; e.constraint = 'pending_actions_pkey';
      throw e;
    }
    const row = {
      id, kind,
      actor_id: actor_id === null ? null : actor_id,
      actor_role,
      payload, // 已 parse（镜像 node-pg jsonb）
      status: 'PENDING',
      created_at: now(),
      decided_at: null,
      decided_by: null,
      decision_note: null,
      expires_at,
    };
    rowsById.set(id, row);
    return row;
  }

  async function query(text, params = []) {
    calls.push({ text: String(text), params });
    const sql = String(text).trim();

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS pending_actions')) {
      createCalls += 1;
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes('INSERT INTO pending_actions')) {
      const [id, kind, actorId, actorRole, payloadJson, expiresAt] = params;
      const row = insertRow({
        id, kind, actor_id: actorId, actor_role: actorRole,
        payload: JSON.parse(payloadJson), expires_at: expiresAt,
      });
      return { rows: [full(row)], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE pending_actions')) {
      // expireOverdue：仅 PENDING 且 expires_at < now（严格小于），幂等。
      if (sql.includes("SET status = 'EXPIRED'")) {
        const [bound] = params;
        const expired = [];
        for (const row of rowsById.values()) {
          if (row.status === 'PENDING' && row.expires_at.getTime() < bound.getTime()) {
            row.status = 'EXPIRED';
            expired.push({ id: row.id });
          }
        }
        return { rows: expired, rowCount: expired.length };
      }
      // decide CAS：仅 PENDING 可迁出（终态锁）；不存在/终态 → rowCount 0。
      if (sql.includes('decided_at = NOW()')) {
        const [id, target, decidedBy, note] = params;
        const row = rowFor(id);
        if (!row || row.status !== 'PENDING') return { rows: [], rowCount: 0 };
        row.status = target;
        row.decided_at = now();
        row.decided_by = decidedBy;
        row.decision_note = note;
        return { rows: [full(row)], rowCount: 1 };
      }
      throw new Error(`mock pg: unhandled UPDATE: ${sql}`);
    }

    // ---- SELECT 分支 ----
    if (sql.includes('SELECT status FROM pending_actions')) {
      // decide 失败回查现状（单行 status）。
      const [id] = params;
      const row = rowFor(id);
      return row ? { rows: [{ status: row.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('ORDER BY created_at ASC, id ASC')) {
      // listPending：仅 PENDING，FIFO (created_at, id)；可选 actor_role 纯过滤。
      const hasRoleFilter = sql.includes('AND actor_role = $1');
      const role = hasRoleFilter ? params[0] : null;
      const rows = [...rowsById.values()]
        .filter((r) => r.status === 'PENDING' && (!hasRoleFilter || r.actor_role === role))
        .sort((a, b) => {
          const d = a.created_at.getTime() - b.created_at.getTime();
          return d !== 0 ? d : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        })
        .map(full);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT ')) {
      // get：任意状态按 id 单行读取。
      const [id] = params;
      const row = rowFor(id);
      return row ? { rows: [full(row)], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }

  return {
    pg: { query },
    calls,
    get createCalls() { return createCalls; },
    row: (id) => rowFor(id),
    rowsAll: () => [...rowsById.values()],
  };
}

/** 便捷：新建 mock + store 对。 */
function fresh() {
  const m = createMockPg();
  const store = createPendingActionStore({ pg: m.pg });
  return { m, store };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertInWindow(expiresAt, ttlMs, t0, t1) {
  // store 以自身 Date.now() 计算 expires_at，落于调用前(t0)/后(t1) 截获之间。
  const gt = t0 + ttlMs - 5000;
  const lt = t1 + ttlMs + 5000;
  assert.ok(expiresAt.getTime() > gt, `expiresAt ${expiresAt.toISOString()} 应 > ${new Date(gt).toISOString()}`);
  assert.ok(expiresAt.getTime() < lt, `expiresAt ${expiresAt.toISOString()} 应 < ${new Date(lt).toISOString()}`);
}

const ACT = (over = {}) => ({
  kind: 'provider.create', actorId: 'u-1', actorRole: 'agent',
  payload: { providerName: 'acme' },
  ...over,
});

// ------------------------------------------------------------ 建（create）
test('create enqueues PENDING pa- prefixed row; default ttl = approvalGate 1h', async () => {
  const { m, store } = fresh();
  const t0 = Date.now();
  const r = await store.create(ACT());
  const t1 = Date.now();
  assert.equal(r.ok, true);
  assert.match(r.pendingAction.id, /^pa-/);
  const pa = r.pendingAction;
  assert.equal(pa.kind, 'provider.create');
  assert.equal(pa.actorId, 'u-1');
  assert.equal(pa.actorRole, 'agent');
  assert.deepEqual(pa.payload, { providerName: 'acme' });
  assert.equal(pa.status, 'PENDING');
  assert.ok(pa.createdAt, 'created_at 落库');
  assert.equal(pa.decidedAt, null);
  assert.equal(pa.decidedBy, null);
  assert.equal(pa.decisionNote, null);
  assertInWindow(pa.expiresAt, DEFAULT_TTL_MS, t0, t1);
  // mock 行双轨：同一条行已落 PENDING。
  const raw = m.row(pa.id);
  assert.equal(raw.status, 'PENDING');
  assert.equal(raw.expires_at.getTime(), pa.expiresAt.getTime());
  assert.equal(m.createCalls, 1);
});

test('create honors custom ttlMs and optional actorId omission', async () => {
  const { m, store } = fresh();
  const t0 = Date.now();
  const r = await store.create({
    kind: 'provider.enable', actorRole: 'system',
    payload: { providerId: 'p-9', enabled: true }, ttlMs: 120_000,
  });
  const t1 = Date.now();
  assert.equal(r.ok, true);
  assert.equal(r.pendingAction.actorId, null);
  assert.equal(r.pendingAction.actorRole, 'system');
  assert.deepEqual(r.pendingAction.payload, { providerId: 'p-9', enabled: true });
  assertInWindow(r.pendingAction.expiresAt, 120_000, t0, t1);
  const raw = m.row(r.pendingAction.id);
  assert.equal(raw.actor_id, null);
  assert.equal(raw.expires_at.getTime() - raw.created_at.getTime() < 120_000 + 5000, true);
});

test('create validates kind/role/actorId/payload/ttl fail-closed before any SQL', async () => {
  const { m, store } = fresh();
  const cases = [
    [{ ...ACT(), kind: 'provider.explode' }, 'INVALID_KIND'],
    [{ ...ACT(), kind: undefined }, 'INVALID_KIND'],
    [{ ...ACT(), actorRole: 'root' }, 'INVALID_ACTOR_ROLE'],
    [{ ...ACT(), actorRole: undefined }, 'INVALID_ACTOR_ROLE'],
    [{ ...ACT(), actorId: '' }, 'INVALID_ACTOR_ID'],
    [{ ...ACT(), actorId: 42 }, 'INVALID_ACTOR_ID'],
    [{ ...ACT(), payload: undefined }, 'INVALID_PAYLOAD'],
    [{ ...ACT(), payload: [] }, 'INVALID_PAYLOAD'],
    [{ ...ACT(), payload: 'str' }, 'INVALID_PAYLOAD'],
    [{ ...ACT(), ttlMs: 0 }, 'INVALID_TTL'],
    [{ ...ACT(), ttlMs: -5000 }, 'INVALID_TTL'],
    [{ ...ACT(), ttlMs: '60k' }, 'INVALID_TTL'],
    [{ ...ACT(), ttlMs: 1.5 }, 'INVALID_TTL'],
  ];
  for (const [args, code] of cases) {
    const res = await store.create(args);
    assert.equal(res.ok, false, `${code} 应失败`);
    assert.equal(res.error.code, code, JSON.stringify(args));
  }
  assert.equal(m.calls.length, 0, '全部校验失败，未触达 SQL');
});

// ------------------------------------------------ 列（listPending / get）
test('listPending returns only PENDING in FIFO order; get reads any status', async () => {
  const { store } = fresh();
  const a = await store.create(ACT({ kind: 'provider.create', actorId: 'u-a' }));
  const b = await store.create(ACT({ kind: 'provider.key.create', actorId: 'u-b' }));
  const d = await store.create(ACT({ kind: 'provider.key.delete', actorId: 'u-d' }));
  const e = await store.create(ACT({ kind: 'provider.cooldown', actorId: 'u-e', ttlMs: 5 }));
  await store.decide({ id: b.pendingAction.id, decidedBy: 'admin-1', approve: true });  // APPROVED
  await store.decide({ id: d.pendingAction.id, decidedBy: 'admin-1', approve: false }); // DENIED
  await store.expireOverdue(new Date(Date.now() + 60_000));                             // e EXPIRED

  const { ok, pendingActions } = await store.listPending();
  assert.equal(ok, true);
  assert.deepEqual(pendingActions.map((p) => p.id), [a.pendingAction.id]);
  assert.equal(pendingActions[0].status, 'PENDING');

  // get 任意状态可读（终态/过期也在列）。
  assert.equal((await store.get(a.pendingAction.id)).pendingAction.status, 'PENDING');
  assert.equal((await store.get(b.pendingAction.id)).pendingAction.status, 'APPROVED');
  assert.equal((await store.get(d.pendingAction.id)).pendingAction.status, 'DENIED');
  assert.equal((await store.get(e.pendingAction.id)).pendingAction.status, 'EXPIRED');
  assert.equal((await store.get('pa-does-not-exist')).pendingAction, null);
});

test('listPending FIFO keeps enqueue order and excludes decided/expired rows', async () => {
  const { store } = fresh();
  const a = await store.create(ACT({ kind: 'provider.create', actorId: 'u-a' }));
  const b = await store.create(ACT({ kind: 'provider.enable', actorId: 'u-b', actorRole: 'system' }));
  const c = await store.create(ACT({ kind: 'provider.key.create', actorId: 'u-c' }));
  await store.decide({ id: b.pendingAction.id, decidedBy: 'admin-1', approve: false });

  const { pendingActions } = await store.listPending();
  assert.deepEqual(pendingActions.map((p) => p.id), [a.pendingAction.id, c.pendingAction.id]);
  // FIFO：先入队的 a 排在 c 前（created_at 非降序）。
  const createdAts = pendingActions.map((p) => new Date(p.createdAt).getTime());
  assert.ok(createdAts[0] <= createdAts[1], 'created_at 应按 FIFO 升序');
});

test('listPending optional actorRole filter; invalid role rejected before SQL', async () => {
  const { m, store } = fresh();
  const agentA = await store.create(ACT({ actorId: 'u-a' }));
  await store.create(ACT({ kind: 'provider.enable', actorId: 'u-s', actorRole: 'system' }));
  const before = m.calls.length;

  const { pendingActions } = await store.listPending({ actorRole: 'agent' });
  assert.deepEqual(pendingActions.map((p) => p.id), [agentA.pendingAction.id]);

  const all = await store.listPending();
  assert.equal(all.pendingActions.length, 2);

  const bad = await store.listPending({ actorRole: 'root' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_ACTOR_ROLE');
  assert.equal(m.calls.length, before + 2, '非法 role 在校验层拦截，无额外 SQL');
});

test('cross-role visibility: store lists everyone (no row-level hiding); caller filters', async () => {
  // 简化口径（迁移 0056 / store 头注）：listPending 全量 → 「admin 全见、
  // actor 只见自己」是调用方过滤职责。这里显式验证 store 层不隐藏他人行，
  // 并演示调用方按 actorId 过滤即得各自视角。
  const { store } = fresh();
  const agentA = await store.create(ACT({ kind: 'provider.create', actorId: 'agent-a' }));
  const agentB = await store.create(ACT({ kind: 'provider.key.create', actorId: 'agent-b' }));
  const sys = await store.create(ACT({ kind: 'provider.enable', actorId: 'svc-1', actorRole: 'system' }));

  // 管理员视角：listPending 全量，三行都在（含 agent-b、system 的）。
  const adminView = await store.listPending();
  assert.equal(adminView.ok, true);
  const ids = adminView.pendingActions.map((p) => p.id);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes(agentA.pendingAction.id));
  assert.ok(ids.includes(agentB.pendingAction.id));
  assert.ok(ids.includes(sys.pendingAction.id));

  // agent-a 视角（调用方过滤）：只见自己 actorId 的 PENDING 行。
  const agentAOnly = adminView.pendingActions.filter((p) => p.actorId === 'agent-a');
  assert.deepEqual(agentAOnly.map((p) => p.id), [agentA.pendingAction.id]);

  // 按 actorRole 的纯过滤条件同样可用（列表 agent 行的待批）。
  const agentsOnly = await store.listPending({ actorRole: 'agent' });
  assert.deepEqual(
    agentsOnly.pendingActions.map((p) => p.id).sort(),
    [agentA.pendingAction.id, agentB.pendingAction.id].sort(),
  );
});

// -------------------------------------------------- 决定（decide CAS）
test('decide approve=true transitions PENDING->APPROVED and records decider', async () => {
  const { m, store } = fresh();
  const c = await store.create(ACT({ kind: 'provider.key.create', actorId: 'u-1' }));
  const r = await store.decide({
    id: c.pendingAction.id, decidedBy: 'admin-1', approve: true, note: '凭证已核对，放行',
  });
  assert.equal(r.ok, true);
  const pa = r.pendingAction;
  assert.equal(pa.status, 'APPROVED');
  assert.equal(pa.decidedBy, 'admin-1');
  assert.equal(pa.decisionNote, '凭证已核对，放行');
  assert.ok(pa.decidedAt, 'decided_at 落库');
  const raw = m.row(c.pendingAction.id);
  assert.equal(raw.status, 'APPROVED');
  assert.equal(raw.decided_by, 'admin-1');
  assert.equal(raw.decision_note, '凭证已核对，放行');
});

test('decide approve=false transitions PENDING->DENIED (note optional -> null)', async () => {
  const { store } = fresh();
  const c = await store.create(ACT());
  const r = await store.decide({ id: c.pendingAction.id, decidedBy: 'admin-2', approve: false });
  assert.equal(r.ok, true);
  assert.equal(r.pendingAction.status, 'DENIED');
  assert.equal(r.pendingAction.decidedBy, 'admin-2');
  assert.equal(r.pendingAction.decisionNote, null);
});

test('terminal lock: decided action cannot be re-decided; first verdict immutable', async () => {
  const { store } = fresh();
  const c = await store.create(ACT());
  const first = await store.decide({ id: c.pendingAction.id, decidedBy: 'admin-1', approve: true, note: 'ok' });
  assert.equal(first.pendingAction.status, 'APPROVED');

  // 再驳（不同审批人）→ 终态锁拒绝，状态与首判记录不变。
  const second = await store.decide({ id: c.pendingAction.id, decidedBy: 'admin-2', approve: false, note: '改主意了' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'TERMINAL_STATE');
  assert.match(second.error.message, /APPROVED/);
  const after = await store.get(c.pendingAction.id);
  assert.equal(after.pendingAction.status, 'APPROVED');
  assert.equal(after.pendingAction.decidedBy, 'admin-1');
  assert.equal(after.pendingAction.decisionNote, 'ok');
});

test('terminal lock symmetric for DENIED and for expired actions', async () => {
  const { store } = fresh();
  // DENIED 后不可再批准。
  const d = await store.create(ACT({ kind: 'provider.key.delete' }));
  await store.decide({ id: d.pendingAction.id, decidedBy: 'admin-1', approve: false });
  const red = await store.decide({ id: d.pendingAction.id, decidedBy: 'admin-2', approve: true });
  assert.equal(red.ok, false);
  assert.equal(red.error.code, 'TERMINAL_STATE');
  assert.match(red.error.message, /DENIED/);
  assert.equal((await store.get(d.pendingAction.id)).pendingAction.status, 'DENIED');

  // EXPIRED 后不可再审批，且状态不被覆写。
  const e = await store.create(ACT({ kind: 'provider.enable', ttlMs: 5 }));
  await store.expireOverdue(new Date(Date.now() + 60_000));
  const de = await store.decide({ id: e.pendingAction.id, decidedBy: 'admin-1', approve: true });
  assert.equal(de.ok, false);
  assert.equal(de.error.code, 'TERMINAL_STATE');
  assert.match(de.error.message, /EXPIRED/);
  assert.equal((await store.get(e.pendingAction.id)).pendingAction.status, 'EXPIRED');
});

test('decide on unknown id -> PENDING_ACTION_NOT_FOUND', async () => {
  const { store } = fresh();
  const r = await store.decide({ id: 'pa-nope', decidedBy: 'admin-1', approve: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PENDING_ACTION_NOT_FOUND');
});

test('decide validates args before SQL (no query fired)', async () => {
  const { m, store } = fresh();
  const c = await store.create(ACT());
  const id = c.pendingAction.id;
  const cases = [
    [{ decidedBy: 'admin-1', approve: true }, 'INVALID_ACTION_ID'],
    [{ id, decidedBy: '', approve: true }, 'INVALID_DECIDED_BY'],
    [{ id, decidedBy: 7, approve: true }, 'INVALID_DECIDED_BY'],
    [{ id, decidedBy: 'admin-1' }, 'INVALID_APPROVE'],
    [{ id, decidedBy: 'admin-1', approve: 'yes' }, 'INVALID_APPROVE'],
    [{ id, decidedBy: 'admin-1', approve: true, note: 42 }, 'INVALID_DECISION_NOTE'],
  ];
  const before = m.calls.length;
  for (const [args, code] of cases) {
    const res = await store.decide(args);
    assert.equal(res.ok, false, `${code} 应失败`);
    assert.equal(res.error.code, code);
  }
  assert.equal(m.calls.length, before, '非法参数全部拦截，未触达 SQL');
});

// ------------------------------------------------------ 过期（expireOverdue）
test('expireOverdue flips only overdue PENDING rows and is idempotent', async () => {
  const { store } = fresh();
  const hour = await store.create(ACT({ kind: 'provider.create', actorId: 'u-1' })); // 1h 默认
  const short1 = await store.create(ACT({ kind: 'provider.enable', ttlMs: 5 }));
  const short2 = await store.create(ACT({ kind: 'provider.cooldown', ttlMs: 5 }));
  const decided = await store.create(ACT({ kind: 'provider.key.create', actorId: 'u-2' }));
  await store.decide({ id: decided.pendingAction.id, decidedBy: 'admin-1', approve: true });

  // 60s 界：两个 5ms 短命行过期；1h 行未到期；已 APPROVED 行不参与。
  const r1 = await store.expireOverdue(new Date(Date.now() + 60_000));
  assert.equal(r1.ok, true);
  assert.equal(r1.expired, 2);
  assert.equal((await store.get(short1.pendingAction.id)).pendingAction.status, 'EXPIRED');
  assert.equal((await store.get(short2.pendingAction.id)).pendingAction.status, 'EXPIRED');
  assert.equal((await store.get(hour.pendingAction.id)).pendingAction.status, 'PENDING');
  assert.equal((await store.get(decided.pendingAction.id)).pendingAction.status, 'APPROVED');

  // 幂等：同界再跑 0；已 EXPIRED 不重复计数。
  const r2 = await store.expireOverdue(new Date(Date.now() + 60_000));
  assert.equal(r2.expired, 0);

  // 2h 界：1h 默认行也过期，APPROVED 行仍不被碰。
  const r3 = await store.expireOverdue(new Date(Date.now() + 2 * 3600_000));
  assert.equal(r3.expired, 1);
  assert.equal((await store.get(hour.pendingAction.id)).pendingAction.status, 'EXPIRED');
  assert.equal((await store.get(decided.pendingAction.id)).pendingAction.status, 'APPROVED');
});

test('expireOverdue boundary is strict: expires_at == now is NOT expired', async () => {
  const { store } = fresh();
  const c = await store.create(ACT({ kind: 'provider.create', ttlMs: 60_000 }));
  const exp = (await store.get(c.pendingAction.id)).pendingAction.expiresAt;

  const at = await store.expireOverdue(new Date(exp.getTime()));
  assert.equal(at.expired, 0, '严格小于：等于界不过期');
  assert.equal((await store.get(c.pendingAction.id)).pendingAction.status, 'PENDING');

  const past = await store.expireOverdue(new Date(exp.getTime() + 1));
  assert.equal(past.expired, 1);
  assert.equal((await store.get(c.pendingAction.id)).pendingAction.status, 'EXPIRED');
});

test('expireOverdue defaults now to current time', async () => {
  const { store } = fresh();
  const c = await store.create(ACT({ kind: 'provider.create', ttlMs: 1 })); // 1ms 后过期
  const hour = await store.create(ACT({ kind: 'provider.enable', actorId: 'u-x' })); // 1h
  await sleep(30); // 让 1ms 行必然过期
  const r = await store.expireOverdue();
  assert.equal(r.ok, true);
  assert.equal(r.expired, 1);
  assert.equal((await store.get(c.pendingAction.id)).pendingAction.status, 'EXPIRED');
  assert.equal((await store.get(hour.pendingAction.id)).pendingAction.status, 'PENDING');
});

test('expireOverdue rejects unparsable now', async () => {
  const { store } = fresh();
  await store.create(ACT());
  await assert.rejects(() => store.expireOverdue('not-a-date'), TypeError);
});

// ------------------------------------------------------------ DDL 形状
test('store DDL mirrors migration 0056 four-state CHECK and PK', async () => {
  assert.match(DDL, /CREATE TABLE IF NOT EXISTS pending_actions/);
  assert.match(DDL, /id\s+TEXT\s+PRIMARY KEY/);
  assert.match(DDL, /payload\s+JSONB\s+NOT NULL DEFAULT '{}'::jsonb/);
  assert.match(DDL, /status\s+TEXT\s+NOT NULL DEFAULT 'PENDING'/);
  assert.match(DDL, /CHECK \(status IN \('PENDING', 'APPROVED', 'DENIED', 'EXPIRED'\)\)/);
  assert.match(DDL, /expires_at\s+TIMESTAMPTZ NOT NULL/);
});
