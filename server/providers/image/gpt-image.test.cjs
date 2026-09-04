'use strict';
/**
 * gpt-image 适配器 —— 自测硬化（server/providers/image/gpt-image.cjs）
 *
 * 覆盖（fake 上游经 ctx.fetch 注入，不打真实上游）：
 *   1. buildVars 线格式：GPT-Image 尺寸枚举（16:9→1536x1024 / 未知比例→auto）、n 夹取、
 *      不发送 ratio/resolution/negative_prompt；upstreamModelName 缺失回退 model_id
 *   2. 图生图：顶层 images；extra_body.image 默认规则（base_url 为 agnes 时开 / 显式 img2imgInExtraBody 可关）
 *   3. 鉴权头：Authorization: Bearer、Content-Type: application/json、URL 尾斜杠剥除、方法 POST
 *   4. 上游非 2xx 归一：401→UNAUTHORIZED(不可重试)、429→RATE_LIMITED(可重试)+Retry-After、
 *      500→UPSTREAM(可重试)、400→BAD_REQUEST(不可重试)
 *   5. 成功归一：url 直通、b64_json → data URI
 *   6. 超时：挂起上游 + ctx.timeoutMs → TIMEOUT(可重试)，不向上抛
 *   7. 网络错：fetch 抛错 → NETWORK(可重试)，不向上抛
 *   8. 缺 key 拒（不发请求）；200 但无图片字段 → EMPTY_RESPONSE(不可重试)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const gpt = require('./gpt-image.cjs');

const API_KEY = 'sk-test-123456';
const PROVIDER = { id: 'p-openai', api_key: API_KEY, base_url: 'https://api.openai.com/v1/' };
const MODEL = { model_id: 'gpt-image-1', upstreamModelName: 'gpt-image-1' };
const URL = 'https://api.openai.com/v1/images/generations';

// ── fake fetch：记录 (url, method, headers, body)，返回 canned 响应（支持 headers/retry-after）──
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
    payload: { prompt: '一只猫', ratio: '16:9', resolution: '1k', count: 1 },
    provider: PROVIDER, model: MODEL, timeoutMs: 2000,
    ...(over || {}),
  };
}

// ───────────────────────── 请求体形状（纯 buildVars）─────────────────────────
test('gpt-image buildVars: GPT 尺寸枚举 + n 夹取 + 不发送 ratio/resolution/negative', () => {
  const v = gpt.buildVars({ prompt: 'p', ratio: '16:9', resolution: '2k', count: 9, negative: '模糊' }, MODEL, PROVIDER);
  assert.equal(v.model, 'gpt-image-1');
  assert.equal(v.prompt, 'p');
  assert.equal(v.n, 4);                 // count 9 → clamp 4
  assert.equal(v.size, '1536x1024');    // 16:9
  assert.ok(!('ratio' in v), 'GPT-Image 官方端点不识别 ratio');
  assert.ok(!('resolution' in v), 'GPT-Image 官方端点不识别 resolution');
  assert.ok(!('negative_prompt' in v), 'GPT-Image 官方端点不识别 negative_prompt');
});

test('gpt-image buildVars: 未知比例 → auto；1:1/9:16 枚举；model 回退 model_id', () => {
  assert.equal(gpt.buildVars({ prompt: 'p', ratio: '3:2' }, MODEL, PROVIDER).size, 'auto');
  assert.equal(gpt.buildVars({ prompt: 'p', ratio: '1:1' }, MODEL, PROVIDER).size, '1024x1024');
  assert.equal(gpt.buildVars({ prompt: 'p', ratio: '9:16' }, MODEL, PROVIDER).size, '1024x1536');
  assert.equal(gpt.buildVars({ prompt: 'p' }, { model_id: 'gpt-image-1.5' }, PROVIDER).model, 'gpt-image-1.5');
});

test('gpt-image buildVars: 图生图顶层 images + extra_body 默认规则（agnes base 开 / 显式可关）', () => {
  const refs = ['https://img/a.jpg', 'https://img/b.jpg'];
  // 默认（openai base_url）→ 仅顶层 images
  const v1 = gpt.buildVars({ prompt: 'p', referenceImages: refs }, MODEL, PROVIDER);
  assert.deepEqual(v1.images, refs);
  assert.ok(!('extra_body' in v1));
  // base_url 是 agnes relay → 默认附 extra_body.image（dispatcher：img2imgInExtraBody 默认 = isAgnes）
  const v2 = gpt.buildVars({ prompt: 'p', referenceImages: refs }, MODEL,
    { base_url: 'https://api.agnes-ai.cn/v1' });
  assert.deepEqual(v2.extra_body, { image: refs, response_format: 'url' });
  // 显式 img2imgInExtraBody:false 覆盖（即使是 agnes base）
  const v3 = gpt.buildVars({ prompt: 'p', referenceImages: refs }, { ...MODEL, endpoint: { img2imgInExtraBody: false } },
    { base_url: 'https://api.agnes-ai.cn/v1' });
  assert.ok(!('extra_body' in v3));
});

// ───────────────────────── call：成功路径 + 鉴权 ─────────────────────────
test('gpt-image call: URL/方法/鉴权头/请求体 逐字段 + ok result（url 直通）', async () => {
  const f = makeFetch(respond(200, { data: [{ url: 'https://cdn/x.png', revised_prompt: 'r' }] }));
  const r = await gpt.call(ctx({ fetch: f.impl }));
  assert.equal(f.calls.length, 1);
  const c = f.last();
  assert.equal(c.url, URL);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
  assert.deepEqual(c.body, gpt.buildVars(ctx().payload, MODEL, PROVIDER));
  assert.deepEqual(r, { ok: true, result: { images: ['https://cdn/x.png'] } });
});

test('gpt-image call: b64_json → data URI；多张保序', async () => {
  const f = makeFetch(respond(200, { data: [{ b64_json: 'AAAA' }, { url: 'https://cdn/2.png' }] }));
  const r = await gpt.call(ctx({ fetch: f.impl }));
  assert.deepEqual(r, { ok: true, result: { images: ['data:image/png;base64,AAAA', 'https://cdn/2.png'] } });
});

// ───────────────────────── 非 2xx 归一 ─────────────────────────
test('gpt-image call: 非 2xx 归一（401/400 不可重试；429/500 可重试 + Retry-After）', async () => {
  const cases = [
    { status: 401, body: { error: { message: 'Invalid API key' } }, code: 'UNAUTHORIZED', retryable: false },
    { status: 400, body: { error: { message: 'bad size' } }, code: 'BAD_REQUEST', retryable: false },
    { status: 429, body: { error: { message: 'rate limited' } }, code: 'RATE_LIMITED', retryable: true, headers: { 'retry-after': '2' } },
    { status: 500, body: { error: { message: 'boom' } }, code: 'UPSTREAM', retryable: true },
  ];
  for (const tc of cases) {
    const f = makeFetch(respond(tc.status, tc.body, tc.headers));
    const r = await gpt.call(ctx({ fetch: f.impl }));
    assert.equal(r.ok, false, `status=${tc.status}`);
    assert.equal(r.code, tc.code, `status=${tc.status}`);
    assert.equal(r.retryable, tc.retryable, `status=${tc.status}`);
    assert.equal(r.httpStatus, tc.status);
    if (tc.status === 429) assert.equal(r.retryAfterMs, 2000); // retry-after: 2s → 2000ms
  }
});

// ───────────────────────── 超时 / 网络错 ─────────────────────────
test('gpt-image call: 超时 → { ok:false, code:TIMEOUT, retryable:true }（不向上抛）', async () => {
  const t0 = Date.now();
  const hang = async (_url, init) => new Promise((_, reject) => {
    if (!init || !init.signal) return; // 永不 resolve
    const onAb = () => {
      init.signal.removeEventListener('abort', onAb);
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    };
    if (init.signal.aborted) return onAb();
    init.signal.addEventListener('abort', onAb);
  });
  const r = await gpt.call(ctx({ timeoutMs: 60, fetch: hang }));
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIMEOUT');
  assert.equal(r.retryable, true);
  assert.match(r.message, /图片生成超时/);
  assert.ok(elapsed < 3000, `超时应 ~60ms 触发，实际 ${elapsed}ms`);
});

test('gpt-image call: fetch 网络错 → { ok:false, code:NETWORK, retryable:true }', async () => {
  const r = await gpt.call(ctx({ fetch: failWith(new Error('fetch failed: ECONNREFUSED')) }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NETWORK');
  assert.equal(r.retryable, true);
});

// ───────────────────────── 缺参 / 空响应 ─────────────────────────
test('gpt-image call: 缺 API Key → NO_API_KEY 且不发请求', async () => {
  const f = makeFetch(respond(200, { data: [{ url: 'https://cdn/x.png' }] }));
  const r = await gpt.call(ctx({ apiKey: '', provider: { ...PROVIDER, api_key: '' }, fetch: f.impl }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_API_KEY');
  assert.equal(r.retryable, false);
  assert.equal(f.calls.length, 0);
});

test('gpt-image call: 200 但无图片字段 → EMPTY_RESPONSE（不可重试）', async () => {
  const f = makeFetch(respond(200, { data: [] }));
  const r = await gpt.call(ctx({ fetch: f.impl }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EMPTY_RESPONSE');
  assert.equal(r.retryable, false);
  assert.equal(r.message, '响应中无图片数据');
});

test('gpt-image: 适配器导出 id/name/call（契约形状）', () => {
  assert.equal(gpt.id, 'gpt-image');
  assert.equal(typeof gpt.name, 'string');
  assert.equal(typeof gpt.call, 'function');
});
