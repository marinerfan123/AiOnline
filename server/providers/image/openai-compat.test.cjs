'use strict';
/**
 * openai-compat 适配器 —— 自测硬化（server/providers/image/openai-compat.cjs）
 *
 * 覆盖（fake 上游经 ctx.fetch 注入，不打真实上游）：
 *   1. buildVars 线格式（默认 openai 风格）：ratio→size 表 + resolution 倍增、ratio/resolution/
 *      negative_prompt 发送、n 夹取（count 0→1）、negative 缺省不发该字段
 *   2. sizeFormat 显式 'agnes' 覆盖：size 档位字符串、不发 resolution/negative_prompt
 *   3. call 标准路径：URL/鉴权头/请求体 + ok result
 *   4. custom protocol：配置端点 path/method/imageFieldPath → 走 custom 传输（bodyTemplate 占位替换 /
 *      GET query / imageFieldPath 提取 / 非 2xx 归一 / 空响应），顶层 images 字段语义
 *   5. 超时 TIMEOUT、网络错 NETWORK、缺 key 拒、空响应 EMPTY_RESPONSE
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const oc = require('./openai-compat.cjs');

const API_KEY = 'sk-test-123456';
const PROVIDER = { id: 'p-relay', api_key: API_KEY, base_url: 'https://relay.example.com/v1/' };
const MODEL = { model_id: 'flux-1-dev', upstreamModelName: 'flux-1-dev' };
const URL = 'https://relay.example.com/v1/images/generations';

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
    payload: { prompt: '水墨山河', ratio: '16:9', resolution: '2k', count: 1 },
    provider: PROVIDER, model: MODEL, timeoutMs: 2000,
    ...(over || {}),
  };
}

// ───────────────────────── 请求体形状（纯 buildVars，openai 风格）─────────────────────────
test('openai-compat buildVars: ratio→size + resolution 倍增 + ratio/resolution/negative_prompt 发送', () => {
  const v = oc.buildVars({ prompt: 'p', ratio: '16:9', resolution: '2k', count: 1, negative: '模糊' }, MODEL, PROVIDER);
  assert.equal(v.model, 'flux-1-dev');
  assert.equal(v.prompt, 'p');
  assert.equal(v.n, 1);
  assert.equal(v.size, '3584x2048');    // 1792x1024 × 2（2k）
  assert.equal(v.ratio, '16:9');
  assert.equal(v.resolution, '2k');
  assert.equal(v.negative_prompt, '模糊');
});

test('openai-compat buildVars: 各比例枚举 + n 夹取（0→1, 9→4）+ negative 缺省不发字段', () => {
  const cases = [
    ['16:9', '1792x1024'], ['4:3', '1024x768'], ['1:1', '1024x1024'],
    ['3:4', '768x1024'], ['9:16', '1024x1792'], ['2:1', '1024x1024'], // 未知比例回退默认
  ];
  for (const [ratio, size] of cases) {
    assert.equal(oc.buildVars({ prompt: 'p', ratio, resolution: '1k' }, MODEL, PROVIDER).size, size, `ratio=${ratio}`);
  }
  assert.equal(oc.buildVars({ prompt: 'p', count: 0 }, MODEL, PROVIDER).n, 1);
  assert.equal(oc.buildVars({ prompt: 'p', count: 9 }, MODEL, PROVIDER).n, 4);
  const v = oc.buildVars({ prompt: 'p', negative: undefined }, MODEL, PROVIDER);
  assert.ok(!('negative_prompt' in v), 'negative 缺省时不发送该字段');
});

test('openai-compat buildVars: sizeFormat 显式 agnes 覆盖 → 档位字符串 + 不发 resolution/negative_prompt', () => {
  const prov = { ...PROVIDER, default_endpoint: { sizeFormat: 'agnes' } };
  const v = oc.buildVars({ prompt: 'p', ratio: '16:9', resolution: '4k', negative: '模糊' }, MODEL, prov);
  assert.equal(v.size, '4K');
  assert.equal(v.ratio, '16:9');
  assert.ok(!('resolution' in v));
  assert.ok(!('negative_prompt' in v));
});

// ───────────────────────── call：标准路径成功 + 鉴权 ─────────────────────────
test('openai-compat call: URL/方法/鉴权头/请求体 + ok result（标准 images/generations）', async () => {
  const f = makeFetch(respond(200, { data: [{ url: 'https://cdn/1.png' }] }));
  const r = await oc.call(ctx({ fetch: f.impl }));
  assert.equal(f.calls.length, 1);
  const c = f.last();
  assert.equal(c.url, URL);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
  assert.deepEqual(c.body, oc.buildVars(ctx().payload, MODEL, PROVIDER));
  assert.deepEqual(r, { ok: true, result: { images: ['https://cdn/1.png'] } });
});

// ───────────────────────── custom protocol 端点 ─────────────────────────
test('openai-compat call(custom): 配置端点 path/imageFieldPath → custom 传输 + ok', async () => {
  const prov = { ...PROVIDER, protocol: 'custom', default_endpoint: { protocol: 'custom', generate: { path: '/api/my-generate', method: 'POST', imageFieldPath: 'url' } } };
  const f = makeFetch(respond(200, { url: 'https://cdn.custom/1.png' }));
  const r = await oc.call(ctx({ provider: prov, fetch: f.impl }));
  const c = f.last();
  assert.equal(c.url, 'https://relay.example.com/v1/api/my-generate'); // 不走 images/generations
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
  assert.deepEqual(c.body, oc.buildVars(ctx().payload, MODEL, prov)); // 请求体同 openai 线格式
  assert.deepEqual(r, { ok: true, result: { images: ['https://cdn.custom/1.png'] } });
});

test('openai-compat call(custom): bodyTemplate 占位替换 + 数组路径提取', async () => {
  const prov = { ...PROVIDER, protocol: 'custom' };
  const model = { model_id: 'flux-1-dev' };
  const endpoint = {
    path: '/v1/custom',
    method: 'POST',
    bodyTemplate: '{"model":{{model}},"prompt":{{prompt}},"n":{{n}}}',
    headers: { 'X-Custom': '1' },
    imageFieldPath: 'data.0.url',
  };
  const f = makeFetch(respond(200, { data: [{ url: 'https://cdn/arr.png' }] }));
  const r = await oc.call(ctx({ provider: { ...prov, default_endpoint: { protocol: 'custom', generate: endpoint } }, model, fetch: f.impl }));
  const c = f.last();
  assert.equal(c.headers['X-Custom'], '1');
  assert.deepEqual(c.body, { model: 'flux-1-dev', prompt: '水墨山河', n: 1 }); // 占位替换 JSON（vars 走线格式键 n）
  assert.deepEqual(r, { ok: true, result: { images: ['https://cdn/arr.png'] } });
});

test('openai-compat call(custom): 非 2xx 归一 + 空响应（imageFieldPath 未命中）', async () => {
  const prov = { ...PROVIDER, protocol: 'custom', default_endpoint: { protocol: 'custom', generate: { path: '/api/gen', imageFieldPath: 'url' } } };
  const f400 = makeFetch(respond(400, { message: 'bad request' }));
  const r400 = await oc.call(ctx({ provider: prov, fetch: f400.impl }));
  assert.equal(r400.code, 'BAD_REQUEST');
  assert.equal(r400.retryable, false);
  assert.equal(r400.message, 'bad request');

  const fEmp = makeFetch(respond(200, { nope: 1 }));
  const rEmp = await oc.call(ctx({ provider: prov, fetch: fEmp.impl }));
  assert.equal(rEmp.code, 'EMPTY_RESPONSE');
  assert.equal(rEmp.retryable, false);
  assert.equal(rEmp.message, '响应中未找到图片字段');
});

test('openai-compat call(custom): GET 端点 vars → query 串', async () => {
  const prov = { ...PROVIDER, protocol: 'custom', default_endpoint: { protocol: 'custom', generate: { path: '/gen', method: 'GET', imageFieldPath: 'url' } } };
  const f = makeFetch(respond(200, { url: 'https://cdn/q.png' }));
  const r = await oc.call(ctx({ provider: prov, fetch: f.impl }));
  const c = f.last();
  assert.equal(c.method, 'GET');
  assert.match(c.url, /^https:\/\/relay\.example\.com\/v1\/gen\?/);
  assert.match(c.url, /model=flux-1-dev/);
  assert.match(c.url, /prompt=/);
  assert.ok(c.body === undefined, 'GET 无请求体');
  assert.deepEqual(r, { ok: true, result: { images: ['https://cdn/q.png'] } });
});

// ───────────────────────── 超时 / 网络 / 缺参 / 空响应 ─────────────────────────
test('openai-compat call: 超时 → TIMEOUT(可重试)；网络错 → NETWORK(可重试)', async () => {
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
  const rT = await oc.call(ctx({ timeoutMs: 60, fetch: hang }));
  assert.equal(rT.ok, false);
  assert.equal(rT.code, 'TIMEOUT');
  assert.equal(rT.retryable, true);

  const rN = await oc.call(ctx({ fetch: failWith(new Error('fetch failed')) }));
  assert.equal(rN.code, 'NETWORK');
  assert.equal(rN.retryable, true);
});

test('openai-compat call: 缺 key → NO_API_KEY 不发请求；200 无图 → EMPTY_RESPONSE', async () => {
  const f0 = makeFetch(respond(200, { data: [{ url: 'x' }] }));
  const r0 = await oc.call(ctx({ apiKey: '', provider: { ...PROVIDER, api_key: '' }, fetch: f0.impl }));
  assert.equal(r0.code, 'NO_API_KEY');
  assert.equal(f0.calls.length, 0);

  const f1 = makeFetch(respond(200, { foo: 'bar' }));
  const r1 = await oc.call(ctx({ fetch: f1.impl }));
  assert.equal(r1.code, 'EMPTY_RESPONSE');
  assert.equal(r1.retryable, false);
});

test('openai-compat: 适配器导出 id/name/call/buildVars（契约形状）', () => {
  assert.equal(oc.id, 'openai-compat');
  assert.equal(typeof oc.name, 'string');
  assert.equal(typeof oc.call, 'function');
  assert.equal(typeof oc.buildVars, 'function');
});
