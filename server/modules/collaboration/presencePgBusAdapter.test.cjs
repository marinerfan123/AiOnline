'use strict';
/**
 * G22 — presencePgBusAdapter.cjs unit + 组合 tests.
 *
 * 测试分三层：
 *   1. 单元测试：adapter 挂在「假异步 store」上，精确喂入记录/nowMs 断言
 *      heartbeat 校验与归一、peers 过滤与排序、sweep 委托 —— 不经真实 SQL。
 *   2. 组合测试（端到端）：真 createPresencePgStore 挂在「假 pg」上（忠实模拟
 *      canvas_presence 在 PG 上的语义：复合主键 upsert 覆盖、int8 读回字符串、
 *      DELETE rowCount），再把 adapter 挂在该真 store 上，跑 heartbeat→peers→sweep
 *      完整回路 —— 证明 snake/camel 与 bigint→number 归一穿越适配层无损失。
 *   3. 常量对拍 + presenceApi 集成实测：证明 adapter 复制常量与 presenceBus /
 *      presencePgStore 逐字一致；并实测「同步调用 × 异步 adapter」会拿到 Promise
 *      （presenceApi 需补 await，非零改动）—— 本文件的诚实结论落点。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createPresencePgBusAdapter,
  PRESENCE_STATES,
  PRESENCE_STATE_LIST,
  PRESENCE_LEGACY_ALIASES,
  isPresenceState,
  HEARTBEAT_TTL_MS,
} = require('./presencePgBusAdapter.cjs');
const { createPresencePgStore } = require('./presencePgStore.cjs');
const presenceBus = require('./presenceBus.cjs');
const { createPresenceApi } = require('./presenceApi.cjs');

const { ONLINE, AWAY, EDITING, OFFLINE } = PRESENCE_STATES;
const TTL = 30_000;

const MODULE_PATH = path.join(__dirname, 'presencePgBusAdapter.cjs');

/* ── 假异步 store：忠实模拟 PgStore 的异步接口与语义（无 SQL） ─── */
function fakeAsyncStore(records = []) {
  // rows: [{canvasId,userId,state,lastSeenMs}] —— 模拟 PgStore 对外（camelCase）
  const rows = records.map((r) => ({ ...r }));
  const calls = { upsert: [], remove: [], list: [], sweep: [] };
  return {
    calls,
    async upsert(rec) {
      calls.upsert.push({ ...rec });
      const i = rows.findIndex((r) => r.canvasId === rec.canvasId && r.userId === rec.userId);
      if (i >= 0) rows[i] = { ...rec };
      else rows.push({ ...rec });
      return { ok: true };
    },
    async list(canvasId) {
      calls.list.push(canvasId);
      return rows
        .filter((r) => r.canvasId === canvasId)
        .map((r) => ({ ...r }))
        .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    },
    async remove({ canvasId, userId }) {
      calls.remove.push({ canvasId, userId });
      const i = rows.findIndex((r) => r.canvasId === canvasId && r.userId === userId);
      if (i >= 0) rows.splice(i, 1);
      return { ok: true };
    },
    async sweep(_canvasId, nowMs = Date.now()) {
      calls.sweep.push({ canvasId: _canvasId, nowMs });
      let removed = 0;
      const cutoff = nowMs - TTL;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].lastSeenMs < cutoff) { rows.splice(i, 1); removed += 1; }
      }
      return { removed };
    },
  };
}

const row = (userId, canvasId, state, lastSeenMs) => ({ userId, canvasId, state, lastSeenMs });

/* ── 假 pg：忠实模拟 canvas_presence 在 PG 上的语义（组合测试用） ── */
function createMockPg() {
  const canvases = new Map(); // canvasId -> Map<userId, snake_row>
  function getCanvas(canvasId) {
    if (!canvases.has(canvasId)) canvases.set(canvasId, new Map());
    return canvases.get(canvasId);
  }
  async function query(text, params = []) {
    const sql = String(text).trim();
    if (sql.includes('INSERT INTO canvas_presence')) {
      const [canvasId, userId, state, lastSeenMs] = params;
      getCanvas(canvasId).set(userId, { canvas_id: canvasId, user_id: userId, state, last_seen_ms: String(lastSeenMs) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM canvas_presence')) {
      if (sql.includes('last_seen_ms <')) {
        const [cutoff] = params;
        const canvasId = params.length >= 2 ? params[1] : null;
        const targets = canvasId ? (canvases.has(canvasId) ? [[canvasId, canvases.get(canvasId)]] : []) : [...canvases.entries()];
        let removed = 0;
        for (const [cid, users] of targets) {
          for (const [uid, r] of [...users.entries()]) {
            if (Number(r.last_seen_ms) < cutoff) { users.delete(uid); removed += 1; }
          }
          if (users.size === 0 && canvasId === null) canvases.delete(cid);
        }
        return { rows: [], rowCount: removed };
      }
      const [canvasId, userId] = params;
      const canvas = canvases.get(canvasId);
      const had = canvas ? canvas.delete(userId) : false;
      if (had && canvas.size === 0) canvases.delete(canvasId);
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (sql.includes('SELECT canvas_id, user_id, state, last_seen_ms')) {
      const [canvasId] = params;
      const canvas = canvases.get(canvasId);
      const rows = canvas ? [...canvas.values()]
        .sort((a, b) => (a.user_id < b.user_id ? -1 : 1))
        .map((r) => ({ ...r, last_seen_ms: String(r.last_seen_ms) })) : [];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }
  return { pg: { query } };
}

/* ── 构造守卫 ──────────────────────────────────────────────────── */
test('G22 adapter: 缺 store / 非对象 / 缺方法 在构造期抛 TypeError', () => {
  assert.throws(() => createPresencePgBusAdapter(), /store must be an object/);
  assert.throws(() => createPresencePgBusAdapter({}), /store must be an object/);
  assert.throws(() => createPresencePgBusAdapter({ store: 'nope' }), /store must be an object/);
  assert.throws(() => createPresencePgBusAdapter({ store: { upsert() {}, list() {}, remove() {} } }), /store\.sweep must be a function/);
  assert.doesNotThrow(() => createPresencePgBusAdapter({ store: { upsert() {}, list() {}, remove() {}, sweep() {} } }), '完整 store 构造成功');
});

/* ── 异步契约：adapter 三方法均返回 Promise（presenceApi 需 await） ── */
test('G22 adapter: heartbeat/peers/sweep 均返回 Promise（异步总线）', async () => {
  const bus = createPresencePgBusAdapter({ store: fakeAsyncStore() });
  const hp = bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  const pp = bus.peers('c-1');
  const sp = bus.sweep();
  assert.ok(hp instanceof Promise, 'heartbeat 返回 Promise');
  assert.ok(pp instanceof Promise, 'peers 返回 Promise');
  assert.ok(sp instanceof Promise, 'sweep 返回 Promise');
  await Promise.all([hp, pp, sp]);
});

/* ── 常量对拍：adapter 复制常量与 presenceBus / presencePgStore 逐字一致 ── */
test('G22 adapter: PRESENCE 枚举/TTL 与 presenceBus 逐字一致（复制常量同源）', () => {
  assert.deepEqual(PRESENCE_STATES, presenceBus.PRESENCE_STATES);
  assert.deepEqual(PRESENCE_STATE_LIST, presenceBus.PRESENCE_STATE_LIST);
  assert.deepEqual(PRESENCE_LEGACY_ALIASES, presenceBus.PRESENCE_LEGACY_ALIASES);
  assert.equal(HEARTBEAT_TTL_MS, presenceBus.HEARTBEAT_TTL_MS);
  assert.equal(HEARTBEAT_TTL_MS, TTL);
  assert.equal(isPresenceState('busy'), false, 'busy 是 alias 非 canonical');
  assert.equal(HEARTBEAT_TTL_MS, require('../studio-contracts/collabContract.cjs').presenceTtlMs, '与契约 presenceTtlMs 同源');
});

test('G22 adapter: 模块源码零 require —— 常量确为复制、无跨目录依赖', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.doesNotMatch(src, /require\s*\(/, 'presencePgBusAdapter.cjs 不得 require 任何模块（防循环）');
});

/* ── heartbeat 语义（与 presenceBus 同口径，仅异步） ────────────── */
test('G22 adapter: heartbeat 入列 online/away/editing 并返回 presence 记录', async () => {
  const store = fakeAsyncStore();
  const bus = createPresencePgBusAdapter({ store });
  const r1 = await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  const r2 = await bus.heartbeat({ userId: 'u-2', canvasId: 'c-1', state: AWAY });
  const r3 = await bus.heartbeat({ userId: 'u-3', canvasId: 'c-1', state: EDITING });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(r1.presence.state, ONLINE);
  assert.equal(r2.presence.state, AWAY);
  assert.equal(r3.presence.state, EDITING);
  assert.equal(store.calls.upsert.length, 3, '三次 upsert 都真实发出');
  for (const r of [r1, r2, r3]) {
    assert.equal(typeof r.presence.lastSeenMs, 'number');
    assert.ok(Number.isFinite(r.presence.lastSeenMs));
  }
});

test('G22 adapter: 同 (canvas,user) 二次心跳 = upsert 覆盖并刷新 lastSeenMs', async () => {
  const store = fakeAsyncStore();
  const bus = createPresencePgBusAdapter({ store });
  const first = await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: EDITING });
  assert.equal(store.calls.upsert.length, 2);
  const last = store.calls.upsert[1];
  assert.equal(last.state, EDITING);
  assert.ok(last.lastSeenMs >= first.presence.lastSeenMs);
});

test('G22 adapter: heartbeat 接受 legacy alias busy → 归一为 editing', async () => {
  const store = fakeAsyncStore();
  const bus = createPresencePgBusAdapter({ store });
  const r = await bus.heartbeat({ userId: 'u-legacy', canvasId: 'c-1', state: 'busy' });
  assert.equal(r.ok, true);
  assert.equal(r.presence.state, EDITING);
  assert.equal(store.calls.upsert[0].state, EDITING, 'adapter 归一后传给 store 的是 canonical editing');
});

test('G22 adapter: heartbeat(offline) 摘除记录（走 store.remove）且 presence=null', async () => {
  const store = fakeAsyncStore();
  const bus = createPresencePgBusAdapter({ store });
  await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  const r = await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: OFFLINE });
  assert.equal(r.ok, true);
  assert.equal(r.presence, null);
  assert.equal(store.calls.remove.length, 1, 'offline 应经 store.remove 摘除');
  assert.deepEqual(store.calls.remove[0], { canvasId: 'c-1', userId: 'u-1' });
  assert.equal(store.calls.upsert.length, 1, 'offline 不触发 upsert');
});

/* ── store 层 400 拒收 → adapter 透传（await 后检查 store 结果，不谎报 ok:true） ── */
test('G22 adapter: store.upsert/remove 返回 {ok:false,status:400} → adapter 透传而非吞掉', async () => {
  const rejecting = {
    upsert: async () => ({ ok: false, status:400, errors: ['upsert rejected by store'] }),
    list: async () => [],
    remove: async () => ({ ok: false, status:400, errors: ['remove rejected by store'] }),
    sweep: async () => ({ removed: 0 }),
  };
  const bus = createPresencePgBusAdapter({ store: rejecting });

  const online = await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  assert.equal(online.ok, false, 'store 层 upsert 拒收须透传，不谎报 ok:true');
  assert.equal(online.status, 400);
  assert.deepEqual(online.errors, ['upsert rejected by store']);

  const offline = await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: OFFLINE });
  assert.equal(offline.ok, false, 'store 层 remove 拒收须透传');
  assert.equal(offline.status, 400);
  assert.deepEqual(offline.errors, ['remove rejected by store']);
});

test('G22 adapter: 非法 heartbeat 入参拒(400) 且零 store 调用（校验口径同 presenceBus）', async () => {
  const store = fakeAsyncStore();
  const bus = createPresencePgBusAdapter({ store });
  const cases = [
    ['missing userId', {}],
    ['blank userId', { userId: '  ', canvasId: 'c-1', state: ONLINE }],
    ['missing canvasId', { userId: 'u-1', state: ONLINE }],
    ['missing state', { userId: 'u-1', canvasId: 'c-1' }],
    ['bad state', { userId: 'u-1', canvasId: 'c-1', state: 'idle' }],
    ['case state', { userId: 'u-1', canvasId: 'c-1', state: 'ONLINE' }],
  ];
  for (const [label, input] of cases) {
    const r = await bus.heartbeat(input);
    assert.equal(r.ok, false, `${label} 应拒绝`);
    assert.equal(r.status, 400, `${label} 应带 400`);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, `${label} 应带 errors`);
  }
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = await bus.heartbeat(bad);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
  assert.equal(store.calls.upsert.length, 0, '被拒心跳零 store 调用');
  assert.equal(store.calls.remove.length, 0);
});

/* ── peers 语义：画布 / 非 offline / age<TTL / 排序 / 字段 ───────── */
test('G22 adapter: peers 只返回本画布成员（store.list 画布收窄）', async () => {
  const T0 = 1_000_000_000_000;
  const store = fakeAsyncStore([
    row('a', 'c-1', ONLINE, T0),
    row('b', 'c-2', ONLINE, T0),
    row('c', 'c-1', EDITING, T0),
  ]);
  const bus = createPresencePgBusAdapter({ store });
  assert.deepEqual((await bus.peers('c-1', T0)).map((p) => p.userId), ['a', 'c']);
  assert.deepEqual((await bus.peers('c-2', T0)).map((p) => p.userId), ['b']);
  assert.deepEqual(await bus.peers('c-3', T0), []);
  assert.deepEqual(await bus.peers('', T0), []);
  assert.deepEqual(await bus.peers(undefined, T0), []);
});

test('G22 adapter: peers 过滤过期记录（age>=TTL 剔除，精确 nowMs）', async () => {
  const T0 = 1_000_000_000_000;
  const store = fakeAsyncStore([
    row('fresh', 'c-1', ONLINE, T0),
    row('at-ttl', 'c-1', ONLINE, T0 - TTL),
    row('stale', 'c-1', EDITING, T0 - TTL - 1),
  ]);
  const bus = createPresencePgBusAdapter({ store });
  assert.deepEqual((await bus.peers('c-1', T0)).map((p) => p.userId), ['fresh'], 'age<TTL 保留，age>=TTL 剔除');
});

test('G22 adapter: peers 永不返回 offline（即使 store 残留 offline 行）', async () => {
  const T0 = 1_000_000_000_000;
  const store = fakeAsyncStore([
    row('u-on', 'c-1', ONLINE, T0),
    row('u-ghost', 'c-1', OFFLINE, T0),
    row('u-away', 'c-1', AWAY, T0),
  ]);
  const bus = createPresencePgBusAdapter({ store });
  assert.deepEqual((await bus.peers('c-1', T0)).map((p) => p.userId), ['u-away', 'u-on']);
});

test('G22 adapter: peers 输出字段 = {userId,state,lastSeenMs}（不含 canvasId）且按 userId 升序', async () => {
  const T0 = 1_000_000_000_000;
  const store = fakeAsyncStore([
    row('z', 'c-1', ONLINE, T0),
    row('a', 'c-1', EDITING, T0),
    row('m', 'c-1', AWAY, T0),
  ]);
  const bus = createPresencePgBusAdapter({ store });
  const peers = await bus.peers('c-1', T0);
  assert.deepEqual(peers.map((p) => p.userId), ['a', 'm', 'z'], '按 userId 升序');
  for (const p of peers) {
    assert.deepEqual(Object.keys(p).sort(), ['lastSeenMs', 'state', 'userId'].sort());
    assert.equal(typeof p.lastSeenMs, 'number');
  }
});

/* ── sweep 委托 ────────────────────────────────────────────────── */
test('G22 adapter: sweep 委托 store.sweep(全库) 并返回清理条数 number', async () => {
  const T0 = 1_000_000_000_000;
  const store = fakeAsyncStore([
    row('dead', 'c-1', ONLINE, T0 - TTL - 5),
    row('alive', 'c-1', AWAY, T0),
  ]);
  const bus = createPresencePgBusAdapter({ store });
  const removed = await bus.sweep(T0);
  assert.equal(removed, 1, '清掉 1 条过期');
  assert.equal(store.calls.sweep.length, 1);
  assert.deepEqual(store.calls.sweep[0], { canvasId: undefined, nowMs: T0 }, '全库 sweep（canvasId=undefined）');
  assert.deepEqual((await bus.peers('c-1', T0)).map((p) => p.userId), ['alive']);
});

test('G22 adapter: sweep 缺省 nowMs = Date.now()；store.sweep 返回非整数时兜底 0', async () => {
  const store = fakeAsyncStore();
  const bus = createPresencePgBusAdapter({ store });
  const removed = await bus.sweep();
  assert.equal(typeof removed, 'number');
  assert.equal(removed, 0);
  // 兜底：store.sweep 返回非法 removed 时 adapter 归 0
  const weird = createPresencePgBusAdapter({
    store: { ...store, sweep: async () => ({ removed: 'nope' }) },
  });
  assert.equal(await weird.sweep(), 0);
});

/* ── 组合测试（端到端）：真 PgStore × 假 pg × adapter 完整回路 ──── */
test('G22 adapter 组合: 真 createPresencePgStore 挂假 pg，adapter 端到端 heartbeat→peers→sweep', async () => {
  const m = createMockPg();
  const pgStore = createPresencePgStore({ pg: m.pg });
  const bus = createPresencePgBusAdapter({ store: pgStore });

  // 心跳入列（含 legacy alias busy → editing 归一，穿越真 store 落库）
  await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  await bus.heartbeat({ userId: 'u-2', canvasId: 'c-1', state: 'busy' });
  await bus.heartbeat({ userId: 'u-3', canvasId: 'c-1', state: AWAY });
  await bus.heartbeat({ userId: 'u-x', canvasId: 'c-2', state: ONLINE });

  // peers：画布隔离 + busy 已归一为 editing + bigint string→number 穿越适配层无损失
  const c1 = await bus.peers('c-1');
  assert.deepEqual(c1.map((p) => p.userId), ['u-1', 'u-2', 'u-3'], '按 userId 升序');
  assert.equal(c1.find((p) => p.userId === 'u-2').state, EDITING, 'busy 经真 store 归一为 editing 且 peers 可见 canonical');
  for (const p of c1) assert.equal(typeof p.lastSeenMs, 'number', 'int8 string 归一为 number 穿越 adapter');
  assert.deepEqual((await bus.peers('c-2')).map((p) => p.userId), ['u-x']);

  // offline 摘除：真 store.remove 生效
  const off = await bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: OFFLINE });
  assert.equal(off.presence, null);
  assert.deepEqual((await bus.peers('c-1')).map((p) => p.userId), ['u-2', 'u-3']);

  // sweep：真 store.sweep 清过期（用精确 nowMs 制造过期）
  const T0 = Date.now();
  await bus.heartbeat({ userId: 'u-old', canvasId: 'c-9', state: ONLINE });
  // 直接经 store 写入一条深过期行（模拟长时间未心跳）
  await pgStore.upsert({ canvasId: 'c-9', userId: 'u-stale', state: ONLINE, lastSeenMs: T0 - 2 * TTL });
  const removed = await bus.sweep(T0);
  assert.ok(removed >= 1, `sweep 应清至少 1 条过期（实际 ${removed}）`);
  assert.deepEqual((await bus.peers('c-9', T0)).map((p) => p.userId), ['u-old'], 'u-stale 过期被清，u-old 存活');
});

test('G22 adapter 组合: adapter 与 presenceBus 在同一喂入集上产出相同 peers（语义等价）', async () => {
  // 同一批记录经内存 bus（同步）与 adapter（异步，挂假 store）各跑一遍 peers，结果须一致。
  const T0 = 1_000_000_000_000;
  const seed = [
    row('z', 'c-1', ONLINE, T0),
    row('a', 'c-1', EDITING, T0 - 1000),
    row('m', 'c-1', AWAY, T0 - 500),
    row('ghost', 'c-1', OFFLINE, T0),
    row('stale', 'c-1', ONLINE, T0 - TTL - 1),
    row('other', 'c-2', ONLINE, T0),
  ];
  const asyncBus = createPresencePgBusAdapter({ store: fakeAsyncStore(seed) });
  const syncBus = presenceBus.createPresenceBus({ store: {
    upsert() {},
    list: () => seed.map((r) => ({ ...r })),
    remove() {},
  } });
  const a = (await asyncBus.peers('c-1', T0)).map((p) => `${p.userId}:${p.state}:${p.lastSeenMs}`).sort();
  const b = syncBus.peers('c-1', T0).map((p) => `${p.userId}:${p.state}:${p.lastSeenMs}`).sort();
  // 注：adapter 按 userId 升序（任务要求 + 对齐 store.list 的 ORDER BY user_id），
  // 内存 presenceBus 不排序 —— 故按「成员集合」比较等价（排序后对拍），顺序非等价点。
  assert.deepEqual(a, b, 'adapter 与 presenceBus 的 peers 成员集合须逐点等价（顺序除外）');
});

/* ── presenceApi 集成实测：已补 await → 异步 adapter 正确 200（回归旧「同步误判 400」） ── */
test('G22 adapter: presenceApi 已 await 异步 adapter → heartbeat 200（非 Promise 误判 400）', async () => {
  const bus = createPresencePgBusAdapter({ store: fakeAsyncStore() });
  let captured;
  const api = createPresenceApi({
    bus,
    sessionUser: () => ({ id: 'u-1' }),
    sendJSON: (_res, code, body) => { captured = { code, body }; return true; },
    parseBody: async () => ({ canvasId: 'c-1', state: ONLINE }),
  });

  // presenceApi.handle 内已是 `const result = await bus.heartbeat(...)`（await 已补全）。
  const handled = await api.handle({}, {}, '/api/v2/presence/heartbeat', 'POST');
  assert.equal(handled, true, 'presenceApi 认领了该路由');
  // await 到位 → result 是实际结果对象 → 200 且 presence.state=online（非旧「Promise 误判 400」）
  assert.equal(captured.code, 200, 'await 后拿到结果对象 → 200');
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.presence.state, ONLINE);

  // 同一 adapter 读回已落库成员（peers 也 await）
  const peers = await bus.peers('c-1');
  assert.deepEqual(peers.map((p) => p.userId), ['u-1']);
});
