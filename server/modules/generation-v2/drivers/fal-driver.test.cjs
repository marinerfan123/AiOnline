'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFalDriver, mapFalStatus, normalizeArtifacts, registerFalDriver, DEFAULT_BASE_URL,
} = require('./fal-driver.cjs');
const { DriverContractError } = require('../provider-adapter.cjs');

const BASE = 'https://queue.fal.run';

// fake http：记录请求，按 url/route 返回预设响应；返回 {status, body}（与 shared.fetchJson 同形）。
function fakeHttp(routes) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const r = routes[opts.method + ' ' + opts.url];
    if (!r) return { status: 404, body: { detail: 'not routed' } };
    return typeof r === 'function' ? r(opts) : r;
  };
  fn.calls = calls;
  return fn;
}

function makeDriver(http, overrides = {}) {
  return createFalDriver({ http, credentials: 'test-key', baseUrl: BASE, ...overrides });
}

// ═══ 1) 形状：createFalDriver 返回 {submit,poll,fetch,cancel,compile} 五方法 ═══
test('形状: createFalDriver 返回 submit/poll/fetch/cancel/compile 五方法', () => {
  const d = createFalDriver({ http: async () => ({ status: 200, body: {} }), credentials: 'k' });
  for (const m of ['submit', 'poll', 'fetch', 'cancel', 'compile']) {
    assert.equal(typeof d[m], 'function', `missing ${m}`);
  }
});

test('形状: 缺 http / 缺 credentials 拒绝(错误码 CONTRACT_MISSING)', () => {
  assert.throws(
    () => createFalDriver({ credentials: 'k' }),
    (e) => e instanceof DriverContractError && e.code === 'CONTRACT_MISSING',
  );
  assert.throws(
    () => createFalDriver({ http: async () => ({ status: 200, body: {} }) }),
    (e) => e instanceof DriverContractError && e.code === 'CONTRACT_MISSING',
  );
});

// ═══ 2) compile 边界 ═══
test('compile 边界: 业务输入 → {appId,input}，剥离业务字段保留模型参数', () => {
  const d = makeDriver(async () => ({ status: 200, body: {} }));
  const out = d.compile({
    model: 'fal-ai/flux/schnell', operation: 'text_to_image', prompt: 'a cat',
    count: 4, idempotencyKey: 'ik-1', clientRequestId: 'cr-1', pendingIds: ['p0'], contentType: 'image',
    resolution: '2k', aspect_ratio: '16:9', seed: 7,
  });
  assert.equal(out.appId, 'fal-ai/flux/schnell');
  assert.deepEqual(out.input, { prompt: 'a cat', resolution: '2k', aspect_ratio: '16:9', seed: 7 });
  // 业务字段不得泄漏给 provider
  for (const k of ['model', 'operation', 'count', 'idempotencyKey', 'clientRequestId', 'pendingIds', 'contentType']) {
    assert.ok(!(k in out.input), `业务字段 ${k} 泄漏`);
  }
});

test('compile 边界: 缺 model/appId 拒绝(错误码 INVALID_INPUT)', () => {
  const d = makeDriver(async () => ({ status: 200, body: {} }));
  assert.throws(
    () => d.compile({ prompt: 'x' }),
    (e) => e instanceof DriverContractError && e.code === 'INVALID_INPUT',
  );
});

// ═══ 3) submit：建 queue/任务引用 ═══
test('submit: POST queue 建任务引用(requestId/statusUrl/responseUrl/cancelUrl + Auth Key)', async () => {
  const http = fakeHttp({
    [`POST ${BASE}/fal-ai/flux/schnell`]: { status: 200, body: {
      request_id: 'req-1',
      status_url: `${BASE}/fal-ai/flux/schnell/requests/req-1/status`,
      response_url: `${BASE}/fal-ai/flux/schnell/requests/req-1`,
      cancel_url: `${BASE}/fal-ai/flux/schnell/requests/req-1/cancel`,
    } },
  });
  const d = makeDriver(http);
  const ref = await d.submit(d.compile({ model: 'fal-ai/flux/schnell', prompt: 'x' }));

  assert.equal(ref.status, 'success');
  assert.equal(ref.requestId, 'req-1');
  assert.equal(ref.appId, 'fal-ai/flux/schnell');
  assert.equal(ref.statusUrl, `${BASE}/fal-ai/flux/schnell/requests/req-1/status`);
  assert.equal(ref.responseUrl, `${BASE}/fal-ai/flux/schnell/requests/req-1`);
  assert.equal(ref.cancelUrl, `${BASE}/fal-ai/flux/schnell/requests/req-1/cancel`);

  const call = http.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${BASE}/fal-ai/flux/schnell`);
  assert.equal(call.headers.Authorization, 'Key test-key');
  assert.deepEqual(call.body, { prompt: 'x' });
});

test('submit: 缺 request_id → 未知(不臆造 task id)；404 → not_found', async () => {
  const noId = makeDriver(fakeHttp({ [`POST ${BASE}/m`]: { status: 200, body: {} } }));
  const r1 = await noId.submit({ appId: 'm', input: {} });
  assert.equal(r1.status, 'unknown');

  const nf = makeDriver(fakeHttp({ [`POST ${BASE}/m`]: { status: 404, body: { detail: 'no app' } } }));
  const r2 = await nf.submit({ appId: 'm', input: {} });
  assert.equal(r2.status, 'not_found');
  assert.equal(r2.errorCode, 'NOT_FOUND');
});

// ═══ 4) poll 多态：queued → running → completed / failed ═══
test('poll 多态: IN_QUEUE / IN_PROGRESS → pending', async () => {
  for (const st of ['IN_QUEUE', 'IN_PROGRESS']) {
    const http = fakeHttp({ ['GET ' + BASE + '/m/requests/r/status']: { status: 200, body: { status: st } } });
    const r = await makeDriver(http).poll({ statusUrl: `${BASE}/m/requests/r/status` });
    assert.equal(r.status, 'pending', `${st} 应映射 pending`);
    assert.equal(r.errorCode, 'STILL_PROCESSING');
  }
});

test('poll 多态: COMPLETED → success(带 responseUrl)', async () => {
  const http = fakeHttp({
    ['GET ' + BASE + '/m/requests/r/status']: {
      status: 200, body: { status: 'COMPLETED', response_url: `${BASE}/m/requests/r` },
    },
  });
  const r = await makeDriver(http).poll({ statusUrl: `${BASE}/m/requests/r/status` });
  assert.equal(r.status, 'success');
  assert.equal(r.responseUrl, `${BASE}/m/requests/r`);
});

test('poll 多态: FAILED → failed(复用 adapter normalizeError)', async () => {
  const http = fakeHttp({
    ['GET ' + BASE + '/m/requests/r/status']: { status: 200, body: { status: 'FAILED', error: 'model crashed' } },
  });
  const r = await makeDriver(http).poll({ statusUrl: `${BASE}/m/requests/r/status` });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'PROVIDER_FAILED');
  assert.match(r.errorMessage, /model crashed/);
});

// ═══ 5) poll 未知拒 + 非2xx 映射 ═══
test('poll 未知拒: 未识别状态词 → unknown(绝不当 failed)', async () => {
  const http = fakeHttp({
    ['GET ' + BASE + '/m/requests/r/status']: { status: 200, body: { status: 'WEIRD_STATE' } },
  });
  const r = await makeDriver(http).poll({ statusUrl: `${BASE}/m/requests/r/status` });
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'UNKNOWN');
});

test('poll: 404 → not_found；429 → unknown；5xx → unknown；401 → failed', async () => {
  const cases = [
    [404, 'not_found', 'NOT_FOUND'],
    [429, 'unknown', 'RATE_LIMIT'],
    [500, 'unknown', 'NETWORK_ERROR'],
    [401, 'failed', 'AUTH_ERROR'],
  ];
  for (const [code, status, errCode] of cases) {
    const http = fakeHttp({
      ['GET ' + BASE + '/m/requests/r/status']: { status: code, body: { detail: 'e' } },
    });
    const r = await makeDriver(http).poll({ statusUrl: `${BASE}/m/requests/r/status` });
    assert.equal(r.status, status, `HTTP ${code} → ${status}`);
    assert.equal(r.errorCode, errCode, `HTTP ${code} errorCode`);
  }
});

test('poll: 无 status_url/request 引用 → unknown(MISSING_REFERENCE)；网络异常 → unknown', async () => {
  const d = makeDriver(async () => ({ status: 200, body: {} }));
  const r1 = await d.poll({});
  assert.equal(r1.status, 'unknown');
  assert.equal(r1.errorCode, 'MISSING_REFERENCE');

  const dnet = makeDriver(async () => { throw new Error('ECONNRESET'); });
  const r2 = await dnet.poll({ statusUrl: `${BASE}/m/requests/r/status` });
  assert.equal(r2.status, 'unknown');
  assert.equal(r2.errorCode, 'NETWORK_ERROR');
});

// ═══ 6) fetch：files[] 归一 artifacts（role/content_type 映射）═══
test('fetch: files[] 归一 artifacts(role/content_type 映射 + 元数据透传)', async () => {
  const body = {
    files: [
      { url: 'https://cdn/x.jpg', content_type: 'image/jpeg', width: 1024, height: 768 },
      { url: 'https://cdn/x.mp4', content_type: 'video/mp4', file_size: 999, duration: 5.2 },
    ],
  };
  const http = fakeHttp({ ['GET ' + BASE + '/m/requests/r']: { status: 200, body } });
  const r = await makeDriver(http).fetch({ responseUrl: `${BASE}/m/requests/r`, requestId: 'r' });

  assert.equal(r.status, 'success');
  assert.equal(r.providerUrl, 'https://cdn/x.jpg'); // normalizeResult 取首 artifact
  assert.equal(r.providerRequestId, 'r');
  assert.deepEqual(r.artifacts, [
    { url: 'https://cdn/x.jpg', role: 'image', content_type: 'image/jpeg', width: 1024, height: 768 },
    { url: 'https://cdn/x.mp4', role: 'video', content_type: 'video/mp4', file_size: 999, duration: 5.2 },
  ]);
});

test('fetch: images/video/audio 多形归一 + URL 扩展名推断 role + 显式 role 优先', async () => {
  const body = {
    images: [{ url: 'https://cdn/a.png' }],
    video: { url: 'https://cdn/b.webm' },
    audio: { url: 'https://cdn/c.mp3', content_type: 'audio/mpeg' },
    files: [{ url: 'https://cdn/d.bin', role: 'image' }],
  };
  const http = fakeHttp({ ['GET ' + BASE + '/m/requests/r']: { status: 200, body } });
  const r = await makeDriver(http).fetch({ responseUrl: `${BASE}/m/requests/r` });

  assert.equal(r.status, 'success');
  // collectFiles 顺序：files → images → video → audio；显式 role 优先于 content_type/扩展名。
  assert.deepEqual(r.artifacts.map((a) => a.role), ['image', 'image', 'video', 'audio']);
  assert.equal(r.artifacts[0].content_type, 'image/png');   // files[0] 显式 role=image，无 content_type → 回退
  assert.equal(r.artifacts[1].content_type, 'image/png');   // .png 扩展名 → image/png
  assert.equal(r.artifacts[2].content_type, 'video/mp4');   // .webm 扩展名 → video/mp4
  assert.equal(r.artifacts[3].content_type, 'audio/mpeg');  // provider 原始 MIME 保留
  assert.equal(r.artifacts[0].role, 'image');               // 显式 role 优先
});

test('fetch: 无产物 → OUTPUT_INVALID(failed)；200 body error → PROVIDER_FAILED', async () => {
  const empty = makeDriver(fakeHttp({ ['GET ' + BASE + '/m/requests/r']: { status: 200, body: {} } }));
  const r1 = await empty.fetch({ responseUrl: `${BASE}/m/requests/r` });
  assert.equal(r1.status, 'failed');
  assert.equal(r1.errorCode, 'OUTPUT_INVALID');

  const errored = makeDriver(fakeHttp({ ['GET ' + BASE + '/m/requests/r']: { status: 200, body: { error: 'boom' } } }));
  const r2 = await errored.fetch({ responseUrl: `${BASE}/m/requests/r` });
  assert.equal(r2.status, 'failed');
  assert.equal(r2.errorCode, 'PROVIDER_FAILED');
});

// ═══ 7) cancel ═══
test('cancel: DELETE cancel_url → success/canceled', async () => {
  const http = fakeHttp({ ['DELETE ' + BASE + '/m/requests/r/cancel']: { status: 200, body: {} } });
  const r = await makeDriver(http).cancel({ cancelUrl: `${BASE}/m/requests/r/cancel` });
  assert.deepEqual(r, { status: 'success', canceled: true });
  assert.equal(http.calls[0].method, 'DELETE');
});

// ═══ 8) 三归一复用 adapter + 注册 ═══
test('mapFalStatus: fal 词表 → 规范词(未识别原样交出)', () => {
  assert.equal(mapFalStatus('IN_QUEUE'), 'queued');
  assert.equal(mapFalStatus('in_progress'), 'running');
  assert.equal(mapFalStatus('COMPLETED'), 'completed');
  assert.equal(mapFalStatus('FAILED'), 'failed');
  assert.equal(mapFalStatus('anything-else'), 'anything-else');
});

test('registerFalDriver: 以字符串 key 注册进 adapter 注册表(不改 provider-adapter.cjs)', () => {
  const d = makeDriver(async () => ({ status: 200, body: {} }));
  registerFalDriver(d);
  const { fromContract, registeredDriverKinds } = require('../provider-adapter.cjs');
  assert.ok(registeredDriverKinds().includes('fal'));
  const adapter = fromContract('p-fal', { driver_kind: 'fal' });
  assert.equal(adapter.driverKind, 'fal');
  assert.equal(typeof adapter.submit, 'function');
  assert.equal(typeof adapter.compile, 'function');
});

test('normalizeArtifacts: 纯函数暴露(直测 files 归一)', () => {
  const arts = normalizeArtifacts({ files: [{ url: 'u.mp4', content_type: 'video/mp4' }] });
  assert.deepEqual(arts, [{ url: 'u.mp4', role: 'video', content_type: 'video/mp4' }]);
  assert.equal(DEFAULT_BASE_URL, 'https://queue.fal.run');
});
