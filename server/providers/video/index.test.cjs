'use strict';
/**
 * providers/video/index.cjs 路由自测硬化（G10 波）—— 未知 provider / 缺 key / 能力分派。
 *
 * 覆盖：
 *   1) resolveKey：显式 videoAdapter（model > provider.default_endpoint）> base_url 正则推断 > generic
 *   2) 未知/恶意 provider key：'generic' 缺 adapter 干净报错；'constructor'/'__proto__' 等
 *      prototype 链键不得穿透路由（历史实现会命中 Object.prototype 并让 submitAndPoll 抛 TypeError）
 *   3) 缺 api_key：路由到 agnes 后短路径报「服务商未配置 API Key」，0 次出网
 *   4) 能力分派：adapters 表与模块实例一致；显式 videoAdapter 可把未知 base_url 精确路由到 agnes，
 *      且经真实适配器代码 + fake fetch 全链 submit→poll→success 走通
 * 所有 HTTP 均为 fake fetch，零真实出网。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const index = require('./index.cjs');
const agnesMod = require('./agnes.cjs');
const minimaxMod = require('./minimax.cjs');
const volcanoMod = require('./volcano.cjs');

function jsonRes(status, body) { return { status, text: async () => JSON.stringify(body) }; }
function seqFetch(responses) {
  const calls = [];
  const stub = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length > responses.length) throw new Error('unexpected extra fetch call');
    return responses[calls.length - 1];
  };
  stub.calls = () => calls;
  return stub;
}
function installFetch(stub) {
  const orig = global.fetch;
  global.fetch = stub;
  return () => { global.fetch = orig; };
}

// 便于快速组（provider, model）
const P_AGNES = { base_url: 'https://api.agnes-ai.cn/v1' };
const M = { model_id: 'agnes-image-2.1-flash', upstreamModelName: 'agnes-image-2.1-flash' };
const OPTS = { prompt: 'a cat', ratio: '16:9', durationSec: 6 };

// ─── resolveKey：显式声明优先 ───────────────────────────────────
test('resolveKey: model.endpoint.videoAdapter 显式声明 > base_url 推断', () => {
  // base_url 明明是 minimax，但 model 显式 agnes
  const provider = { base_url: 'https://api.minimax.io/v2' };
  assert.equal(index.resolveKey(provider, { endpoint: { videoAdapter: 'agnes' } }), 'agnes');
});

test('resolveKey: provider.default_endpoint.videoAdapter 次优先（model 未声明时）', () => {
  const provider = { base_url: 'https://api.agnes-ai.cn/v1', default_endpoint: { videoAdapter: 'volcano' } };
  assert.equal(index.resolveKey(provider, M), 'volcano');
  // model 显式声明压过 provider 默认
  assert.equal(index.resolveKey(provider, { endpoint: { videoAdapter: 'minimax' } }), 'minimax');
});

test('resolveKey: base_url 正则推断 agnes / minimax / volcano', () => {
  assert.equal(index.resolveKey({ base_url: 'https://api.agnes-ai.cn/v1' }, M), 'agnes');
  assert.equal(index.resolveKey({ base_url: 'https://api.minimaxi.com/v2' }, M), 'minimax');
  assert.equal(index.resolveKey({ base_url: 'https://ark.cn-beijing.volces.com/api/v3' }, M), 'volcano');
  assert.equal(index.resolveKey({ base_url: 'https://api.minimax.io' }, M), 'minimax');
});

test('resolveKey: 未知 base_url / 无 base_url → generic（dispatcher 内联兜底）', () => {
  assert.equal(index.resolveKey({ base_url: 'https://openai.example.com/v1' }, M), 'generic');
  assert.equal(index.resolveKey({ base_url: '' }, M), 'generic');
  assert.equal(index.resolveKey({}, {}), 'generic');
  assert.equal(index.resolveKey(undefined, undefined), 'generic');
});

// ─── 未知 / 恶意 videoAdapter 值 ────────────────────────────────
test('resolveKey: 未注册的显式 videoAdapter（foo）视作未声明，回落 base_url 推断', () => {
  assert.equal(index.resolveKey(P_AGNES, { endpoint: { videoAdapter: 'foo' } }), 'agnes');
  assert.equal(index.resolveKey({ base_url: 'https://x.example' }, { endpoint: { videoAdapter: 'foo' } }), 'generic');
});

test('resolveKey: prototype 链键（constructor/__proto__/hasOwnProperty）不得穿透路由', () => {
  for (const evil of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
    assert.equal(
      index.resolveKey({ base_url: 'https://api.agnes-ai.cn/v1' }, { endpoint: { videoAdapter: evil } }),
      'agnes', `${evil} 应回落 base_url 推断`,
    );
    assert.equal(
      index.resolveKey({ base_url: 'https://x.example' }, { endpoint: { videoAdapter: evil } }),
      'generic', `${evil} 应回落 generic`,
    );
  }
});

test('submitAndPoll: prototype 键 videoAdapter 不得崩溃，须走干净错误路径', async () => {
  const provider = { base_url: 'https://evil.example/v1' };
  const model = { model_id: 'm', endpoint: { videoAdapter: 'constructor' } };
  const r = await index.submitAndPoll(provider, model, OPTS); // 修复前：TypeError（ad.submitAndPoll is not a function）
  assert.equal(r.status, 'error');
  assert.match(r.error, /未找到视频适配器/);
  assert.equal(r.videoUrl, '');
});

// ─── 未知 provider（generic 无 adapter）错误路径 ─────────────────
test('submit / poll / submitAndPoll: 未知 provider → 干净错误（非崩溃）', async () => {
  const provider = { base_url: 'https://unknown.example/v1', api_key: 'sk-x' };
  const s = await index.submit(provider, M, OPTS);
  assert.equal(s.status, 'error');
  assert.equal(s.error, '未找到视频适配器或缺少 submit：generic');

  const p = await index.poll(provider, M, 'task-1');
  assert.equal(p.status, 'error');
  assert.equal(p.error, '未找到视频适配器或缺少 poll：generic');

  const sp = await index.submitAndPoll(provider, M, OPTS);
  assert.equal(sp.status, 'error');
  assert.equal(sp.error, '未找到视频适配器：generic');
});

// ─── 缺 api_key ─────────────────────────────────────────────────
test('缺 api_key: agnes 路由短路径报错透传（submit + submitAndPoll），0 次出网', async () => {
  const noKey = { base_url: 'https://api.agnes-ai.cn/v1' }; // 无 api_key
  const stub = seqFetch([]); // 任何 fetch 都是不该发生的
  const restore = installFetch(stub);
  try {
    const s = await index.submit(noKey, M, OPTS);
    assert.equal(s.status, 'error');
    assert.equal(s.error, '服务商未配置 API Key');
    assert.equal(s.videoUrl, '');

    const sp = await index.submitAndPoll(noKey, M, OPTS);
    assert.equal(sp.status, 'error');
    assert.equal(sp.error, '服务商未配置 API Key');

    assert.equal(stub.calls().length, 0, '缺 key 不得发起任何 HTTP');
  } finally { restore(); }
});

// ─── 能力分派 ───────────────────────────────────────────────────
test('adapters 表：与各适配器模块实例一致，且均具备 submit/poll 能力', () => {
  assert.equal(index.adapters.agnes, agnesMod);
  assert.equal(index.adapters.minimax, minimaxMod);
  assert.equal(index.adapters.volcano, volcanoMod);
  assert.equal(index.adapters.generic, undefined);
  for (const [k, ad] of Object.entries(index.adapters)) {
    assert.equal(typeof ad.submit, 'function', `${k}.submit`);
    assert.equal(typeof ad.poll, 'function', `${k}.poll`);
  }
});

test('能力分派: 显式 videoAdapter=agnes + 未知 base_url → 全链 submit→poll→success（fake fetch）', async () => {
  const provider = {
    base_url: 'https://custom-gateway.example/v1', // base_url 无 agnes 特征，全靠显式声明
    api_key: 'sk-dispatch-1',
  };
  const model = {
    model_id: 'agnes-image-2.1-flash',
    upstreamModelName: 'agnes-image-2.1-flash',
    endpoint: {
      videoAdapter: 'agnes', // base_url 无 agnes 特征：全靠显式声明路由
      generate: { path: '/videos', method: 'POST' },
      poll: {
        baseUrl: 'https://custom-gateway.example', path: '/agnesapi', method: 'GET',
        taskQueryParam: 'video_id', taskStatusPath: 'status',
        taskSuccessValues: ['completed'], taskResultPath: 'metadata.url',
        taskPollIntervalMs: 5,
      },
    },
  };
  assert.equal(index.resolveKey(provider, model), 'agnes', '显式声明必须压过 base_url 推断');

  const stub = seqFetch([
    jsonRes(200, { video_id: 'vid-77' }),              // submit POST /videos
    jsonRes(200, { status: 'in_progress' }),           // poll #1 → pending
    jsonRes(200, { status: 'completed', metadata: { url: 'https://cdn/v77.mp4' } }), // poll #2 → success
  ]);
  const restore = installFetch(stub);
  try {
    const r = await index.submitAndPoll(provider, model, OPTS);
    assert.equal(r.status, 'success');
    assert.equal(r.videoUrl, 'https://cdn/v77.mp4');
    const calls = stub.calls();
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://custom-gateway.example/v1/videos');
    assert.equal(calls[1].url, 'https://custom-gateway.example/agnesapi?video_id=vid-77');
    assert.equal(calls[2].url, 'https://custom-gateway.example/agnesapi?video_id=vid-77');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-dispatch-1');
  } finally { restore(); }
});

test('能力分派: index.poll 仅轮询（复用已持久化 taskId），无需重提交', async () => {
  const provider = { base_url: 'https://api.agnes-ai.cn/v1', api_key: 'sk-poll-1' };
  const model = {
    model_id: 'm', upstreamModelName: 'm',
    endpoint: { poll: { path: '/agnesapi', method: 'GET', taskPollIntervalMs: 5, taskQueryParam: 'video_id' } },
  };
  const stub = seqFetch([
    jsonRes(200, { status: 'failed', detail: 'model rejected' }), // 终态失败一次即返回
  ]);
  const restore = installFetch(stub);
  try {
    const r = await index.poll(provider, model, 'persisted-task-9');
    assert.equal(r.status, 'failed');
    assert.match(r.error, /视频生成失败/);
    assert.equal(stub.calls()[0].url, 'https://api.agnes-ai.cn/agnesapi?video_id=persisted-task-9');
  } finally { restore(); }
});

test('能力分派: provider 4xx 错误经 makeError 透传（含 rateLimited 429 语义）', async () => {
  const provider = { base_url: 'https://api.agnes-ai.cn/v1', api_key: 'sk-rate' };
  const model = { model_id: 'm', upstreamModelName: 'm', endpoint: { generate: { path: '/videos' } } };
  const stub = seqFetch([jsonRes(429, { error: { message: 'too many requests' } })]);
  const restore = installFetch(stub);
  try {
    const s = await index.submit(provider, model, OPTS);
    assert.equal(s.status, 'error');
    assert.equal(s.rateLimited, true);
    assert.match(s.error, /too many requests/);
  } finally { restore(); }
});
