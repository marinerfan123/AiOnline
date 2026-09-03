'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresenceApi } = require('./presenceApi.cjs');
const {
  createPresenceBus,
  createMemoryPresenceStore,
  PRESENCE_STATES,
} = require('./presenceBus.cjs');

const { EDITING, ONLINE, AWAY, OFFLINE } = PRESENCE_STATES;

/* ── 可控假 bus：记录调用，返回由用例预设 ─────────────────────────── */
function fakeBus({ heartbeatResult, peersResult } = {}) {
  const calls = { heartbeat: [], peers: [] };
  return {
    calls,
    heartbeat(input) {
      calls.heartbeat.push({ ...input });
      return heartbeatResult;
    },
    peers(canvasId) {
      calls.peers.push(canvasId);
      return peersResult;
    },
  };
}

/* ── 请求 harness：注入假 sendJSON/parseBody/sessionUser ──────────── */
function makeApi({ bus, sessionUser = () => ({ id: 'u-1' }), parseBodyImpl } = {}) {
  const responses = [];
  const api = createPresenceApi({
    bus,
    sessionUser,
    sendJSON: (res, code, body) => {
      responses.push({ code, body });
      res.status = code;
      res.body = body;
    },
    parseBody: async (req) => (parseBodyImpl ? parseBodyImpl(req) : req._body !== undefined ? req._body : {}),
  });
  /** call(method,url,{body,anon,params}) -> { status, body, handled, api, bus, store? } */
  const call = async (method, url, { body, anon = false } = {}) => {
    const res = {};
    const usedApi = makeApiFor({ anon });
    const handled = await usedApi.api.handle({ _body: body }, res, url, method);
    return { status: res.status, body: res.body, handled, ...usedApi };
  };
  const makeApiFor = ({ anon }) => {
    const inner = makeApi({ bus, sessionUser: anon ? () => null : sessionUser, parseBodyImpl });
    return { api: inner.api, responses: inner.responses };
  };
  return { api, responses, call, bus };
}

/* 真实内存 bus + 可控 store（断言落库行） */
function makeRealHarness() {
  const store = createMemoryPresenceStore();
  const bus = createPresenceBus({ store });
  const api = createPresenceApi({
    bus,
    sessionUser: () => ({ id: 'u-1' }),
    sendJSON: (res, code, body) => { res.status = code; res.body = body; },
    parseBody: async (req) => (req._body !== undefined ? req._body : {}),
  });
  const call = async (method, url, body) => {
    const res = {};
    const handled = await api.handle({ _body: body }, res, url, method);
    return { status: res.status, body: res.body, handled, store, bus };
  };
  return { api, call, store, bus };
}

/* ── 会话守卫：无会话 → 401（POST 与 GET 两条路由都拦） ───────────── */
test('G22 presenceApi: 无会话 401（heartbeat POST / peers GET）', async (t) => {
  const h = makeHarnessBus();
  await t.test('POST heartbeat 无会话 → 401', async () => {
    const r = await h.call('POST', '/api/v2/presence/heartbeat', { body: { canvasId: 'c-1', state: EDITING }, anon: true });
    assert.equal(r.status, 401);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, '未登录');
    assert.equal(r.handled, true);
  });
  await t.test('GET peers 无会话 → 401', async () => {
    const r = await h.call('GET', '/api/v2/presence/peers/c-1', { anon: true });
    assert.equal(r.status, 401);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, '未登录');
  });
  await t.test('401 时不触碰 bus', () => {
    assert.equal(h.bus.calls.heartbeat.length, 0);
    assert.equal(h.bus.calls.peers.length, 0);
  });
});

function makeHarnessBus() {
  return makeApi({ bus: fakeBus() });
}

/* ── 心跳 200：假 bus 委托断言（userId 取会话、忽略客户端冒名 userId） ─ */
test('G22 presenceApi: POST heartbeat 200 —— 委托 bus.heartbeat({userId 来自会话,…}) 并透传 presence', async () => {
  const bus = fakeBus({
    heartbeatResult: { ok: true, presence: { userId: 'u-1', canvasId: 'c-1', state: EDITING, lastSeenMs: 1234 } },
  });
  const h = makeApi({ bus });
  const r = await h.call('POST', '/api/v2/presence/heartbeat', {
    body: { canvasId: 'c-1', state: EDITING, userId: 'spoofed-u' }, // 客户端冒名 userId 必须被忽略
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.presence.state, EDITING);
  assert.deepEqual(bus.calls.heartbeat, [{ userId: 'u-1', canvasId: 'c-1', state: EDITING }], 'userId 只取会话身份');
});

test('G22 presenceApi: POST heartbeat 离线 state=offline → 200 presence:null（透传 bus）', async () => {
  const bus = fakeBus({ heartbeatResult: { ok: true, presence: null } });
  const h = makeApi({ bus });
  const r = await h.call('POST', '/api/v2/presence/heartbeat', { body: { canvasId: 'c-1', state: OFFLINE } });
  assert.equal(r.status, 200);
  assert.equal(r.body.presence, null);
});

/* ── 心跳拒绝：bus 400 透传（非法 state 等，校验真源在 bus） ───────── */
test('G22 presenceApi: bus 拒绝心跳 → 400 + errors 透传', async () => {
  const errors = ['state must be one of: online/away/editing/offline'];
  const bus = fakeBus({ heartbeatResult: { ok: false, status: 400, errors } });
  const h = makeApi({ bus });
  const r = await h.call('POST', '/api/v2/presence/heartbeat', { body: { canvasId: 'c-1', state: 'idle' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.errors, errors);
});

test('G22 presenceApi: parseBody 返回 null/undefined（坏 JSON 兜底）→ 400 而非崩溃', async () => {
  const bus = fakeBus({ heartbeatResult: { ok: false, status: 400, errors: ['canvasId (non-empty string) required'] } });
  const h = makeApi({ bus });
  const r = await h.call('POST', '/api/v2/presence/heartbeat', { body: undefined });
  assert.equal(r.status, 400);
});

/* ── peers 200：假 bus 委托断言 ────────────────────────────────── */
test('G22 presenceApi: GET peers/:canvasId 200 —— 委托 bus.peers(canvasId) 并透传列表', async () => {
  const peersResult = [{ userId: 'u-1', state: EDITING, lastSeenMs: 1234 }];
  const bus = fakeBus({ peersResult });
  const h = makeApi({ bus });
  const r = await h.call('GET', '/api/v2/presence/peers/c-1');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.canvasId, 'c-1');
  assert.deepEqual(r.body.peers, peersResult);
  assert.deepEqual(bus.calls.peers, ['c-1']);
});

/* ── OPTIONS：仅三条路由支持，不要求会话 ─────────────────────────── */
test('G22 presenceApi: OPTIONS 预检 → 204，无会话也放行', async (t) => {
  const h = makeHarnessBus();
  for (const url of ['/api/v2/presence/heartbeat', '/api/v2/presence/peers/c-1']) {
    await t.test(url, async () => {
      const r = await h.call('OPTIONS', url, { anon: true });
      assert.equal(r.status, 204);
      assert.equal(r.handled, true);
    });
  }
});

/* ── 未知路由：前缀内 404；前缀外不认领(false) ────────────────────── */
test('G22 presenceApi: 前缀内未知路径/方法 → 404', async (t) => {
  const h = makeHarnessBus();
  const cases = [
    ['GET', '/api/v2/presence/unknown'],
    ['GET', '/api/v2/presence/peers'],            // 缺 :canvasId 段
    ['PUT', '/api/v2/presence/heartbeat'],        // 方法不在集合
    ['DELETE', '/api/v2/presence/peers/c-1'],
    ['POST', '/api/v2/presence/peers/c-1'],
    ['GET', '/api/v2/presence/heartbeat'],
  ];
  for (const [method, url] of cases) {
    await t.test(`${method} ${url}`, async () => {
      const r = await h.call(method, url, { body: { canvasId: 'c-1', state: EDITING } });
      assert.equal(r.status, 404);
      assert.equal(r.body.ok, false);
      assert.equal(r.handled, true);
    });
  }
});

test('G22 presenceApi: 前缀外 URL 不认领 → 返回 false 且不响应', async () => {
  const h = makeHarnessBus();
  const r = await h.call('GET', '/api/v2/timelines');
  assert.equal(r.handled, false);
  assert.equal(r.status, undefined);
});

/* ══════════════ 真内存 bus 集成：归一 alias + 落库 + peers 过滤 ══════ */

test('G22 presenceApi: 真 bus —— state=busy legacy alias → 200 归一为 editing 并落库', async () => {
  const h = makeRealHarness();
  const r = await h.call('POST', '/api/v2/presence/heartbeat', { canvasId: 'c-1', state: 'busy' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.presence.state, EDITING, '响应即 canonical editing');
  // 落库断言：store 行 = editing（非 busy），userId = 会话 u-1
  const rows = h.store.list().filter((x) => x.userId === 'u-1' && x.canvasId === 'c-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, EDITING, '落库为归一后 editing');
  // 读回断言：peers 只见 canonical editing，不见 busy
  const p = await h.call('GET', '/api/v2/presence/peers/c-1');
  assert.equal(p.status, 200);
  assert.equal(p.body.peers.length, 1);
  assert.equal(p.body.peers[0].state, EDITING);
});

test('G22 presenceApi: 真 bus —— 非法 state / 缺字段 → 400，不落库', async (t) => {
  const h = makeRealHarness();
  const cases = [
    ['state 非法', { canvasId: 'c-1', state: 'idle' }],
    ['state 大写', { canvasId: 'c-1', state: 'EDITING' }],
    ['state 非字符串', { canvasId: 'c-1', state: 42 }],
    ['缺 canvasId', { state: EDITING }],
    ['缺 state', { canvasId: 'c-1' }],
    ['空 body', {}],
  ];
  for (const [label, body] of cases) {
    await t.test(label, async () => {
      const r = await h.call('POST', '/api/v2/presence/heartbeat', body);
      assert.equal(r.status, 400);
      assert.equal(r.body.ok, false);
      assert.ok(Array.isArray(r.body.errors) && r.body.errors.length > 0);
    });
  }
  assert.equal(h.store.list().length, 0, '被拒心跳一律不落库');
});

test('G22 presenceApi: 真 bus —— 多会话(多用户)同画布 + offline 离开 → peers 过滤正确', async () => {
  const store = createMemoryPresenceStore();
  const bus = createPresenceBus({ store });
  const api = createPresenceApi({
    bus,
    sessionUser: () => ({ id: 'u-1' }),
    sendJSON: (res, code, body) => { res.status = code; res.body = body; },
    parseBody: async (req) => req._body || {},
  });
  const call = async (method, url, body, user) => {
    const res = {};
    const sid = user || 'u-1';
    const anon = createPresenceApi({
      bus,
      sessionUser: () => ({ id: sid }),
      sendJSON: (res2, code, body2) => { res2.status = code; res2.body = body2; },
      parseBody: async (req2) => req2._body || {},
    });
    await anon.handle({ _body: body }, res, url, method);
    return res;
  };
  // 画布隔离：c-1 两名成员，c-2 一名成员，u-2 随后 offline 离开 c-1
  await call('POST', '/api/v2/presence/heartbeat', { canvasId: 'c-1', state: EDITING }, 'u-1');
  await call('POST', '/api/v2/presence/heartbeat', { canvasId: 'c-1', state: AWAY }, 'u-2');
  await call('POST', '/api/v2/presence/heartbeat', { canvasId: 'c-2', state: ONLINE }, 'u-3');
  await call('POST', '/api/v2/presence/heartbeat', { canvasId: 'c-1', state: OFFLINE }, 'u-2');

  const p1 = await call('GET', '/api/v2/presence/peers/c-1', undefined, 'u-1');
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.body.peers.map((x) => x.userId), ['u-1'], 'u-2 已 offline，只剩 u-1');
  assert.equal(p1.body.peers[0].state, EDITING);

  const p2 = await call('GET', '/api/v2/presence/peers/c-2', undefined, 'u-1');
  assert.deepEqual(p2.body.peers.map((x) => x.userId), ['u-3'], '画布隔离：c-2 只见 u-3');

  const p3 = await call('GET', '/api/v2/presence/peers/c-ghost', undefined, 'u-1');
  assert.equal(p3.status, 200);
  assert.deepEqual(p3.body.peers, [], '无人画布返回空列表 200');
});

test('G22 presenceApi: 真 bus —— 同 (user,canvas) 二次心跳 upsert 覆盖 state', async () => {
  const h = makeRealHarness();
  await h.call('POST', '/api/v2/presence/heartbeat', { canvasId: 'c-1', state: ONLINE });
  const r2 = await h.call('POST', '/api/v2/presence/heartbeat', { canvasId: 'c-1', state: 'busy' }); // busy→editing
  assert.equal(r2.status, 200);
  assert.equal(r2.body.presence.state, EDITING);
  assert.equal(h.store.list().length, 1, '同 key 覆盖不产生第二行');
  assert.equal(h.store.list()[0].state, EDITING);
});

test('G22 presenceApi: 创建期缺 bus/方法 → 抛 TypeError', () => {
  assert.throws(() => createPresenceApi({ sendJSON() {}, parseBody: async () => ({}) }), /bus must provide heartbeat\/peers/);
  assert.throws(() => createPresenceApi({ bus: {}, sendJSON() {}, parseBody: async () => ({}) }), /bus must provide/);
  assert.throws(() => createPresenceApi({ bus: { heartbeat() {}, peers() {} }, parseBody: async () => ({}) }), /sendJSON and parseBody/);
});
