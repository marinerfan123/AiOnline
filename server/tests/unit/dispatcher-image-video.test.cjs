'use strict';
// dispatcher 执行面单元测试（G10 波 dispatcher-image-video 叶）
// 覆盖（全部注入 fake 上游 / fake client，零网络、零 DB）：
//   1. dispatchOne：provider 选择（权重 best-first 顺序）、冷却跳过、429 冷却后切换、全冷 → throttled
//   2. attemptOnAccount：图片成功归一（attribution 字段）、冷账号 null 不触网、429 → null + 账号冷却
//   3. imageGenerate：成功提取 / 非 2xx 归一（makeError 形状）/ 429 rateLimited + retryAfterMs / 缺 key / custom 端点
//   4. videoGenerate：videoRouter 适配层分支（fake submit/poll）+ generic 内联 async submit+poll 分支
//   5. completeViaQueue：image 成功 → enqueueFinalize 幂等键链（billing ik / accounting ik:pid:mid / enqueue 一次）
// 注：image 上游模块（server/providers/image）由他叶构建、dispatcher 尚未接线 —— 本叶不接线，
//     用注入 fake 上游测 dispatcher 自身分支；image→providers/image 接线待 L1。
const test = require('node:test');
const assert = require('node:assert');
const dispatcher = require('../../dispatcher.cjs');
const videoIndex = require('../../providers/video/index.cjs');
const imageIndex = require('../../providers/image/index.cjs');
const uploadQueue = require('../../uploadQueue.cjs');
const billingMod = require('../../billing.cjs');
const accountingMod = require('../../accounting.cjs');

const ORIG_FETCH = globalThis.fetch;

function makePair(pid, modelOver = {}, providerOver = {}) {
  return {
    bindingId: providerOver.bindingId || `b-${pid}`,
    model: Object.assign(
      {
        model_id: `m-${pid}`, enabled: true, type: 'image',
        capabilities: {}, bindingWeight: 0, upstreamModelName: `wire-${pid}`,
      },
      modelOver,
    ),
    provider: Object.assign(
      {
        id: pid, enabled: true, api_key: 'sk-test-abcdef-123456',
        base_url: `https://${pid}.example.com/v1`, max_concurrent: 2,
      },
      providerOver,
    ),
  };
}

// ─── fake fetch 工具 ──────────────────────────────
function fakeRes(status, body, headers) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body == null ? '' : body)),
    headers: {
      get(k) {
        const m = headers || {};
        const v = m[k.toLowerCase()] != null ? m[k.toLowerCase()] : m[k];
        return v == null ? null : String(v);
      },
    },
  };
}

// urlMatcher 可为函数 url=>{status,body,headers} 或抛错（模拟网络异常）
// 返回 { calls, result } —— calls = 实际发出的请求日志
async function withFetch(matcher, fn) {
  const calls = [];
  const stub = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const out = typeof matcher === 'function' ? await matcher(String(url), init || {}) : matcher;
    if (out && out.throw) throw out.throw;
    return fakeRes(out.status, out.body, out.headers);
  };
  globalThis.fetch = stub;
  try {
    const result = await fn(calls);
    return { calls, result };
  } finally {
    globalThis.fetch = ORIG_FETCH;
  }
}

const IMG_OK = (url = 'https://cdn.example.com/a.png') => ({
  status: 200,
  body: { data: [{ url }] },
});

const IMG_401 = { status: 401, body: { error: { message: 'bad key' } } };
const IMG_429 = { status: 429, body: { error: { message: 'rate limited' } }, headers: { 'retry-after': '2' } };

function imageInput(over = {}) {
  return Object.assign(
    { prompt: '一只猫', ratio: '1:1', resolution: '1k', count: 1, referenceImages: [], negative: '' },
    over,
  );
}

// ─── 1) dispatchOne ───────────────────────────────
test('dispatchOne: 权重 best-first —— 高分 provider 优先被选择并成功', async () => {
  const pA = makePair('sel_a', { bindingWeight: 1.0 }, { base_url: 'https://sel_a.example.com/v1' });
  const pB = makePair('sel_b', { bindingWeight: 0.0 }, { base_url: 'https://sel_b.example.com/v1' });
  const { calls, result: r } = await withFetch((url) => {
    if (url.includes('sel_a.example.com')) return IMG_OK('https://cdn/sel_a.png');
    return IMG_401; // B 不应被触达
  }, async () => dispatcher.dispatchOne([pA, pB], '1k', imageInput(), 'image', null, null));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.providerId, 'sel_a');
  assert.deepStrictEqual(r.images, ['https://cdn/sel_a.png']);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes('sel_a.example.com'));
});

test('dispatchOne: 首选 provider 401（非瞬错）→ 归一失败后切换下一 provider 成功', async () => {
  const pA = makePair('fb_a', { bindingWeight: 1.0 }, { base_url: 'https://fb_a.example.com/v1' });
  const pB = makePair('fb_b', { bindingWeight: 0.0 }, { base_url: 'https://fb_b.example.com/v1' });
  const { calls, result: r } = await withFetch((url) => {
    if (url.includes('fb_a.example.com')) return IMG_401;
    if (url.includes('fb_b.example.com')) return IMG_OK('https://cdn/fb_b.png');
    return IMG_401;
  }, async () => dispatcher.dispatchOne([pA, pB], '1k', imageInput(), 'image', null, null));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.providerId, 'fb_b');
  assert.deepStrictEqual(r.images, ['https://cdn/fb_b.png']);
  // A 被尝试一次（401 归一失败），B 成功
  assert.strictEqual(calls.length, 2);
});

test('dispatchOne: provider 429 → 冷却该账号并切换；再触发全冷则 throttled', async () => {
  const pA = makePair('rl_a', { bindingWeight: 1.0 }, { base_url: 'https://rl_a.example.com/v1' });
  const pB = makePair('rl_b', { bindingWeight: 0.0 }, { base_url: 'https://rl_b.example.com/v1' });
  const { calls, result: r } = await withFetch((url) => {
    if (url.includes('rl_a.example.com')) return IMG_429;
    if (url.includes('rl_b.example.com')) return IMG_OK('https://cdn/rl_b.png');
    return IMG_401;
  }, async () => dispatcher.dispatchOne([pA, pB], '1k', imageInput(), 'image', null, null));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.providerId, 'rl_b'); // 429 后切换成功
  // 429 provider 已进入整账号冷却
  const acct = dispatcher.getAcct('rl_a', pA.provider);
  assert.ok(acct.cooldownUntil > Date.now());
  assert.strictEqual(calls.length, 2);
});

test('dispatchOne: 冷却账号跳过 —— 冷却中的高权重 provider 不被触达，切到可用 provider', async () => {
  const pA = makePair('cold_a', { bindingWeight: 1.0 }, { base_url: 'https://cold_a.example.com/v1' });
  const pB = makePair('cold_b', { bindingWeight: 0.0 }, { base_url: 'https://cold_b.example.com/v1' });
  // 预置 A 冷却
  const a = dispatcher.getAcct('cold_a', pA.provider);
  a.cooldownUntil = Date.now() + 120000;
  const { calls, result: r } = await withFetch((url) => {
    if (url.includes('cold_a.example.com')) return IMG_OK('https://cdn/cold_a.png'); // 不应被触达
    if (url.includes('cold_b.example.com')) return IMG_OK('https://cdn/cold_b.png');
    return IMG_401;
  }, async () => dispatcher.dispatchOne([pA, pB], '1k', imageInput(), 'image', null, null));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.providerId, 'cold_b');
  assert.deepStrictEqual(r.images, ['https://cdn/cold_b.png']);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes('cold_b.example.com'));
});

test('dispatchOne: 全部 provider 冷却/不可用 → 有界重试后 throttled（无硬错、不触网）', async () => {
  const pA = makePair('thr_a', { bindingWeight: 1.0 }, { base_url: 'https://thr_a.example.com/v1' });
  const a = dispatcher.getAcct('thr_a', pA.provider);
  a.cooldownUntil = Date.now() + 120000;
  const { calls, result: r } = await withFetch(() => IMG_OK('https://cdn/should-not-hit.png'), async () =>
    dispatcher.dispatchOne([pA], '1k', imageInput(), 'image', null, null));
  assert.strictEqual(r.status, 'throttled');
  assert.strictEqual(r.providerId, null);
  assert.ok(r.retryAfter >= 60000);
  assert.strictEqual(calls.length, 0); // 全程冷却，绝不发请求
});

// ─── 2) attemptOnAccount ──────────────────────────
test('attemptOnAccount: 图片成功 → 归一结果含 attribution（providerId/modelId/type/units/bindingId）', async () => {
  const p = makePair('acc_ok', { bindingWeight: 0.5 }, { base_url: 'https://acc_ok.example.com/v1' });
  const { calls, result: r } = await withFetch((url) => {
    if (url.includes('acc_ok.example.com')) return { status: 200, body: { data: [{ url: 'https://cdn/a.png' }, { url: 'https://cdn/b.png' }] } };
    return IMG_401;
  }, async () => dispatcher.attemptOnAccount(p, '1k', imageInput(), 'image', null));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.providerId, 'acc_ok');
  assert.strictEqual(r.modelId, 'm-acc_ok');
  assert.strictEqual(r.modelType, 'image');
  assert.strictEqual(r.units, 2); // 图片数 = units（供双边记账/consumption）
  assert.strictEqual(r.bindingId, 'b-acc_ok');
  assert.strictEqual(r.images.length, 2);
  assert.strictEqual(calls.length, 1);
});

test('attemptOnAccount: 冷账号 → 返回 null 且不触网', async () => {
  const p = makePair('acc_cold', {}, { base_url: 'https://acc_cold.example.com/v1' });
  const a = dispatcher.getAcct('acc_cold', p.provider);
  a.cooldownUntil = Date.now() + 120000;
  const { calls, result: r } = await withFetch(() => IMG_OK('https://cdn/nope.png'), async () =>
    dispatcher.attemptOnAccount(p, '1k', imageInput(), 'image', null));
  assert.strictEqual(r, null);
  assert.strictEqual(calls.length, 0);
});

test('attemptOnAccount: 429 → null（率受限）并冷却账号；Retry-After 被解析到 key 冷却', async () => {
  const p = makePair('acc_429', {}, { base_url: 'https://acc_429.example.com/v1', api_key: 'sk-test-429' });
  const { calls, result: r } = await withFetch((url) => {
    if (url.includes('acc_429.example.com')) return IMG_429;
    return IMG_401;
  }, async () => dispatcher.attemptOnAccount(p, '1k', imageInput(), 'image', null));
  assert.strictEqual(r, null);
  assert.strictEqual(calls.length, 1);
  const acct = dispatcher.getAcct('acc_429', p.provider);
  assert.ok(acct.cooldownUntil > Date.now()); // markReject 整账号冷却
});

test('attemptOnAccount: 图片瞬时网络错误 → 有界重试吸收（第二次成功）', async () => {
  const p = makePair('acc_retry', {}, { base_url: 'https://acc_retry.example.com/v1' });
  let n = 0;
  const { calls, result: r } = await withFetch((url) => {
    n += 1;
    if (url.includes('acc_retry.example.com')) {
      if (n === 1) return { throw: new Error('fetch failed') };
      return IMG_OK('https://cdn/retry.png');
    }
    return IMG_401;
  }, async () => dispatcher.attemptOnAccount(p, '1k', imageInput(), 'image', null));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.images.length, 1);
  assert.ok(calls.length >= 2); // 首次失败 + 重试成功
});

// ─── 3) imageGenerate ─────────────────────────────
test('imageGenerate: openai-compatible 成功 → images 提取', async () => {
  const provider = { base_url: 'https://gen.example.com/v1', api_key: 'sk-test-ok' };
  const model = { model_id: 'm1', upstreamModelName: 'flux-img' };
  const { calls, result: r } = await withFetch((url) => {
    if (url.includes('/images/generations')) return IMG_OK('https://cdn/gen.png');
    return IMG_401;
  }, async () => dispatcher.imageGenerate(provider, model, imageInput(), 'sk-test-ok'));
  assert.strictEqual(r.status, 'success');
  assert.deepStrictEqual(r.images, ['https://cdn/gen.png']);
  assert.strictEqual(calls.length, 1);
});

test('imageGenerate: 非 2xx → 失败归一（makeError 形状：error+images[]+videoUrl），401 不 retryable', async () => {
  const provider = { base_url: 'https://gen401.example.com/v1', api_key: 'sk-test-401' };
  const model = { model_id: 'm1', upstreamModelName: 'flux-img' };
  const { result: r } = await withFetch(() => IMG_401, async () =>
    dispatcher.imageGenerate(provider, model, imageInput(), 'sk-test-401'));
  assert.strictEqual(r.status, 'error');
  assert.deepStrictEqual(r.images, []);
  assert.strictEqual(r.videoUrl, '');
  assert.ok(r.error.includes('bad key'));
  assert.ok(r.error.startsWith('图片生成失败'));
  assert.strictEqual(r.rateLimited, false); // 401 不触发 key 冷却/换 key
});

test('imageGenerate: 429 → rateLimited=true + retryAfterMs 解析（Retry-After 秒→ms，钳制区间）', async () => {
  const provider = { base_url: 'https://gen429.example.com/v1', api_key: 'sk-test-429' };
  const model = { model_id: 'm1', upstreamModelName: 'flux-img' };
  const { result: r } = await withFetch(() => IMG_429, async () =>
    dispatcher.imageGenerate(provider, model, imageInput(), 'sk-test-429'));
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.rateLimited, true);
  assert.strictEqual(r.retryAfterMs, 2000); // '2' 秒 → 2000ms
  assert.strictEqual(r.images.length, 0);
});

test('imageGenerate: 缺 API key → 直接归一错误，不发请求', async () => {
  const provider = { base_url: 'https://nokey.example.com/v1', api_key: '' };
  const model = { model_id: 'm1', upstreamModelName: 'flux-img' };
  const { calls, result: r } = await withFetch(() => IMG_OK('https://cdn/x.png'), async () =>
    dispatcher.imageGenerate(provider, model, imageInput(), null));
  assert.strictEqual(r.status, 'error');
  assert.ok(r.error.includes('未配置 API Key'));
  assert.strictEqual(calls.length, 0);
});

test('imageGenerate: custom 端点（protocol custom + imageFieldPath）成功', async () => {
  const provider = { base_url: 'https://custom.example.com', api_key: 'sk-test-custom' };
  const model = {
    model_id: 'm1', upstreamModelName: 'custom-img',
    endpoint: { protocol: 'custom', generate: { path: '/v1/my-gen', method: 'POST', imageFieldPath: 'data.imgs' } },
  };
  const { calls, result: r } = await withFetch((url) => {
    if (url.includes('/v1/my-gen')) return { status: 200, body: { data: { imgs: ['https://cdn/c1.png', 'https://cdn/c2.png'] } } };
    return IMG_401;
  }, async () => dispatcher.imageGenerate(provider, model, imageInput(), 'sk-test-custom'));
  assert.strictEqual(r.status, 'success');
  assert.deepStrictEqual(r.images, ['https://cdn/c1.png', 'https://cdn/c2.png']);
  assert.strictEqual(calls.length, 1);
});

test('imageGenerate: 委托 imageIndex.generate（index 被调用，ctx 透传正确）', async () => {
  const orig = imageIndex.generate;
  const seen = [];
  imageIndex.generate = async (ctx) => { seen.push(ctx); return orig(ctx); };
  try {
    const provider = { base_url: 'https://gen.example.com/v1', api_key: 'sk-route' };
    const model = { model_id: 'm1', upstreamModelName: 'flux-img' };
    const { result: r } = await withFetch((url) =>
      url.includes('/images/generations') ? IMG_OK('https://cdn/routed.png') : IMG_401,
      async () => dispatcher.imageGenerate(provider, model, imageInput(), 'sk-route'));
    assert.strictEqual(r.status, 'success');
    assert.deepStrictEqual(r.images, ['https://cdn/routed.png']);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].apiKey, 'sk-route');
    assert.strictEqual(seen[0].provider, provider);
    assert.strictEqual(seen[0].model, model);
    assert.deepStrictEqual(seen[0].payload, imageInput());
  } finally {
    imageIndex.generate = orig;
  }
});

test('imageGenerate: 按 provider 路由到适配器（gpt-image 名 / agnes base_url / openai-compat 兜底 wire 差异）', async () => {
  // gpt-image：size 走官方枚举，请求体不含 ratio / negative_prompt
  let body;
  let rg = await withFetch((url, init) => {
    if (url.includes('/images/generations')) { body = JSON.parse(init.body); return IMG_OK('https://cdn/g.png'); }
    return IMG_401;
  }, async () => dispatcher.imageGenerate(
    { base_url: 'https://api.openai.com/v1', api_key: 'sk-g' },
    { model_id: 'gpt-image-1', upstreamModelName: 'gpt-image-1' },
    imageInput({ ratio: '16:9', negative: 'nsfw' }), 'sk-g'));
  assert.strictEqual(rg.result.status, 'success');
  assert.strictEqual(body.size, '1536x1024');
  assert.ok(!('ratio' in body) && !('negative_prompt' in body));

  // agnes base_url：size 走分辨率档位（1K），发送 ratio、不发 negative_prompt
  rg = await withFetch((url, init) => {
    if (url.includes('/images/generations')) { body = JSON.parse(init.body); return IMG_OK('https://cdn/a.png'); }
    return IMG_401;
  }, async () => dispatcher.imageGenerate(
    { base_url: 'https://api.agnes-ai.cn/v1', api_key: 'sk-a' },
    { model_id: 'flux-1-dev', upstreamModelName: 'flux-1-dev' },
    imageInput({ ratio: '16:9', resolution: '1k', negative: 'nsfw' }), 'sk-a'));
  assert.strictEqual(rg.result.status, 'success');
  assert.strictEqual(body.size, '1K');
  assert.strictEqual(body.ratio, '16:9');
  assert.ok(!('negative_prompt' in body));

  // openai-compat 兜底：size 走标准尺寸表 + resolution 倍增，发送 ratio + negative_prompt
  rg = await withFetch((url, init) => {
    if (url.includes('/images/generations')) { body = JSON.parse(init.body); return IMG_OK('https://cdn/o.png'); }
    return IMG_401;
  }, async () => dispatcher.imageGenerate(
    { base_url: 'https://relay.example.com/v1', api_key: 'sk-o' },
    { model_id: 'flux-1-dev', upstreamModelName: 'flux-1-dev' },
    imageInput({ ratio: '16:9', resolution: '1k', negative: 'nsfw' }), 'sk-o'));
  assert.strictEqual(rg.result.status, 'success');
  assert.strictEqual(body.size, '1792x1024');
  assert.strictEqual(body.ratio, '16:9');
  assert.strictEqual(body.negative_prompt, 'nsfw');
});

test('imageGenerate: 适配层错误码归一为 dispatcher 失败语义（RATE_LIMITED/TIMEOUT/UNKNOWN_PROVIDER/EMPTY_RESPONSE）', async () => {
  const orig = imageIndex.generate;
  const provider = { base_url: 'https://e.example.com/v1', api_key: 'sk-e' };
  const model = { model_id: 'm1', upstreamModelName: 'flux-img' };
  const cases = [
    [{ ok: false, code: 'RATE_LIMITED', retryable: true, message: 'rate limited', retryAfterMs: 2000 },
      { rateLimited: true, retryAfterMs: 2000, prefix: '图片生成失败：' }],
    [{ ok: false, code: 'TIMEOUT', retryable: true, message: '图片生成超时(60s)' },
      { rateLimited: false, retryAfterMs: undefined, prefix: '图片生成超时(60s)' }],
    [{ ok: false, code: 'UNKNOWN_PROVIDER', retryable: false, message: '未知图像服务商（adapter=foo）' },
      { rateLimited: false, retryAfterMs: undefined, prefix: '图片生成失败：' }],
    [{ ok: false, code: 'EMPTY_RESPONSE', retryable: false, message: '响应中无图片数据' },
      { rateLimited: false, retryAfterMs: undefined, prefix: '响应中无图片数据' }],
  ];
  try {
    for (const [outcome, exp] of cases) {
      imageIndex.generate = async () => outcome;
      const r = await dispatcher.imageGenerate(provider, model, imageInput(), 'sk-e');
      assert.strictEqual(r.status, 'error');
      assert.deepStrictEqual(r.images, []);
      assert.strictEqual(r.videoUrl, '');
      assert.strictEqual(r.rateLimited, exp.rateLimited);
      assert.strictEqual(r.retryAfterMs, exp.retryAfterMs);
      assert.ok(r.error.startsWith(exp.prefix), `期望 '${exp.prefix}' 前缀，实际 '${r.error}'`);
    }
  } finally {
    imageIndex.generate = orig;
  }
});

// ─── 4) videoGenerate ─────────────────────────────
test('videoGenerate: 适配层分支（videoRouter fake submit/poll）→ 成功 + onSubmitted 持久化钩子', async () => {
  const orig = { resolveKey: videoIndex.resolveKey, submit: videoIndex.submit, poll: videoIndex.poll };
  const submitCalls = [];
  const pollCalls = [];
  videoIndex.resolveKey = () => 'minimax';
  videoIndex.submit = async () => { submitCalls.push('submit'); return { status: 'submitted', taskId: 'task-mini-1', providerTaskId: 'pt-mini-1' }; };
  videoIndex.poll = async () => { pollCalls.push('poll'); return { videoUrl: 'https://cdn/mini.mp4', status: 'success' }; };
  try {
    const provider = { id: 'vid_adapter', base_url: 'https://adapter.example.com', api_key: 'sk-test-vid' };
    const model = { model_id: 'm-video', upstreamModelName: 'video-x', endpoint: { videoAdapter: 'minimax' } };
    let submitted = null;
    const opts = { prompt: 'p', ratio: '16:9', durationSec: 6, referenceImages: [], negative: '', taskId: 't-v1', onSubmitted: (info) => { submitted = info; } };
    const r = await dispatcher.videoGenerate(provider, model, opts);
    assert.strictEqual(r.status, 'success');
    assert.strictEqual(r.videoUrl, 'https://cdn/mini.mp4');
    assert.strictEqual(submitCalls.length, 1);
    assert.strictEqual(pollCalls.length, 1);
    assert.deepStrictEqual(submitted, { providerTaskId: 'pt-mini-1', providerKey: 'minimax', providerId: 'vid_adapter', modelId: 'm-video' });
  } finally {
    videoIndex.resolveKey = orig.resolveKey;
    videoIndex.submit = orig.submit;
    videoIndex.poll = orig.poll;
  }
});

test('videoGenerate: 适配层提交失败 → 直接透传 error，不进入 poll', async () => {
  const orig = { resolveKey: videoIndex.resolveKey, submit: videoIndex.submit, poll: videoIndex.poll };
  videoIndex.resolveKey = () => 'volcano';
  videoIndex.submit = async () => ({ status: 'error', error: '上游提交失败' });
  videoIndex.poll = async () => { assert.fail('poll 不应被调用'); };
  try {
    const provider = { id: 'vid_sub_fail', base_url: 'https://adapter.example.com', api_key: 'sk-test-vid' };
    const model = { model_id: 'm-video', upstreamModelName: 'video-x', endpoint: { videoAdapter: 'volcano' } };
    const r = await dispatcher.videoGenerate(provider, model, { prompt: 'p', taskId: 't-fail' });
    assert.strictEqual(r.status, 'error');
    assert.ok(r.error.includes('上游提交失败'));
  } finally {
    videoIndex.resolveKey = orig.resolveKey;
    videoIndex.submit = orig.submit;
    videoIndex.poll = orig.poll;
  }
});

test('videoGenerate: generic 内联 async submit+poll（fake client）→ 成功 + provider task id 钩子', async () => {
  const provider = {
    id: 'vid_generic',
    base_url: 'https://gen-video.example.com/v1',
    api_key: 'sk-test-vidgen',
  };
  const model = {
    model_id: 'm-video-gen',
    upstreamModelName: 'video-gen',
    endpoint: {
      protocol: 'custom',
      async: true,
      generate: { path: '/videos/generations', method: 'POST', taskIdPath: 'data.task_id' },
      poll: {
        path: '/videos/result', method: 'GET', taskQueryParam: 'video_id',
        taskStatusPath: 'data.status', taskResultPath: 'data.video_url',
        taskSuccessValues: ['succeeded'], taskPollIntervalMs: 1,
      },
    },
  };
  let submitted = null;
  const opts = {
    prompt: '海边日落', ratio: '16:9', durationSec: 6, referenceImages: [], negative: '',
    resolution: '1k', taskId: 't-gen-1',
    onSubmitted: (info) => { submitted = info; },
  };
  const { result: r } = await withFetch((url, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/videos/generations')) {
      return { status: 200, body: { data: { task_id: 'gen-task-9' } } };
    }
    if (method === 'GET' && url.includes('/videos/result') && url.includes('video_id=gen-task-9')) {
      return { status: 200, body: { data: { status: 'succeeded', video_url: 'https://cdn/gen-video.mp4' } } };
    }
    return { status: 404, body: { error: { message: 'not found' } } };
  }, async () => dispatcher.videoGenerate(provider, model, opts));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.videoUrl, 'https://cdn/gen-video.mp4');
  assert.deepStrictEqual(submitted, { providerTaskId: 'gen-task-9', providerKey: 'generic', providerId: 'vid_generic', modelId: 'm-video-gen' });
});

// ─── 5) completeViaQueue：image 成功 → enqueueFinalize 幂等键链 ───
test('completeViaQueue: image 成功 → commit(billing idempotencyKey) + accounting(ik:pid:mid) + enqueueFinalize 一次', async () => {
  const orig = {
    commit: billingMod.commitCredits,
    record: accountingMod.recordConsumption,
    enqueue: uploadQueue.enqueueFinalize,
    fallback: uploadQueue.finalizeAndEmit,
  };
  const commitCalls = [];
  const recordCalls = [];
  const enqueueCalls = [];
  billingMod.commitCredits = async (pg, userId, amount, ref, pool) => { commitCalls.push({ userId, amount, ref, pool }); return true; };
  accountingMod.recordConsumption = async (pg, args) => { recordCalls.push(args); return; };
  uploadQueue.enqueueFinalize = async (pg, job) => { enqueueCalls.push(job); return; };
  uploadQueue.finalizeAndEmit = async () => { assert.fail('enqueue 成功路径不应走同步兜底'); };
  try {
    const pg = { query: async () => ({ rows: [], rowCount: 0 }) };
    const originalResult = {
      status: 'success',
      images: ['https://cdn/1.png', 'https://cdn/2.png'],
      consumption: [{ providerId: 'p1', modelId: 'm1', modelType: 'image', units: 2, bindingId: 'b1' }],
    };
    await dispatcher.completeViaQueue(pg, {
      userId: 'u1', taskId: 'task-final-1', cost: 10, costPool: 'recharge',
      idempotencyKey: 'ik-final-1',
      ctx: { userId: 'u1', taskId: 'task-final-1', prompt: '一只猫', model: 'm1', ratio: '1:1', contentType: 'image', pendingIds: ['ph-1'] },
      providerImages: originalResult.images,
      providerVideoUrl: null,
      originalResult,
    });
    // billing：幂等键原样传入 commit（DB 层 ON CONFLICT 防重扣）
    assert.strictEqual(commitCalls.length, 1);
    assert.strictEqual(commitCalls[0].ref, 'ik-final-1');
    assert.strictEqual(commitCalls[0].amount, 10);
    assert.strictEqual(commitCalls[0].pool, 'recharge');
    // accounting：每组 idempotencyKey = `${ik}:${providerId}:${modelId}`（防重复记账）
    assert.strictEqual(recordCalls.length, 1);
    assert.strictEqual(recordCalls[0].idempotencyKey, 'ik-final-1:p1:m1');
    assert.strictEqual(recordCalls[0].outputUnits, 2);
    assert.strictEqual(recordCalls[0].taskRef, 'task-final-1');
    // enqueueFinalize：恰好一次，携带 ctx.taskId + providerImages
    assert.strictEqual(enqueueCalls.length, 1);
    assert.strictEqual(enqueueCalls[0].ctx.taskId, 'task-final-1');
    assert.deepStrictEqual(enqueueCalls[0].providerImages, originalResult.images);
    assert.strictEqual(enqueueCalls[0].originalResult.consumption.length, 1);
  } finally {
    billingMod.commitCredits = orig.commit;
    accountingMod.recordConsumption = orig.record;
    uploadQueue.enqueueFinalize = orig.enqueue;
    uploadQueue.finalizeAndEmit = orig.fallback;
  }
});

test('completeViaQueue: enqueueFinalize 抛错 → 退回同步 finalizeAndEmit 兜底（done 不丢）', async () => {
  const orig = {
    commit: billingMod.commitCredits,
    record: accountingMod.recordConsumption,
    enqueue: uploadQueue.enqueueFinalize,
    fallback: uploadQueue.finalizeAndEmit,
  };
  let commitCount = 0;
  const fallbackCalls = [];
  billingMod.commitCredits = async () => { commitCount += 1; return true; };
  accountingMod.recordConsumption = async () => { return; };
  uploadQueue.enqueueFinalize = async () => { throw new Error('queue down'); };
  uploadQueue.finalizeAndEmit = async (pg, args) => { fallbackCalls.push(args); return { images: [] }; };
  try {
    const pg = { query: async () => ({ rows: [], rowCount: 0 }) };
    const originalResult = {
      status: 'success',
      images: ['https://cdn/1.png'],
      consumption: [{ providerId: 'p1', modelId: 'm1', modelType: 'image', units: 1, bindingId: 'b1' }],
    };
    await dispatcher.completeViaQueue(pg, {
      userId: 'u1', taskId: 'task-fb-1', cost: 5, costPool: 'recharge', idempotencyKey: 'ik-fb-1',
      ctx: { userId: 'u1', taskId: 'task-fb-1', prompt: 'p', model: 'm1', ratio: '1:1', contentType: 'image', pendingIds: [] },
      providerImages: originalResult.images, providerVideoUrl: null, originalResult,
    });
    assert.strictEqual(commitCount, 1); // commit 只一次
    assert.strictEqual(fallbackCalls.length, 1);
    assert.strictEqual(fallbackCalls[0].taskId, 'task-fb-1');
  } finally {
    billingMod.commitCredits = orig.commit;
    accountingMod.recordConsumption = orig.record;
    uploadQueue.enqueueFinalize = orig.enqueue;
    uploadQueue.finalizeAndEmit = orig.fallback;
  }
});
