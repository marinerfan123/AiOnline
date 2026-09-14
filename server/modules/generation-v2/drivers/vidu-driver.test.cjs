'use strict';
/**
 * Vidu Driver 测试（L25）— 覆盖：
 *   1) 接口形状：{ submit, poll, fetch, cancel, compile } + 三归一 齐全
 *   2) 双 operation compile：按 operation_code 分支出不同请求形状（text_to_video vs first_last_frame）
 *   3) 禁业务逻辑泄漏：compile 白名单，quota/billing/routing 字段绝不进 provider request
 *   4) 三归一：normalizeStatus / normalizeError / normalizeResult 同一契约形状
 *   5) 未知 operation_code 拒错误码（UNSUPPORTED_OPERATION，绝不 return null / 不静默）
 *   6) 运行时（fake http）：submit/poll/fetch 的 wire 形状 + 鉴权头 + 归一（网络错不抛）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createViduDriver, VIDU_OPERATIONS, VIDU_OPERATION_CODES, UNSUPPORTED_OPERATION,
} = require('./vidu-driver.cjs');
const { DriverContractError } = require('../provider-adapter.cjs');

const TOKEN = 'vidu-test-token';
const BASE = 'https://api.vidu.cn/'; // 带尾斜杠，测剥除

function makeHttp(responder) {
  const calls = [];
  const request = async (opts) => {
    calls.push({ ...opts, headers: { ...(opts.headers || {}) } });
    return responder(opts, calls.length);
  };
  return { request, calls, last: () => calls[calls.length - 1] };
}
const respond = (status, body) => async () => ({ status, body });

function makeDriver(overrides = {}) {
  return createViduDriver({
    http: overrides.http || makeHttp(respond(200, { task_id: 'vidu-t1' })),
    credentials: overrides.credentials || { token: TOKEN },
    baseUrl: overrides.baseUrl || BASE,
    operations: overrides.operations,
  });
}

// ═══ 1) 接口形状 ═══
test('形状: createViduDriver 返回 5 方法 + 三归一 全函数', () => {
  const d = makeDriver();
  for (const m of ['submit', 'poll', 'fetch', 'cancel', 'compile']) {
    assert.equal(typeof d[m], 'function', `缺方法 ${m}`);
  }
  for (const m of ['normalizeStatus', 'normalizeError', 'normalizeResult']) {
    assert.equal(typeof d[m], 'function', `缺归一 ${m}`);
  }
  assert.deepEqual(VIDU_OPERATION_CODES, [
    'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.reference_video',
  ]);
});

test('形状: 缺 http.request 传输层 → 抛 TypeError（构造期拒绝）', () => {
  assert.throws(() => createViduDriver({}), TypeError);
  assert.throws(() => createViduDriver({ http: {} }), TypeError);
});

test('形状: compile 返回 { method, url, body }，URL 剥尾斜杠 + 拼 endpoint', () => {
  const d = makeDriver();
  const r = d.compile({ operationCode: 'video.text_to_video', model: 'viduq3', prompt: 'hello' });
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.vidu.cn/ent/v2/text2video');
  assert.deepEqual(r.body.model, 'viduq3');
});

// ═══ 2) 双 operation compile（至少两种不同请求形状）═══
test('compile: text_to_video 形状（prompt/duration/aspect_ratio，无 images）', () => {
  const d = makeDriver();
  const r = d.compile({
    operationCode: 'video.text_to_video', model: 'viduq3', prompt: 'a cat', durationSec: 8, aspectRatio: '16:9',
  });
  assert.deepEqual(r.url, 'https://api.vidu.cn/ent/v2/text2video');
  assert.deepEqual(r.body, { model: 'viduq3', prompt: 'a cat', duration: 8, aspect_ratio: '16:9' });
  assert.ok(!('images' in r.body));
  assert.ok(!('subjects' in r.body));
});

test('compile: first_last_frame 形状（images:[first,last]，要求两图）', () => {
  const d = makeDriver();
  const r = d.compile({
    operationCode: 'video.first_last_frame', model: 'viduq3', referenceImages: ['START.png', 'END.png'], durationSec: 5,
  });
  assert.deepEqual(r.url, 'https://api.vidu.cn/ent/v2/frame2frame');
  assert.deepEqual(r.body, { model: 'viduq3', images: ['START.png', 'END.png'], duration: 5 });
  assert.ok(!('prompt' in r.body));
});

test('compile: 双 operation 形状不同（text vs 首尾帧 分支不混淆）', () => {
  const d = makeDriver();
  const t2v = d.compile({ operationCode: 'video.text_to_video', prompt: 'x', referenceImages: ['a', 'b'] });
  const ff = d.compile({ operationCode: 'video.first_last_frame', referenceImages: ['a', 'b'] });
  assert.notEqual(t2v.url, ff.url);
  assert.ok(!('images' in t2v.body), 'text2video 不应有 images');
  assert.deepEqual(ff.body.images, ['a', 'b'], '首尾帧应有 images');
});

test('compile: reference_video 形状（subjects 1..7 参考图）', () => {
  const d = makeDriver();
  const refs = Array.from({ length: 9 }, (_, i) => `r${i}.png`);
  const r = d.compile({ operationCode: 'video.reference_video', referenceImages: refs, prompt: 'keep' });
  assert.deepEqual(r.url, 'https://api.vidu.cn/ent/v2/reference2video');
  assert.deepEqual(r.body.subjects, refs.slice(0, 7)); // 封顶 7
});

// ═══ 3) 禁业务逻辑泄漏 ═══
test('compile: quota/billing/routing/userId 业务字段绝不进 provider request', () => {
  const d = makeDriver();
  const r = d.compile({
    operationCode: 'video.image_to_video',
    prompt: 'x', referenceImages: ['f.png'],
    // 业务字段（本层禁碰）
    credits: 100, quotaScope: 'gpu', routingPolicy: { tier: 'auto' },
    userId: 'u-1', billing: { unitPrice: 50 }, costEstimate: 4,
  });
  const body = r.body;
  for (const leak of ['credits', 'quotaScope', 'routingPolicy', 'userId', 'billing', 'costEstimate', 'unitPrice']) {
    assert.ok(!(leak in body), `业务字段 ${leak} 泄漏进 request body`);
  }
  assert.deepEqual(body, { model: 'viduq3', images: ['f.png'], prompt: 'x' });
});

test('compile: 缺 operation_code → 拒 UNSUPPORTED_OPERATION（非静默）', () => {
  const d = makeDriver();
  assert.throws(
    () => d.compile({ prompt: 'x' }),
    (e) => e instanceof DriverContractError && e.code === UNSUPPORTED_OPERATION,
  );
});

// ═══ 4) 三归一 ═══
test('normalizeStatus: vidu 状态词 → 契约枚举', () => {
  const d = makeDriver();
  assert.equal(d.normalizeStatus('success'), 'success');
  assert.equal(d.normalizeStatus('processing'), 'pending');
  assert.equal(d.normalizeStatus('failed'), 'failed');
  assert.equal(d.normalizeStatus('not_found'), 'not_found');
  assert.equal(d.normalizeStatus('weird'), 'unknown');
});

test('normalizeError: 产出 { status, errorCode, errorMessage, retryAfter? }', () => {
  const d = makeDriver();
  assert.deepEqual(d.normalizeError({ code: 'RATE_LIMIT', message: 'busy', retryAfter: 30 }), {
    status: 'unknown', errorCode: 'RATE_LIMIT', errorMessage: 'busy', retryAfter: 30,
  });
  assert.equal(d.normalizeError({ code: 'NOT_FOUND' }).status, 'not_found');
  assert.equal(d.normalizeError({ code: 'CONTENT_POLICY' }).status, 'failed');
  assert.equal(d.normalizeError({ code: 'ETIMEDOUT' }).status, 'unknown'); // 绝不判 failed
});

test('normalizeResult: 抽 vidu 嵌套形状（data.url / creations[0].url / data.status）→ 契约形状', () => {
  const d = makeDriver();
  assert.deepEqual(d.normalizeResult({ status: 'success', data: { url: 'https://cdn/v.mp4', cover_url: 'c.jpg' } }), {
    status: 'success', providerUrl: 'https://cdn/v.mp4',
  });
  assert.deepEqual(d.normalizeResult({ creations: [{ url: 'https://cdn/c.mp4' }], status: 'success' }), {
    status: 'success', providerUrl: 'https://cdn/c.mp4',
  });
  // 状态嵌套在 data 内也要被抽平
  assert.equal(d.normalizeResult({ data: { status: 'success', url: 'u.mp4' } }).status, 'success');
  assert.deepEqual(d.normalizeResult({ status: 'pending' }), {
    status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'still processing',
  });
});

// ═══ 5) 未知 operation_code 拒错误码 ═══
test('compile: 未知 operation_code → 拒 DriverContractError(code=UNSUPPORTED_OPERATION)', () => {
  const d = makeDriver();
  assert.throws(
    () => d.compile({ operationCode: 'video.super_res' }),
    (e) => e instanceof DriverContractError
      && e.code === UNSUPPORTED_OPERATION
      && /video\.super_res/.test(e.message),
  );
});

test('submit: 未知 operation_code → 归一为 error（code=UNSUPPORTED_OPERATION），不抛', async () => {
  const d = makeDriver();
  const r = await d.submit({ operationCode: 'video.super_res' });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, UNSUPPORTED_OPERATION);
});

// ═══ 6) 运行时（fake http）═══
test('submit: wire 形状 + Token 鉴权头 + pending 结果', async () => {
  const http = makeHttp(respond(200, { task_id: 'vidu-task-9' }));
  const d = makeDriver({ http });
  const r = await d.submit({ operationCode: 'video.text_to_video', model: 'viduq3', prompt: 'p', durationSec: 8 });
  assert.equal(http.calls.length, 1);
  const c = http.last();
  assert.equal(c.url, 'https://api.vidu.cn/ent/v2/text2video');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, `Token ${TOKEN}`); // 非 Bearer
  assert.deepEqual(c.body, { model: 'viduq3', prompt: 'p', duration: 8 });
  assert.deepEqual(r, { status: 'pending', providerTaskId: 'vidu-task-9', providerRequestId: 'vidu-task-9' });
});

test('submit: 缺 Token 直接拒 AUTH_ERROR（不发请求）', async () => {
  const http = makeHttp(respond(200, { task_id: 't' }));
  const d = makeDriver({ http, credentials: {} });
  const r = await d.submit({ operationCode: 'video.text_to_video', prompt: 'x' });
  assert.equal(http.calls.length, 0);
  assert.equal(r.errorCode, 'AUTH_ERROR');
  assert.equal(r.status, 'failed');
});

test('submit: 网络错归一为 error 不抛（status=unknown）', async () => {
  const http = makeHttp(async () => { throw new Error('ECONNRESET'); });
  const d = makeDriver({ http });
  const r = await d.submit({ operationCode: 'video.text_to_video', prompt: 'x' });
  assert.equal(r.status, 'unknown'); // 绝不判 failed
  assert.equal(r.errorCode, 'UNKNOWN');
});

test('submit: 429 → RATE_LIMIT 保留 retryAfter', async () => {
  const http = makeHttp(respond(429, { error: { message: 'too busy' }, retry_after: 15 }));
  const d = makeDriver({ http });
  const r = await d.submit({ operationCode: 'video.text_to_video', prompt: 'x' });
  assert.equal(r.errorCode, 'RATE_LIMIT');
  assert.equal(r.status, 'unknown');
  assert.equal(r.retryAfter, 15);
});

test('poll: GET task/creations，success 态归一', async () => {
  const http = makeHttp(respond(200, { status: 'success', data: { url: 'v.mp4' } }));
  const d = makeDriver({ http });
  const r = await d.poll('vidu-t');
  assert.equal(http.last().url, 'https://api.vidu.cn/ent/v2/tasks/vidu-t/creations');
  assert.equal(http.last().method, 'GET');
  assert.deepEqual(r, { status: 'success', providerTaskId: 'vidu-t' });
});

test('fetch: 成功取 providerUrl（嵌套 data.url）', async () => {
  const http = makeHttp(respond(200, { status: 'success', data: { url: 'https://cdn/final.mp4' } }));
  const d = makeDriver({ http });
  const r = await d.fetch('vidu-t');
  assert.equal(r.status, 'success');
  assert.equal(r.providerUrl, 'https://cdn/final.mp4');
});

test('cancel: 无公开取消端点 → UNSUPPORTED（禁 return null）', async () => {
  const d = makeDriver();
  const r = await d.cancel('vidu-t');
  assert.equal(r.errorCode, 'UNSUPPORTED');
  assert.ok(r.status !== null && r.status !== undefined);
});

// ── 静态工厂注册（§138 无副作用）──
test('静态注册: 模块加载即登记 vidu 工厂（无副作用），fromContract 经 instantiate 解析', () => {
  const { registeredDriverFactories, fromContract } = require('../provider-adapter.cjs');
  assert.ok(registeredDriverFactories().includes('vidu'));
  const adapter = fromContract('p-vidu', { driver_kind: 'vidu' }, {
    instantiate: (f) => f({ http: { request: async () => ({ status: 200, body: { task_id: 't' } }) }, credentials: { token: 'tok' } }),
  });
  assert.equal(adapter.driverKind, 'vidu');
  assert.equal(typeof adapter.submit, 'function');
});
