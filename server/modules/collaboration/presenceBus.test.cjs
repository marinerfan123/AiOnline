'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPresenceBus,
  createMemoryPresenceStore,
  PRESENCE_STATES,
  PRESENCE_STATE_LIST,
  HEARTBEAT_TTL_MS,
} = require('./presenceBus.cjs');

const { ONLINE, AWAY, EDITING, OFFLINE } = PRESENCE_STATES;

/* ── 可控假存储（list 由用例喂入，remove 真实删除，便于精确 TTL 断言） ── */
function cannedStore(records) {
  const rows = records.map((r) => ({ ...r }));
  const calls = { upsert: [], remove: [] };
  return {
    calls,
    upsert(rec) {
      calls.upsert.push({ ...rec });
      const i = rows.findIndex((r) => r.userId === rec.userId && r.canvasId === rec.canvasId);
      if (i >= 0) rows[i] = { ...rec };
      else rows.push({ ...rec });
    },
    list() {
      return rows.map((r) => ({ ...r }));
    },
    remove({ userId, canvasId }) {
      calls.remove.push({ userId, canvasId });
      const i = rows.findIndex((r) => r.userId === userId && r.canvasId === canvasId);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

const row = (userId, canvasId, state, lastSeenMs) => ({ userId, canvasId, state, lastSeenMs });

/* ── 心跳入列 ─────────────────────────────────────────────────── */
test('G22 presenceBus: heartbeat 入列 online/away/editing 并返回 presence 记录', () => {
  const store = createMemoryPresenceStore();
  const bus = createPresenceBus({ store });
  const r1 = bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  const r2 = bus.heartbeat({ userId: 'u-2', canvasId: 'c-1', state: AWAY });
  const r3 = bus.heartbeat({ userId: 'u-3', canvasId: 'c-1', state: EDITING });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  for (const r of [r1, r2, r3]) {
    assert.equal(typeof r.presence.lastSeenMs, 'number');
    assert.ok(Number.isFinite(r.presence.lastSeenMs));
  }
  assert.equal(r1.presence.state, ONLINE);
  assert.equal(r2.presence.state, AWAY);
  assert.equal(r3.presence.state, EDITING);
  assert.equal(store.list().length, 3, '三条 (canvas,user) 记录都应落库');
});

test('G22 presenceBus: 同 (canvas,user) 二次心跳 = upsert 覆盖并刷新 lastSeenMs', async (t) => {
  const store = createMemoryPresenceStore();
  const bus = createPresenceBus({ store });
  const first = bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  await t.test('state 覆盖', () => {
    bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: EDITING });
    const recs = store.list().filter((r) => r.userId === 'u-1' && r.canvasId === 'c-1');
    assert.equal(recs.length, 1, '同 key 不产生第二行');
    assert.equal(recs[0].state, EDITING);
  });
  await t.test('lastSeenMs 刷新（单调不减）', () => {
    const recs = store.list().filter((r) => r.userId === 'u-1' && r.canvasId === 'c-1');
    assert.ok(recs[0].lastSeenMs >= first.presence.lastSeenMs);
  });
});

test('G22 presenceBus: 默认内存 store（未注入）可用，心跳后 peers 可见', () => {
  const bus = createPresenceBus();
  bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  const members = bus.peers('c-1');
  assert.equal(members.length, 1);
  assert.equal(members[0].userId, 'u-1');
});

/* ── 校验：必填 + 枚举，选拒(400) 不降级 ───────────────────────── */
test('G22 presenceBus: 缺失/空 userId、canvasId、state 一律拒 (status 400)', async (t) => {
  const bus = createPresenceBus();
  const cases = [
    ['missing userId', {}],
    ['blank userId', { userId: '  ', canvasId: 'c-1', state: ONLINE }],
    ['non-string userId', { userId: 7, canvasId: 'c-1', state: ONLINE }],
    ['missing canvasId', { userId: 'u-1', state: ONLINE }],
    ['blank canvasId', { userId: 'u-1', canvasId: '', state: ONLINE }],
    ['missing state', { userId: 'u-1', canvasId: 'c-1' }],
    ['null state', { userId: 'u-1', canvasId: 'c-1', state: null }],
  ];
  for (const [label, input] of cases) {
    await t.test(label, () => {
      const r = bus.heartbeat(input);
      assert.equal(r.ok, false, `${label} 应拒绝`);
      assert.equal(r.status, 400, `${label} 应带 400`);
      assert.ok(Array.isArray(r.errors) && r.errors.length > 0, `${label} 应带 errors`);
    });
  }
});

test('G22 presenceBus: state 不在枚举内拒 (400)，不降级 online', async (t) => {
  const bus = createPresenceBus();
  const bad = ['busy', 'idle', 'online ', 'OFFLINE', 42, ['online'], { state: 'away' }];
  for (const state of bad) {
    await t.test(JSON.stringify(state), () => {
      const r = bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.ok(r.errors.some((e) => e.includes('state')));
    });
  }
  // 被拒心跳不得产生任何记录
  assert.equal(bus.peers('c-1').length, 0);
});

test('G22 presenceBus: 枚举常量完整性（online/away/editing/offline 冻结）', () => {
  assert.deepEqual([...PRESENCE_STATE_LIST].sort(), ['away', 'editing', 'offline', 'online']);
  assert.ok(Object.isFrozen(PRESENCE_STATES));
  assert.equal(HEARTBEAT_TTL_MS, 15_000);
  assert.deepEqual(Object.values(PRESENCE_STATES), PRESENCE_STATE_LIST);
});

/* ── offline 心跳 = 离开画布，摘除记录 ──────────────────────────── */
test('G22 presenceBus: heartbeat(offline) 摘除记录且不出现在 peers', () => {
  const store = createMemoryPresenceStore();
  const bus = createPresenceBus({ store });
  bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  bus.heartbeat({ userId: 'u-2', canvasId: 'c-1', state: AWAY });
  const r = bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: OFFLINE });
  assert.equal(r.ok, true);
  assert.equal(r.presence, null, 'offline 心跳不产出 presence 记录');
  const left = store.list().filter((x) => x.userId === 'u-1');
  assert.equal(left.length, 0, 'u-1 记录应被摘除');
  assert.deepEqual(
    bus.peers('c-1').map((p) => p.userId),
    ['u-2'],
    'peers 只剩仍在线的 u-2',
  );
});

/* ── peers 过滤：按画布 / 非 offline / ≤TTL ────────────────────── */
test('G22 presenceBus: peers 只返回本画布成员（画布隔离）', () => {
  const bus = createPresenceBus();
  bus.heartbeat({ userId: 'a', canvasId: 'c-1', state: ONLINE });
  bus.heartbeat({ userId: 'b', canvasId: 'c-2', state: ONLINE });
  bus.heartbeat({ userId: 'c', canvasId: 'c-1', state: EDITING });
  assert.deepEqual(
    bus.peers('c-1').map((p) => p.userId).sort(),
    ['a', 'c'],
  );
  assert.deepEqual(bus.peers('c-2').map((p) => p.userId), ['b']);
  assert.deepEqual(bus.peers('c-3'), [], '无成员画布返回空数组');
  assert.deepEqual(bus.peers(''), [], '空 canvasId 返回空数组');
});

test('G22 presenceBus: peers 过滤过期记录（精确 nowMs，age>=TTL 即剔除）', () => {
  const T0 = 1_000_000_000_000;
  const store = cannedStore([
    row('fresh', 'c-1', ONLINE, T0),
    row('at-ttl', 'c-1', ONLINE, T0 - HEARTBEAT_TTL_MS),
    row('stale', 'c-1', EDITING, T0 - HEARTBEAT_TTL_MS - 1),
    row('old', 'c-1', AWAY, T0 - 60_000),
  ]);
  const bus = createPresenceBus({ store });
  const seen = bus.peers('c-1', T0).map((p) => p.userId).sort();
  assert.deepEqual(seen, ['fresh'], 'age<TTL 保留，age>=TTL（含边界）剔除');
  // 惰性过滤：过期记录仍在底层存储（peers 不写存储），交由 sweep 清理
  assert.equal(store.list().length, 4);
});

test('G22 presenceBus: peers 永不返回 offline（即使存储里残留 offline 行）', () => {
  const T0 = 1_000_000_000_000;
  const store = cannedStore([
    row('u-on', 'c-1', ONLINE, T0),
    row('u-ghost', 'c-1', OFFLINE, T0), // 残留 offline 行（异常路径防御）
    row('u-away', 'c-1', AWAY, T0),
  ]);
  const bus = createPresenceBus({ store });
  assert.deepEqual(
    bus.peers('c-1', T0).map((p) => p.userId).sort(),
    ['u-away', 'u-on'],
  );
});

test('G22 presenceBus: peers 输出字段 = userId/state/lastSeenMs（不含存储内部字段）', () => {
  const bus = createPresenceBus();
  const hb = bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: EDITING });
  const [p] = bus.peers('c-1');
  assert.deepEqual(p, { userId: 'u-1', state: EDITING, lastSeenMs: hb.presence.lastSeenMs });
});

/* ── sweep 清过期 ──────────────────────────────────────────────── */
test('G22 presenceBus: sweep 清过期、留存活，返回清理条数', () => {
  const T0 = 1_000_000_000_000;
  const store = cannedStore([
    row('dead-1', 'c-1', ONLINE, T0 - HEARTBEAT_TTL_MS - 5),
    row('dead-2', 'c-1', EDITING, T0 - 60_000),
    row('edge', 'c-2', AWAY, T0 - HEARTBEAT_TTL_MS), // age==TTL → 过期
    row('alive-1', 'c-1', ONLINE, T0 - 1_000),
    row('alive-2', 'c-1', AWAY, T0),
  ]);
  const bus = createPresenceBus({ store });
  const removed = bus.sweep(T0);
  assert.equal(removed, 3, 'dead-1/dead-2/edge 被清，alive 保留');
  const remain = store.list().map((r) => r.userId).sort();
  assert.deepEqual(remain, ['alive-1', 'alive-2']);
  // 二次 sweep 无过期 → 0
  assert.equal(bus.sweep(T0), 0);
});

test('G22 presenceBus: 真实时间流 —— 心跳后 sweep(now+TTL) 过期、sweep(now+短窗) 存活', () => {
  const bus = createPresenceBus();
  bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  bus.heartbeat({ userId: 'u-2', canvasId: 'c-1', state: AWAY });
  const now = Date.now();
  assert.equal(bus.sweep(now + HEARTBEAT_TTL_MS - 100), 0, 'TTL 内不清');
  assert.equal(bus.peers('c-1').length, 2, 'TTL 内 peers 可见');
  assert.equal(bus.sweep(now + HEARTBEAT_TTL_MS + 100), 2, '过 TTL 全清');
  assert.equal(bus.peers('c-1').length, 0, 'sweep 后 peers 空');
});

/* ── store 注入契约 ────────────────────────────────────────────── */
test('G22 presenceBus: 注入 store 的 upsert/remove 被真实调用（spy 断言）', () => {
  const store = createMemoryPresenceStore();
  const bus = createPresenceBus({ store });
  const hb = bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: ONLINE });
  const recs = store.list();
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], { userId: 'u-1', canvasId: 'c-1', state: ONLINE, lastSeenMs: hb.presence.lastSeenMs });
  bus.heartbeat({ userId: 'u-1', canvasId: 'c-1', state: OFFLINE });
  assert.equal(store.list().length, 0, 'offline 应经 store.remove 摘除');
});

test('G22 presenceBus: 缺方法 / 非对象 store 在创建期即抛错', () => {
  assert.throws(() => createPresenceBus({ store: {} }), /store\.upsert must be a function/);
  assert.throws(() => createPresenceBus({ store: { upsert() {}, list() {} } }), /store\.remove must be a function/);
  assert.throws(() => createPresenceBus({ store: 'nope' }), TypeError);
});

test('G22 presenceBus: 非对象 heartbeat 入参拒 (400)', () => {
  const bus = createPresenceBus();
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = bus.heartbeat(bad);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
  }
});
