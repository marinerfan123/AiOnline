'use strict';
/**
 * volcengine 直连 Driver（L23）自测 —— server/modules/generation-v2/drivers/volcengine-driver.cjs
 *
 * 覆盖（注入 http mock，无真实网络调用）：
 *   1. 接口形状：createVolcengineDriver 返回 { submit, poll, fetch, cancel, compile } 五方法齐全
 *   2. submit：compile 业务输入 → 编译请求形状（URL/方法/鉴权头/body），成功返回 providerTaskId
 *   3. poll：归一映射 success / failed / pending / unknown（复用 provider-adapter 三归一）
 *   4. fetch：产物 url 归一（video_url / url / videoUrl / images[0] → providerUrl）
 *   5. cancel：DELETE 任务 → canceled；404 → not_found；异常归一不抛裸
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVolcengineDriver, DEFAULT_BASE_URL } = require('./volcengine-driver.cjs');

const API_KEY = 'sk-volcengine-test';
const CREDENTIALS = { apiKey: API_KEY };
const SUBMIT_URL = `${DEFAULT_BASE_URL}/contents/generations/tasks`;

// ── 注入 http mock（记录调用，按 responder 回放）──
function makeHttp(responder) {
  const calls = [];
  const http = {
    request: async (url, opts) => {
      const rec = { url: String(url), method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {}, body: opts && opts.body };
      calls.push(rec);
      return responder ? await responder(rec) : { status: 200, body: {} };
    },
  };
  return { http, calls, last: () => calls[calls.length - 1] };
}
const respond = (status, body) => async () => ({ status, body });

function makeDriver(responder, extra = {}) {
  const { http, calls, last } = makeHttp(responder);
  const driver = createVolcengineDriver({ http, credentials: CREDENTIALS, ...extra });
  return { driver, calls, last };
}

// ── 1) 接口形状 ──
test('接口形状: 返回 {submit,poll,fetch,cancel,compile} 五方法齐全', () => {
  const { driver } = makeDriver();
  assert.equal(typeof driver.submit, 'function');
  assert.equal(typeof driver.poll, 'function');
  assert.equal(typeof driver.fetch, 'function');
  assert.equal(typeof driver.cancel, 'function');
  assert.equal(typeof driver.compile, 'function');
  assert.deepEqual(Object.keys(driver).sort(), ['cancel', 'compile', 'fetch', 'poll', 'submit']);
});

test('接口形状: 缺 http.request / credentials.apiKey 拒绝（错误码非 null）', () => {
  assert.throws(() => createVolcengineDriver({ credentials: CREDENTIALS }), /http\.request is required/);
  assert.throws(() => createVolcengineDriver({ http: { request: async () => ({}) } }), /credentials\.apiKey is required/);
  assert.throws(() => createVolcengineDriver({ http: { request: async () => ({}) }, credentials: { apiKey: '  ' } }), /credentials\.apiKey is required/);
});

// ── 2) submit 编译请求形状 ──
test('submit: 业务输入 → 编译请求（POST URL/鉴权头/body=compile 结果）+ submitted 返回', async () => {
  const { driver, calls, last } = makeDriver(respond(200, { id: 'ark-task-1' }));
  const businessInput = {
    model: 'doubao-seedance-2-5-pro',
    prompt: 'cat on sofa',
    ratio: '16:9',
    resolution: '720p',
    durationSec: 10,
  };
  const r = await driver.submit(businessInput);

  assert.equal(calls.length, 1);
  const c = last();
  assert.equal(c.url, SUBMIT_URL);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
  // body 必须等于 compile(businessInput) —— submit 仅委托 compile，不另建请求。
  assert.deepEqual(c.body, driver.compile(businessInput));
  assert.deepEqual(c.body, {
    model: 'doubao-seedance-2-5-pro',
    content: [{ type: 'text', text: 'cat on sofa' }],
    resolution: '720p',
    ratio: '16:9',
    duration: 10,
  });
  assert.deepEqual(r, { status: 'submitted', providerTaskId: 'ark-task-1', taskId: 'ark-task-1' });
});

test('submit: 参考图 → content[] 嵌套 image_url.url + role 编码；response 在 data.id', async () => {
  const { driver, last } = makeDriver(respond(200, { data: { id: 'ark-d-2' } }));
  const r = await driver.submit({
    model: 'doubao-seedance-2-0',
    prompt: 'zoom in',
    referenceImages: ['https://img/f.png', 'https://img/l.png'],
    videoMode: 'i2v_first_last',
  });
  assert.deepEqual(last().body.content, [
    { type: 'text', text: 'zoom in' },
    { type: 'image_url', role: 'first_frame', image_url: { url: 'https://img/f.png' } },
    { type: 'image_url', role: 'last_frame', image_url: { url: 'https://img/l.png' } },
  ]);
  assert.deepEqual(r, { status: 'submitted', providerTaskId: 'ark-d-2', taskId: 'ark-d-2' });
});

test('submit: 缺 id / 业务错误 → 归一 error（不抛裸）', async () => {
  const { driver } = makeDriver(respond(200, { error: { code: 'QuotaExhausted', message: 'no quota left' } }));
  const r = await driver.submit({ model: 'm', prompt: 'p' });
  assert.equal(r.status, 'unknown'); // 归一 error（QuotaExhausted 非 FAILED_CODES → unknown，可重试）
  assert.match(r.errorMessage, /no quota left/);
});

// ── 3) poll 归一映射（success/failed/pending/unknown）──
test('poll: success → normalizeResult（providerUrl + providerRequestId）', async () => {
  const { driver, last } = makeDriver(respond(200, { data: { status: 'succeeded', video_url: 'https://arkcdn/v.mp4' } }));
  const r = await driver.poll('ark-task-1');
  assert.equal(r.status, 'success');
  assert.equal(r.providerUrl, 'https://arkcdn/v.mp4');
  assert.equal(r.providerRequestId, 'ark-task-1');
  assert.equal(last().url, `${DEFAULT_BASE_URL}/contents/generations/tasks/ark-task-1`);
  assert.equal(last().method, 'GET');
});

test('poll: failed → {status:failed, errorCode:PROVIDER_FAILED, errorMessage}', async () => {
  const { driver } = makeDriver(respond(200, { data: { status: 'failed', error: { code: 'TaskFailed', message: 'generation died' } } }));
  const r = await driver.poll('ark-task-1');
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'PROVIDER_FAILED');
  assert.match(r.errorMessage, /generation died/);
});

test('poll: pending → {status:pending, errorCode:STILL_PROCESSING}', async () => {
  const { driver } = makeDriver(respond(200, { data: { status: 'queued' } }));
  const r = await driver.poll('ark-task-1');
  assert.equal(r.status, 'pending');
  assert.equal(r.errorCode, 'STILL_PROCESSING');
});

test('poll: unknown（空 body / 陌生状态词）→ {status:unknown}，不抛裸', async () => {
  const empty = makeDriver(respond(200, {}));
  const r1 = await empty.driver.poll('ark-task-1');
  assert.equal(r1.status, 'unknown');

  const weird = makeDriver(respond(200, { data: { status: 'bogus_state' } }));
  const r2 = await weird.driver.poll('ark-task-1');
  assert.equal(r2.status, 'unknown');
});

test('poll: 404 → not_found', async () => {
  const { driver } = makeDriver(respond(404, { error: { message: 'not found' } }));
  const r = await driver.poll('ark-task-1');
  assert.equal(r.status, 'not_found');
  assert.equal(r.errorCode, 'NOT_FOUND');
});

test('poll: 网络异常 → 归一 error（unknown，不抛裸）', async () => {
  const { http } = makeHttp(async () => { throw new TypeError('ECONNRESET'); });
  const driver = createVolcengineDriver({ http, credentials: CREDENTIALS });
  const r = await driver.poll('ark-task-1');
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'NETWORK_ERROR');
  assert.match(r.errorMessage, /ECONNRESET/);
});

// ── 4) fetch 产物 url 归一 ──
test('fetch: video_url → providerUrl', async () => {
  const { driver } = makeDriver(respond(200, { data: { status: 'succeeded', video_url: 'https://arkcdn/v.mp4' } }));
  const r = await driver.fetch('ark-task-1');
  assert.equal(r.status, 'success');
  assert.equal(r.providerUrl, 'https://arkcdn/v.mp4');
});

test('fetch: url / videoUrl / images[0] 多形状归一', async () => {
  const cases = [
    [{ status: 'succeeded', url: 'https://cdn/u.mp4' }, 'https://cdn/u.mp4'],
    [{ status: 'succeeded', videoUrl: 'https://cdn/vu.mp4' }, 'https://cdn/vu.mp4'],
    [{ status: 'succeeded', images: ['https://cdn/i1.mp4', 'https://cdn/i2.mp4'] }, 'https://cdn/i1.mp4'],
  ];
  for (const [body, want] of cases) {
    const { driver } = makeDriver(respond(200, { data: body }));
    const r = await driver.fetch('ark-task-1');
    assert.equal(r.status, 'success', JSON.stringify(body));
    assert.equal(r.providerUrl, want, JSON.stringify(body));
  }
});

test('fetch: 非终态（pending）→ 保留 pending 语义（不伪造成功 url）', async () => {
  const { driver } = makeDriver(respond(200, { data: { status: 'processing' } }));
  const r = await driver.fetch('ark-task-1');
  assert.equal(r.status, 'pending');
});

// ── 5) cancel ──
test('cancel: DELETE 任务 → {status:canceled, providerTaskId}', async () => {
  const { driver, last } = makeDriver(respond(204, {}));
  const r = await driver.cancel('ark-task-1');
  assert.equal(last().method, 'DELETE');
  assert.equal(last().url, `${DEFAULT_BASE_URL}/contents/generations/tasks/ark-task-1`);
  assert.deepEqual(r, { status: 'canceled', providerTaskId: 'ark-task-1' });
});

test('cancel: 404 → not_found；5xx → unknown（归一，不抛裸）', async () => {
  const nf = makeDriver(respond(404, {}));
  assert.equal((await nf.driver.cancel('t1')).status, 'not_found');

  const err = makeDriver(respond(500, {}));
  const r = await err.driver.cancel('t1');
  assert.equal(r.status, 'unknown'); // 5xx 瞬时 → unknown（可重试，绝不判 failed）
  assert.equal(r.errorCode, 'HTTP_500');
});

// ── compile 边界：仅委托，无业务逻辑 ──
test('compile: 仅透传 provider 层可表达参数（不掺 quota/billing/routing 字段）', () => {
  const { driver } = makeDriver();
  const out = driver.compile({
    model: 'm', prompt: 'p', ratio: '9:16', resolution: '4k', durationSec: 12, seed: 7,
    // 上层业务字段（不应泄漏进 provider request）
    userId: 'u1', quotaScope: 's', maxCostAuthorized: 100, routingPolicy: 'r',
  });
  assert.deepEqual(out, {
    model: 'm',
    content: [{ type: 'text', text: 'p' }],
    resolution: '4k',
    ratio: '9:16',
    duration: 12,
    seed: 7,
  });
  assert.ok(!('userId' in out) && !('quotaScope' in out) && !('maxCostAuthorized' in out) && !('routingPolicy' in out));
});
