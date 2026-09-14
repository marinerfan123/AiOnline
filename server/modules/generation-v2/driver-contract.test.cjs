'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// L26 — Driver Normalize Contract Tests（Golden Fixture 契约锁定，防 drift §127）
// ═══════════════════════════════════════════════════════════════════════════
// 断言「三归一」函数对 golden 样本输出与 expected 字面量一致。
//   normalizeStatus / normalizeError / normalizeResult 实现一旦漂移 → 本测试红。
// 未知 raw 形状 → 'unknown' 且**不抛异常**（§22「绝不 return null 让调用方猜」）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStatus, normalizeError, normalizeResult, NORMALIZED_STATUSES } = require('./provider-adapter.cjs');
const { DRIVER_KINDS, GOLDEN_FIXTURES } = require('./fixtures/driver-golden-fixtures.cjs');
const { FakeProvider } = require('./fake-provider.cjs');

const KINDS = Object.values(DRIVER_KINDS);
const RESULT_STATES = ['success', 'failed', 'pending', 'unknown'];

// ─── 0) Fixture 完整性自检（防 fixtures 自身漂移） ───
test('fixtures: id 唯一且形状合法', () => {
  const ids = new Set();
  for (const f of GOLDEN_FIXTURES) {
    assert.ok(f.fn === 'status' || f.fn === 'error' || f.fn === 'result', `${f.id}: fn 非法`);
    assert.ok(KINDS.includes(f.driverKind), `${f.id}: driverKind 非法 ${f.driverKind}`);
    assert.ok(ids.has(f.id) === false, `${f.id}: id 重复`);
    ids.add(f.id);
    if (f.fn === 'status') {
      assert.ok(NORMALIZED_STATUSES.includes(f.expected), `${f.id}: expected 不在规范枚举`);
    } else {
      assert.ok(NORMALIZED_STATUSES.includes(f.expected.status), `${f.id}: expected.status 不在规范枚举`);
    }
  }
});

test('fixtures: 每 driver_kind 至少 3 条 result 黄金样本且 success/failed/pending/unknown 全态覆盖', () => {
  for (const kind of KINDS) {
    const resultFixtures = GOLDEN_FIXTURES.filter((f) => f.fn === 'result' && f.driverKind === kind);
    assert.ok(resultFixtures.length >= 3, `${kind}: result 样本 ${resultFixtures.length} < 3`);
    const states = new Set(resultFixtures.map((f) => f.state));
    for (const s of RESULT_STATES) {
      assert.ok(states.has(s), `${kind}: 缺 ${s} 态 result 样本`);
    }
  }
});

// ─── 1) 契约锁定：三归一对 golden 样本输出 === expected ───
function runFn(fn, raw) {
  if (fn === 'status') return normalizeStatus(raw);
  if (fn === 'error') return normalizeError(raw);
  return normalizeResult(raw);
}

for (const f of GOLDEN_FIXTURES) {
  test(`golden[${f.driverKind}] ${f.id}: ${f.fn}(${JSON.stringify(f.raw)})`, () => {
    assert.deepEqual(runFn(f.fn, f.raw), f.expected);
  });
}

// ─── 2) 未知 raw 形状 → unknown 且不抛（显式，独立于 fixtures） ───
test('未知 raw 形状 → unknown 且不抛异常', () => {
  // normalizeStatus：任意非词表输入
  assert.equal(normalizeStatus(undefined), 'unknown');
  assert.equal(normalizeStatus({ status: 'x' }), 'unknown');
  assert.equal(normalizeStatus(123), 'unknown');
  assert.equal(normalizeStatus([123]), 'unknown');
  assert.equal(normalizeStatus(Symbol('x')), 'unknown');
  // normalizeError：任意形状
  assert.equal(normalizeError(undefined).status, 'unknown');
  assert.equal(normalizeError(123).status, 'unknown');
  assert.equal(normalizeError({ weird: true }).status, 'unknown');
  assert.equal(normalizeError([1, 2]).status, 'unknown');
  assert.equal(normalizeError(new Error('boom')).status, 'unknown');
  assert.equal(normalizeError(new Error('boom')).errorCode, 'UNKNOWN');
  // normalizeResult：任意形状
  assert.equal(normalizeResult(undefined).status, 'unknown');
  assert.equal(normalizeResult(123).status, 'unknown');
  assert.equal(normalizeResult(true).status, 'unknown');
  assert.equal(normalizeResult(Symbol('x')).status, 'unknown');
  // 断言全程不抛（上述调用若抛则本测试已失败）
  assert.doesNotThrow(() => normalizeResult({ status: { nested: 1 } }));
  assert.doesNotThrow(() => normalizeError({ code: 123, message: 456 }));
  assert.doesNotThrow(() => normalizeStatus(123));
});

test('normalizeResult: 裸 failed 状态词（无 errorCode）保守收敛为 unknown（§70 UNKNOWN 绝不当 FAILED）', () => {
  // 契约现状：status 词 'failed' 但无 FAILED_CODES 中的 errorCode → unknown，非 failed
  assert.equal(normalizeResult({ status: 'failed' }).status, 'unknown');
  assert.equal(normalizeResult({ status: 'failed', errorCode: 'CONTENT_POLICY' }).status, 'failed');
});

// ─── 3) Fake Provider golden 一致路径 round-trip（§125） ───
const _jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('fake-provider: goldenRaw(kind,state) 与 fixture.raw 单一来源一致 + round-trip', () => {
  const fp = new FakeProvider();
  const resultFixtures = GOLDEN_FIXTURES.filter((x) => x.fn === 'result');
  const seen = new Set();
  for (const f of resultFixtures) {
    const key = `${f.driverKind}:${f.state}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const raw = fp.goldenRaw(f.driverKind, f.state);
    assert.ok(raw != null, `${key} goldenRaw 未命中`);
    // goldenRaw 必须命中该 (kind,state) 下某条 fixture.raw（单一来源，防 fake-provider 漂移）
    const matched = resultFixtures.find((x) => x.driverKind === f.driverKind && x.state === f.state && _jsonEq(x.raw, raw));
    assert.ok(matched, `${key}: goldenRaw 与任何 fixture.raw 不一致`);
    // round-trip：golden raw 经 normalizeResult 必须回到 expected
    assert.deepEqual(normalizeResult(raw), matched.expected, `${key}: golden round-trip 漂移`);
  }
});

test('fake-provider: dispatchSingle 四种契约态 outcome 与 golden expected 一致', async () => {
  const cases = [
    ['success', 'success'],
    ['failed', 'failed'],
    ['contract_pending', 'pending'],
    ['unknown_status', 'unknown'],
  ];
  for (const [outcome, state] of cases) {
    const fp = new FakeProvider({ defaultOutcome: outcome });
    const raw = await fp.dispatchSingle({ count: 1 });
    const n = normalizeResult(raw);
    assert.equal(n.status, state, `outcome ${outcome} → ${n.status}`);
  }
});

// ─── 4) 审计回归（L22-25 接线 + 429/5xx 一致性）───
const {
  fromContract, registerDriver, registerDriverFactory,
  DRIVER_ERROR, DriverContractError,
} = require('./provider-adapter.cjs');
const { createViduDriver } = require('./drivers/vidu-driver.cjs');
const { createFalDriver, mapFalStatus } = require('./drivers/fal-driver.cjs');
const { createVolcengineDriver } = require('./drivers/volcengine-driver.cjs');

function _auditFakeDriver() {
  return { submit: async () => ({}), poll: async () => ({}), fetch: async () => ({}), cancel: async () => ({}), compile: () => ({}) };
}

test('fromContract: 显式 drivers 部分映射 → 回退静态工厂注册表（非排他），未注入 instantiate → DRIVER_NOT_INSTANTIATED', () => {
  const kind = 'audit-fallback-factory';
  registerDriverFactory(kind, () => _auditFakeDriver());
  // 传入 drivers 映射但不含该 kind：此前排他分支直接判 UNKNOWN_DRIVER_KIND（掩盖真实原因，被调用方误吞为配置错）；
  // 修复后回退到工厂注册表，因未注入 instantiate → 明确 DRIVER_NOT_INSTANTIATED（kind 已知）。
  assert.throws(
    () => fromContract('p', { driver_kind: kind }, { drivers: { agnes: _auditFakeDriver() } }),
    (e) => e instanceof DriverContractError && e.code === DRIVER_ERROR.DRIVER_NOT_INSTANTIATED,
  );
});

test('fromContract: 显式 drivers 未命中 → 回退静态实例注册表', () => {
  const kind = 'audit-fallback-instance';
  registerDriver(kind, _auditFakeDriver());
  const adapter = fromContract('p', { driver_kind: kind }, { drivers: { other: _auditFakeDriver() } });
  assert.equal(adapter.driverKind, kind);
});

test('driver 一致性: vidu 5xx → unknown/NETWORK_ERROR（绝不判 failed），保留 retryAfter', async () => {
  const d = createViduDriver({
    http: { request: async () => ({ status: 503, body: { error: { message: 'overloaded' }, retry_after: 7 } }) },
    credentials: { token: 't' },
  });
  const r = await d.submit({ operationCode: 'video.text_to_video', prompt: 'x' });
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'NETWORK_ERROR');
  assert.equal(r.retryAfter, 7);
});

test('driver 一致性: volcengine 429 → RATE_LIMIT + retryAfter（非 body.error.code 直通）', async () => {
  const d = createVolcengineDriver({
    http: { request: async () => ({ status: 429, body: { error: { code: 'RateLimitExceeded', message: 'slow down' }, retry_after: 12 } }) },
    credentials: { apiKey: 'k' },
  });
  const r = await d.submit({ model: 'm', prompt: 'p' });
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'RATE_LIMIT');
  assert.equal(r.retryAfter, 12);
});

test('driver 一致性: fal 429 → RATE_LIMIT + 抽取 retryAfter（body retry_after）', async () => {
  const d = createFalDriver({
    http: async () => ({ status: 429, body: { detail: 'busy', retry_after: 20 } }),
    credentials: 'k',
  });
  const r = await d.poll({ statusUrl: 'https://queue.fal.run/m/r/status' });
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'RATE_LIMIT');
  assert.equal(r.retryAfter, 20);
});

test('覆盖缺口: golden 只锁 base 三归一，未覆盖 driver 的 mapFalStatus / 嵌套 normalizeResult 分支', () => {
  // fixture fal-status-004 锁 base normalizeStatus('IN_QUEUE')='unknown'；但 fal driver 先 mapFalStatus→'queued' 再归一 → 'pending'。
  // 黄金样本未覆盖 fal 词表映射与 vidu 嵌套抽平，属 §127 覆盖缺口（非实现漂移）。
  assert.equal(mapFalStatus('IN_QUEUE'), 'queued');
  assert.equal(normalizeStatus(mapFalStatus('IN_QUEUE')), 'pending');
  const vd = createViduDriver({ http: { request: async () => ({ status: 200, body: {} }) }, credentials: { token: 't' } });
  assert.equal(vd.normalizeResult({ status: 'success', data: { url: 'https://cdn/v.mp4' } }).providerUrl, 'https://cdn/v.mp4');
});
