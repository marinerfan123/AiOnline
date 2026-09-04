'use strict';
/**
 * 图像 provider 路由 —— 自测硬化（server/providers/image/index.cjs）
 *
 * 覆盖（fake 上游经 ctx.fetch 注入，不打真实上游）：
 *   1. resolveKey 优先级：显式 imageAdapter（model > provider.default_endpoint）> model 名 gpt-image
 *      > base_url agnes-ai.cn > openai-compat 兜底
 *   2. 未知 provider 拒：显式 imageAdapter 未注册（含 constructor 等原型键）→ generate 返回
 *      UNKNOWN_PROVIDER（不可重试）、不发请求；缺 provider/model → UNKNOWN_PROVIDER
 *   3. adapters 注册表与模块实例一致（id/name/call）
 *   4. generate 统一返回：成功 { ok:true, result }，失败 { ok:false, code, retryable }
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const index = require('./index.cjs');

const API_KEY = 'sk-test-123456';
const P_OPENAI = { id: 'p-openai', api_key: API_KEY, base_url: 'https://api.openai.com/v1/' };
const P_AGNES = { id: 'p-agnes', api_key: API_KEY, base_url: 'https://api.agnes-ai.cn/v1/' };
const P_RELAY = { id: 'p-relay', api_key: API_KEY, base_url: 'https://relay.example.com/v1/' };
const M_GPT = { model_id: 'gpt-image-1', upstreamModelName: 'gpt-image-1' };
const M_PLAIN = { model_id: 'flux-1-dev', upstreamModelName: 'flux-1-dev' };

function makeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: ((init && init.method) || 'GET').toUpperCase() });
    const out = await responder();
    return {
      status: out.status, ok: out.status >= 200 && out.status < 300, headers: { get: () => null },
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? '')),
    };
  };
  return { impl, calls };
}

// ───────────────────────── resolveKey 优先级 ─────────────────────────
test('resolveKey: gpt-image model 名 → gpt-image；agnes base_url → agnes；其余 → openai-compat', () => {
  assert.equal(index.resolveKey(P_OPENAI, M_GPT), 'gpt-image');
  assert.equal(index.resolveKey(P_RELAY, M_GPT), 'gpt-image');       // 与 base_url 无关（模型身份优先）
  assert.equal(index.resolveKey(P_AGNES, M_PLAIN), 'agnes');
  assert.equal(index.resolveKey(P_RELAY, M_PLAIN), 'openai-compat');
  assert.equal(index.resolveKey(P_OPENAI, M_PLAIN), 'openai-compat');
});

test('resolveKey: 显式 imageAdapter（model > provider.default_endpoint）压过推断', () => {
  // model.endpoint.imageAdapter 最优先
  assert.equal(index.resolveKey(P_RELAY, { ...M_PLAIN, endpoint: { imageAdapter: 'agnes' } }), 'agnes');
  // provider.default_endpoint.imageAdapter 次优先（model 未声明时）
  assert.equal(index.resolveKey({ ...P_RELAY, default_endpoint: { imageAdapter: 'gpt-image' } }, M_PLAIN), 'gpt-image');
  // model 显式值压过 provider 显式值
  assert.equal(index.resolveKey(
    { ...P_AGNES, default_endpoint: { imageAdapter: 'gpt-image' } },
    { ...M_PLAIN, endpoint: { imageAdapter: 'openai-compat' } },
  ), 'openai-compat');
});

test('resolveKey: 未注册/原型键显式值 → null（generate 统一拒，不崩）', () => {
  assert.equal(index.resolveKey(P_RELAY, { ...M_PLAIN, endpoint: { imageAdapter: 'foo' } }), null);
  assert.equal(index.resolveKey(P_RELAY, { ...M_PLAIN, endpoint: { imageAdapter: 'constructor' } }), null);
  assert.equal(index.resolveKey(P_RELAY, { ...M_PLAIN, endpoint: { imageAdapter: '__proto__' } }), null);
  assert.equal(index.resolveKey(P_RELAY, { ...M_PLAIN, endpoint: { imageAdapter: 'toString' } }), null);
});

// ───────────────────────── 未知 provider 拒 ─────────────────────────
test('generate: 显式未注册 imageAdapter → UNKNOWN_PROVIDER（不可重试），不发请求', async () => {
  const f = makeFetch(() => ({ status: 200, body: { data: [{ url: 'x' }] } }));
  const r = await index.generate({
    apiKey: API_KEY,
    payload: { prompt: 'p', ratio: '1:1' },
    provider: { ...P_RELAY, default_endpoint: { imageAdapter: 'kling' } },
    model: M_PLAIN,
    fetch: f.impl,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_PROVIDER');
  assert.equal(r.retryable, false);
  assert.match(r.message, /未知图像服务商/);
  assert.equal(f.calls.length, 0, '未知 provider 不得发任何请求');
});

test('generate: 原型键 imageAdapter（constructor/__proto__）→ UNKNOWN_PROVIDER 不崩', async () => {
  for (const evil of ['constructor', '__proto__', 'hasOwnProperty']) {
    const r = await index.generate({
      apiKey: API_KEY,
      payload: { prompt: 'p' },
      provider: { ...P_RELAY, default_endpoint: { imageAdapter: evil } },
      model: M_PLAIN,
    });
    assert.equal(r.ok, false, `evil=${evil}`);
    assert.equal(r.code, 'UNKNOWN_PROVIDER');
    assert.equal(r.retryable, false);
  }
});

test('generate: 缺 provider/model 配置 → UNKNOWN_PROVIDER', async () => {
  const r1 = await index.generate({ apiKey: API_KEY, payload: { prompt: 'p' }, model: M_PLAIN });
  assert.equal(r1.code, 'UNKNOWN_PROVIDER');
  const r2 = await index.generate({ apiKey: API_KEY, payload: { prompt: 'p' }, provider: P_RELAY });
  assert.equal(r2.code, 'UNKNOWN_PROVIDER');
});

// ───────────────────────── 统一返回 + 路由分派 ─────────────────────────
test('generate: 路由到各适配器并透传归一返回（openai-compat / agnes / gpt-image）', async () => {
  // openai-compat 兜底
  let f = makeFetch(() => ({ status: 200, body: { data: [{ url: 'https://cdn/o.png' }] } }));
  let r = await index.generate({ apiKey: API_KEY, payload: { prompt: 'p', ratio: '16:9', resolution: '1k' }, provider: P_RELAY, model: M_PLAIN, fetch: f.impl });
  assert.deepEqual(r, { ok: true, result: { images: ['https://cdn/o.png'] } });
  assert.equal(f.calls[0].url, 'https://relay.example.com/v1/images/generations');

  // agnes（base_url 推断）→ 请求体走 agnes 档位尺寸
  f = makeFetch(() => ({ status: 200, body: { data: [{ url: 'https://cdn/a.png' }] } }));
  r = await index.generate({ apiKey: API_KEY, payload: { prompt: 'p', ratio: '16:9', resolution: '2k' }, provider: P_AGNES, model: M_PLAIN, fetch: f.impl });
  assert.equal(r.ok, true);
  assert.match(f.calls[0].url, /^https:\/\/api\.agnes-ai\.cn\/v1\/images\/generations$/);

  // gpt-image（model 名推断）
  f = makeFetch(() => ({ status: 200, body: { data: [{ url: 'https://cdn/g.png' }] } }));
  r = await index.generate({ apiKey: API_KEY, payload: { prompt: 'p', ratio: '16:9' }, provider: P_OPENAI, model: M_GPT, fetch: f.impl });
  assert.equal(r.ok, true);
  assert.match(f.calls[0].url, /^https:\/\/api\.openai\.com\/v1\/images\/generations$/);
});

test('generate: 上游错误统一为 { ok:false, code, retryable }（经 agnes 路由）', async () => {
  const f = makeFetch(() => ({ status: 429, body: { error: { message: 'limit' } } }));
  const r = await index.generate({ apiKey: API_KEY, payload: { prompt: 'p' }, provider: P_AGNES, model: M_PLAIN, fetch: f.impl });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RATE_LIMITED');
  assert.equal(r.retryable, true);
});

test('adapters: 注册表 = 三模块实例，各含 id/name/call', () => {
  const keys = Object.keys(index.adapters).sort();
  assert.deepEqual(keys, ['agnes', 'gpt-image', 'openai-compat']);
  for (const ad of Object.values(index.adapters)) {
    assert.equal(typeof ad.id, 'string');
    assert.equal(typeof ad.name, 'string');
    assert.equal(typeof ad.call, 'function');
  }
  // 与模块实例一致（引用级）
  assert.equal(index.adapters['gpt-image'], require('./gpt-image.cjs'));
  assert.equal(index.adapters.agnes, require('./agnes.cjs'));
  assert.equal(index.adapters['openai-compat'], require('./openai-compat.cjs'));
});
