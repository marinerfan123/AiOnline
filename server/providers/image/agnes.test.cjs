'use strict';
/**
 * agnes 图像适配器 —— 自测硬化（server/providers/image/agnes.cjs）
 *
 * 覆盖（fake 上游经 ctx.fetch 注入，不打真实上游）：
 *   1. buildVars 线格式：size = 分辨率档位字符串（'2k'→'2K'）、ratio 发送、resolution/negative_prompt
 *      不发送；n 夹取；upstreamModelName 缺失回退 model_id
 *   2. sizeFormat 显式 'openai' 覆盖：走 openai 尺寸表（ratio+resolution 倍增）并恢复发送
 *      resolution/negative_prompt（dispatcher 语义一致）
 *   3. 图生图：顶层 images + extra_body.image（agnes 默认开启）
 *   4. call：URL/方法/鉴权头/请求体 逐字段 + ok result
 *   5. 非 2xx 归一（401/429/500）；超时 TIMEOUT；网络错 NETWORK；缺 key 拒；空响应 EMPTY_RESPONSE
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const agnes = require('./agnes.cjs');

const API_KEY = 'sk-test-123456';
const PROVIDER = { id: 'p-agnes', api_key: API_KEY, base_url: 'https://api.agnes-ai.cn/v1/' };
const MODEL = { model_id: 'agnes-image-2.1-flash', upstreamModelName: 'agnes-image-2.1-flash' };
const URL = 'https://api.agnes-ai.cn/v1/images/generations';

function makeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    const rec = {
      url: String(url),
      method: ((init && init.method) || 'GET').toUpperCase(),
      headers: (init && init.headers) || {},
      body: init && init.body != null ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(rec);
    const out = await responder(rec);
    const map = {};
    for (const [k, v] of Object.entries(out.headers || {})) map[k.toLowerCase()] = v;
    const headers = { get: (k) => (k ? map[k.toLowerCase()] ?? null : null) };
    return {
      status: out.status, ok: out.status >= 200 && out.status < 300, headers,
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? '')),
    };
  };
  return { impl, calls, last: () => calls[calls.length - 1] };
}
const respond = (status, body, headers) => async () => ({ status, body, headers });
const failWith = (err) => async () => { throw err; };
function ctx(over) {
  return {
    apiKey: API_KEY,
    payload: { prompt: '赛博朋克街道', ratio: '16:9', resolution: '2k', count: 1 },
    provider: PROVIDER, model: MODEL, timeoutMs: 2000,
    ...(over || {}),
  };
}

// ───────────────────────── 请求体形状（纯 buildVars）─────────────────────────
test('agnes buildVars: size 档位字符串 + ratio 发送 + 不发 resolution/negative_prompt', () => {
  const v = agnes.buildVars({ prompt: 'p', ratio: '16:9', resolution: '2k', count: 9, negative: '模糊' }, MODEL, PROVIDER);
  assert.equal(v.model, 'agnes-image-2.1-flash');
  assert.equal(v.prompt, 'p');
  assert.equal(v.n, 4);                 // count 9 → clamp 4
  assert.equal(v.size, '2K');           // agnes：分辨率档位字符串（大写）
  assert.equal(v.ratio, '16:9');
  assert.ok(!('resolution' in v), 'agnes 风格不发送 resolution（规范无此字段）');
  assert.ok(!('negative_prompt' in v), 'agnes 风格不发送 negative_prompt（严格校验会拒）');
});

test('agnes buildVars: resolution 缺省 → 1K；model 回退 model_id', () => {
  assert.equal(agnes.buildVars({ prompt: 'p' }, MODEL, PROVIDER).size, '1K');
  assert.equal(agnes.buildVars({ prompt: 'p' }, { model_id: 'agnes-image-x' }, PROVIDER).model, 'agnes-image-x');
});

test('agnes buildVars: sizeFormat 显式 openai 覆盖 → openai 尺寸表 + 恢复 resolution/negative_prompt', () => {
  const prov = { ...PROVIDER, default_endpoint: { sizeFormat: 'openai' } };
  const v = agnes.buildVars({ prompt: 'p', ratio: '16:9', resolution: '2k', negative: '模糊' }, MODEL, prov);
  assert.equal(v.size, '3584x2048');    // 1792x1024 × 2（2k）
  assert.equal(v.resolution, '2k');
  assert.equal(v.negative_prompt, '模糊');
});

test('agnes buildVars: 图生图 → 顶层 images + extra_body.image（agnes 默认）', () => {
  const refs = ['https://img/a.jpg', 'https://img/b.jpg'];
  const v = agnes.buildVars({ prompt: 'p', referenceImages: refs }, MODEL, PROVIDER);
  assert.deepEqual(v.images, refs);
  assert.deepEqual(v.extra_body, { image: refs, response_format: 'url' });
});

// ───────────────────────── call：成功路径 + 鉴权 ─────────────────────────
test('agnes call: URL/方法/鉴权头/请求体 逐字段 + ok result', async () => {
  const f = makeFetch(respond(200, { data: [{ url: 'https://cdn.agnes-ai.cn/1.png' }] }));
  const r = await agnes.call(ctx({ fetch: f.impl }));
  assert.equal(f.calls.length, 1);
  const c = f.last();
  assert.equal(c.url, URL);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
  assert.deepEqual(c.body, agnes.buildVars(ctx().payload, MODEL, PROVIDER));
  assert.deepEqual(r, { ok: true, result: { images: ['https://cdn.agnes-ai.cn/1.png'] } });
});

// ───────────────────────── 非 2xx / 超时 / 网络 ─────────────────────────
test('agnes call: 非 2xx 归一（401 不可重试 / 429 / 500 可重试）', async () => {
  const f401 = makeFetch(respond(401, { message: 'unauthorized' }));
  const r401 = await agnes.call(ctx({ fetch: f401.impl }));
  assert.deepEqual({ ok: r401.ok, code: r401.code, retryable: r401.retryable }, { ok: false, code: 'UNAUTHORIZED', retryable: false });

  const f429 = makeFetch(respond(429, { message: 'slow down' }, { 'x-ratelimit-reset': '1' }));
  const r429 = await agnes.call(ctx({ fetch: f429.impl }));
  assert.equal(r429.code, 'RATE_LIMITED');
  assert.equal(r429.retryable, true);
  assert.equal(r429.retryAfterMs, 1000); // x-ratelimit-reset: 1s

  const f500 = makeFetch(respond(500, { message: 'oops' }));
  const r500 = await agnes.call(ctx({ fetch: f500.impl }));
  assert.equal(r500.code, 'UPSTREAM');
  assert.equal(r500.retryable, true);
});

test('agnes call: 超时 → TIMEOUT(可重试)；网络错 → NETWORK(可重试)', async () => {
  const hang = async (_url, init) => new Promise((_, reject) => {
    if (!init || !init.signal) return;
    const onAb = () => {
      init.signal.removeEventListener('abort', onAb);
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    };
    if (init.signal.aborted) return onAb();
    init.signal.addEventListener('abort', onAb);
  });
  const rT = await agnes.call(ctx({ timeoutMs: 60, fetch: hang }));
  assert.equal(rT.ok, false);
  assert.equal(rT.code, 'TIMEOUT');
  assert.equal(rT.retryable, true);

  const rN = await agnes.call(ctx({ fetch: failWith(new Error('socket hang up')) }));
  assert.equal(rN.code, 'NETWORK');
  assert.equal(rN.retryable, true);
});

test('agnes call: 缺 key → NO_API_KEY 不发请求；200 无图 → EMPTY_RESPONSE', async () => {
  const f0 = makeFetch(respond(200, { data: [{ url: 'x' }] }));
  const r0 = await agnes.call(ctx({ apiKey: '', provider: { ...PROVIDER, api_key: '' }, fetch: f0.impl }));
  assert.equal(r0.code, 'NO_API_KEY');
  assert.equal(r0.retryable, false);
  assert.equal(f0.calls.length, 0);

  const f1 = makeFetch(respond(200, { data: [] }));
  const r1 = await agnes.call(ctx({ fetch: f1.impl }));
  assert.equal(r1.code, 'EMPTY_RESPONSE');
  assert.equal(r1.retryable, false);
  assert.equal(r1.message, '响应中无图片数据');
});

test('agnes: 适配器导出 id/name/call（契约形状）', () => {
  assert.equal(agnes.id, 'agnes');
  assert.equal(typeof agnes.name, 'string');
  assert.equal(typeof agnes.call, 'function');
  assert.equal(typeof agnes.buildVars, 'function');
});
