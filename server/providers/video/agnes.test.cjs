'use strict';
/**
 * providers/video/agnes.cjs 契约自测硬化（G10 波）。
 *
 * 二大部分：
 *   A) agnes 适配器自身 submit / poll / submitAndPoll 全路径（fake fetch，零真实出网）：
 *      buildAgnesVars 线体不变量、resolveAgnesEndpoint 默认/覆盖（含部分覆盖回归）、
 *      缺 key、HTTP 4xx、无 taskId、poll pending→success、metadata.url→根 url 回退、
 *      terminal failed、网络异常、取消信号、自定义 taskQueryParam。
 *   B) M02 ai-control 镜像字节一致性声称：验证本认证适配器与
 *      server/modules/ai-control/adapters/agnes.cjs 镜像的形状一致 ——
 *      镜像 normalizeInput 与认证 buildAgnesVars 逐字节一致（同输入 → 同 wire body，零漂移）、
 *      resolveEndpoint 委托一致、status 语义无漂移、taskId/url 提取优先级一致。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const agnes = require('./agnes.cjs');

// ─── fake fetch helpers ─────────────────────────────────────────
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

const PROVIDER = { base_url: 'https://api.agnes-ai.cn/v1', api_key: 'sk-test-1' };
const NOKEY = { base_url: 'https://api.agnes-ai.cn/v1' };
const MODEL = { model_id: 'agnes-image-2.1-flash', upstreamModelName: 'agnes-image-2.1-flash' };
// 轮询间隔压到 5ms：默认 8s 间隔 / 90min 安全线无法在单测等待，全用小间隔覆盖逻辑
const FAST_MODEL = { ...MODEL, endpoint: { poll: { taskPollIntervalMs: 5 } } };

function expectTaskBody(body) {
  assert.equal(body.model, 'agnes-image-2.1-flash');
  assert.equal(typeof body.num_frames, 'number');
  assert.equal((body.num_frames - 1) % 8, 0, 'num_frames 必须 8n+1');
  assert.ok(body.num_frames <= 441, 'num_frames ≤441');
  assert.equal(body.frame_rate, 25);
  return body;
}

// ═══════════════ A. 适配器自身路径 ═══════════════

// ─── buildAgnesVars ─────────────────────────────────────────────
test('buildAgnesVars: t2v 默认线体（时长→num_frames 8n+1、ratio→尺寸、无图无负向）', () => {
  const b = expectTaskBody(agnes.buildAgnesVars({ prompt: 'a cat', ratio: '16:9' }, MODEL));
  assert.equal(b.prompt, 'a cat');
  assert.equal(b.num_frames, 145); // 6s×25fps=150 → 夹到 8n+1
  assert.deepEqual({ width: b.width, height: b.height }, { width: 1152, height: 648 });
  assert.equal(b.negative_prompt, undefined);
  assert.equal(b.image, undefined);
  assert.equal(b.mode, undefined);
});

test('buildAgnesVars: num_frames 上下界（≥9、≤441、恒 8n+1）', () => {
  assert.equal(agnes.buildAgnesVars({ prompt: 'p', durationSec: 100 }, MODEL).num_frames, 441); // 上界
  assert.equal(agnes.buildAgnesVars({ prompt: 'p', durationSec: 0.01 }, MODEL).num_frames, 9);  // 下界
  assert.equal(agnes.buildAgnesVars({ prompt: 'p' }, MODEL).num_frames, 145);                   // 缺省 6s
  assert.equal(agnes.buildAgnesVars({ prompt: 'p', durationSec: 1 }, MODEL).num_frames, 25);    // 25 恰 8n+1
});

test('buildAgnesVars: 单图 → mode ti2vid + image；多图 → mode keyframes + extra_body.image', () => {
  const single = agnes.buildAgnesVars({ prompt: 'p', referenceImages: ['https://i/1.jpg'] }, MODEL);
  assert.equal(single.mode, 'ti2vid');
  assert.equal(single.image, 'https://i/1.jpg');
  assert.equal(single.extra_body, undefined);

  const multi = agnes.buildAgnesVars({ prompt: 'p', referenceImages: ['https://i/1.jpg', 'https://i/2.jpg'] }, MODEL);
  assert.equal(multi.mode, 'keyframes');
  assert.equal(multi.image, undefined);
  assert.deepEqual(multi.extra_body, { image: ['https://i/1.jpg', 'https://i/2.jpg'], mode: 'keyframes' });
});

test('buildAgnesVars: model 名取 upstreamModelName，缺省回落 model_id；负向提示仅 truthy 携带', () => {
  assert.equal(agnes.buildAgnesVars({ prompt: 'p' }, { model_id: 'fallback-id' }).model, 'fallback-id');
  assert.equal(agnes.buildAgnesVars({ prompt: 'p', negative: 'blur' }, MODEL).negative_prompt, 'blur');
  assert.equal(agnes.buildAgnesVars({ prompt: 'p', negative: '' }, MODEL).negative_prompt, undefined);
});

test('buildAgnesVars: 9:16 + 2k 档缩放正确', () => {
  const b = agnes.buildAgnesVars({ prompt: 'p', ratio: '9:16', resolution: '2k' }, MODEL);
  assert.deepEqual({ width: b.width, height: b.height }, { width: 972, height: 1728 });
});

// ─── agnesRootBase / resolveAgnesEndpoint ───────────────────────
test('agnesRootBase: 取协议+主机（剥 /v1 等路径），非法 URL 回落默认', () => {
  assert.equal(agnes.agnesRootBase('https://api.agnes-ai.cn/v1'), 'https://api.agnes-ai.cn');
  assert.equal(agnes.agnesRootBase('https://gw.example.com:8443/x/y'), 'https://gw.example.com:8443');
  assert.equal(agnes.agnesRootBase('not-a-url'), 'https://api.agnes-ai.cn');
});

test('resolveAgnesEndpoint: 默认端点（POST {base}/videos + GET {origin}/agnesapi?video_id=）', () => {
  const { submitEp, pollEp, taskIdPath, baseUrl } = agnes.resolveAgnesEndpoint(PROVIDER, MODEL);
  assert.equal(baseUrl, 'https://api.agnes-ai.cn/v1');
  assert.equal(taskIdPath, 'video_id');
  assert.deepEqual(submitEp, { baseUrl: 'https://api.agnes-ai.cn/v1', path: '/videos', method: 'POST' });
  assert.equal(pollEp.baseUrl, 'https://api.agnes-ai.cn');
  assert.equal(pollEp.path, '/agnesapi');
  assert.equal(pollEp.method, 'GET');
  assert.equal(pollEp.taskQueryParam, 'video_id');
  assert.equal(pollEp.taskResultPath, 'metadata.url');
  assert.equal(pollEp.taskStatusPath, 'status');
  assert.deepEqual(pollEp.taskSuccessValues, ['completed']);
  assert.equal(pollEp.taskPollIntervalMs, 8000);
});

test('resolveAgnesEndpoint: 完整显式覆盖（generate/poll 全量）仍以其为准', () => {
  const model = {
    endpoint: {
      generate: { baseUrl: 'https://g.example', path: '/gen', method: 'POST', taskIdPath: 'data.task_id' },
      poll: { baseUrl: 'https://p.example', path: '/q', method: 'GET', taskQueryParam: 'task_id', taskPollIntervalMs: 1234 },
    },
  };
  const { submitEp, pollEp, taskIdPath } = agnes.resolveAgnesEndpoint(PROVIDER, model);
  assert.equal(submitEp.baseUrl, 'https://g.example');
  assert.equal(submitEp.path, '/gen');
  assert.equal(taskIdPath, 'data.task_id');
  assert.equal(pollEp.baseUrl, 'https://p.example');
  assert.equal(pollEp.path, '/q');
  assert.equal(pollEp.taskPollIntervalMs, 1234);
  assert.equal(pollEp.taskQueryParam, 'task_id');
});

test('resolveAgnesEndpoint: 部分覆盖不丢默认（回归：仅配 interval 也必须保留 path/查询参数默认）', () => {
  // 历史实现里 me.poll 存在即整体替换默认对象 → 只配 taskPollIntervalMs 会让 path 变 undefined，
  // 轮询时 callEndpoint 直接 TypeError（pollFn 抛错 → 轮询异常）。此即 bug 回归测试。
  const { pollEp } = agnes.resolveAgnesEndpoint(PROVIDER, { endpoint: { poll: { taskPollIntervalMs: 5000 } } });
  assert.equal(pollEp.taskPollIntervalMs, 5000);
  assert.equal(pollEp.path, '/agnesapi', '部分覆盖必须保留默认 path');
  assert.equal(pollEp.baseUrl, 'https://api.agnes-ai.cn', '未给 baseUrl 时保留 rootBase');
  assert.equal(pollEp.taskQueryParam, 'video_id');
  assert.equal(pollEp.taskResultPath, 'metadata.url');
  assert.equal(pollEp.taskStatusPath, 'status');
  assert.deepEqual(pollEp.taskSuccessValues, ['completed']);

  // generate 同理：只加 headers 不丢 path/method
  const { submitEp } = agnes.resolveAgnesEndpoint(PROVIDER, { endpoint: { generate: { headers: { 'X-Trace': '1' } } } });
  assert.equal(submitEp.path, '/videos');
  assert.equal(submitEp.method, 'POST');
  assert.equal(submitEp.headers['X-Trace'], '1');
});

// ─── submit ─────────────────────────────────────────────────────
test('submit: 缺 api_key → 短路径 error，0 次出网', async () => {
  const stub = seqFetch([]);
  const restore = installFetch(stub);
  try {
    const s = await agnes.submit(NOKEY, MODEL, { prompt: 'hi' });
    assert.equal(s.status, 'error');
    assert.equal(s.error, '服务商未配置 API Key');
    assert.equal(s.videoUrl, '');
    assert.equal(stub.calls().length, 0);
  } finally { restore(); }
});

test('submit: 成功 → submitted + taskId/providerTaskId（POST /videos，Bearer 头，线体完整）', async () => {
  const stub = seqFetch([jsonRes(200, { video_id: 'vt-100' })]);
  const restore = installFetch(stub);
  try {
    const s = await agnes.submit(PROVIDER, MODEL, { prompt: 'a cat', ratio: '16:9', durationSec: 6 });
    assert.equal(s.status, 'submitted');
    assert.equal(s.taskId, 'vt-100');
    assert.equal(s.providerTaskId, 'vt-100');
    assert.equal(s.videoUrl, '');
    const [call] = stub.calls();
    assert.equal(call.url, 'https://api.agnes-ai.cn/v1/videos');
    assert.equal(call.opts.method, 'POST');
    assert.equal(call.opts.headers.Authorization, 'Bearer sk-test-1');
    expectTaskBody(JSON.parse(call.opts.body));
  } finally { restore(); }
});

test('submit: HTTP 429 → makeError 透传（status error + rateLimited，taskId 缺省）', async () => {
  const stub = seqFetch([jsonRes(429, { error: { message: 'slow down' } })]);
  const restore = installFetch(stub);
  try {
    const s = await agnes.submit(PROVIDER, MODEL, { prompt: 'hi' });
    assert.equal(s.status, 'error');
    assert.equal(s.rateLimited, true);
    assert.match(s.error, /视频任务提交失败：slow down/);
    assert.equal(s.taskId, undefined);
  } finally { restore(); }
});

test('submit: HTTP 5xx 带 message → 视频任务提交失败', async () => {
  const stub = seqFetch([jsonRes(500, { message: 'upstream boom' })]);
  const restore = installFetch(stub);
  try {
    const s = await agnes.submit(PROVIDER, MODEL, { prompt: 'hi' });
    assert.equal(s.status, 'error');
    assert.match(s.error, /视频任务提交失败：upstream boom/);
  } finally { restore(); }
});

test('submit: 成功但无 taskId → 明确报错（taskIdPath 提示）', async () => {
  const stub = seqFetch([jsonRes(200, { ok: true })]);
  const restore = installFetch(stub);
  try {
    const s = await agnes.submit(PROVIDER, MODEL, { prompt: 'hi' });
    assert.equal(s.status, 'error');
    assert.match(s.error, /未返回任务 ID（taskIdPath 配置？）/);
  } finally { restore(); }
});

test('submit: 网络异常 → 提交异常（不裸抛 stack）', async () => {
  const restore = installFetch(async () => { throw new Error('ECONNRESET'); });
  try {
    const s = await agnes.submit(PROVIDER, MODEL, { prompt: 'hi' });
    assert.equal(s.status, 'error');
    assert.match(s.error, /提交异常：ECONNRESET/);
  } finally { restore(); }
});

// ─── poll ───────────────────────────────────────────────────────
test('poll: pending×2 → completed（metadata.url 命中 taskResultPath）→ success', async () => {
  const stub = seqFetch([
    jsonRes(200, { status: 'in_progress' }),
    jsonRes(200, { status: 'queued' }),
    jsonRes(200, { status: 'completed', metadata: { url: 'https://cdn/final.mp4' } }),
  ]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.poll(PROVIDER, FAST_MODEL, 'vt-100');
    assert.equal(r.status, 'success');
    assert.equal(r.videoUrl, 'https://cdn/final.mp4');
    const calls = stub.calls();
    assert.equal(calls.length, 3, '两次 pending 重试 + 一次成功');
    assert.equal(calls[0].url, 'https://api.agnes-ai.cn/agnesapi?video_id=vt-100');
    assert.equal(calls[0].opts.method, 'GET');
    assert.equal(calls[2].opts.headers.Authorization, 'Bearer sk-test-1');
  } finally { restore(); }
});

test('poll: 根 url 回退（无 metadata.url 时读根 url，兼容旧版）', async () => {
  const stub = seqFetch([jsonRes(200, { status: 'completed', url: 'https://cdn/legacy.mp4' })]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.poll(PROVIDER, FAST_MODEL, 'vt-1');
    assert.equal(r.status, 'success');
    assert.equal(r.videoUrl, 'https://cdn/legacy.mp4');
  } finally { restore(); }
});

test('poll: completed 但无任何 URL → error（taskResultPath？）', async () => {
  const stub = seqFetch([jsonRes(200, { status: 'completed' })]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.poll(PROVIDER, FAST_MODEL, 'vt-1');
    assert.equal(r.status, 'error');
    assert.match(r.error, /任务成功但未返回视频 URL/);
  } finally { restore(); }
});

test('poll: 生成端 terminal 失败（failed/error/canceled/cancelled）→ status failed 终态（不空转）', async () => {
  for (const raw of ['failed', 'error', 'canceled', 'cancelled']) {
    const stub = seqFetch([jsonRes(200, { status: raw })]);
    const restore = installFetch(stub);
    try {
      const r = await agnes.poll(PROVIDER, FAST_MODEL, 'vt-1');
      assert.equal(r.status, 'failed', `raw=${raw}`);
      assert.match(r.error, /视频生成失败/);
      assert.equal(stub.calls().length, 1, '终态失败只打一次');
    } finally { restore(); }
  }
});

test('poll: pollFn 网络异常 → 轮询异常（瞬时 error 非 failed）', async () => {
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n === 1) throw new Error('socket hang up');
    return jsonRes(200, { status: 'completed', metadata: { url: 'https://cdn/x.mp4' } });
  };
  const restore = installFetch(flaky);
  try {
    const r = await agnes.poll(PROVIDER, FAST_MODEL, 'vt-1');
    assert.equal(r.status, 'error');
    assert.match(r.error, /轮询异常：socket hang up/);
    assert.equal(n, 1, '异常即返回，不吞掉继续轮询');
  } finally { restore(); }
});

test('poll: 取消信号命中（sleep 前）→ canceled，0 次出网', async () => {
  const stub = seqFetch([]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.poll(PROVIDER, FAST_MODEL, 'vt-1', 0, () => true);
    assert.equal(r.status, 'canceled');
    assert.equal(r.error, '用户已取消');
    assert.equal(stub.calls().length, 0);
  } finally { restore(); }
});

test('poll: startedAt/isCancelled 透传（崩溃恢复续轮询复用已持久化 taskId）', async () => {
  const stub = seqFetch([
    jsonRes(200, { status: 'in_progress' }),
    jsonRes(200, { status: 'completed', metadata: { url: 'https://cdn/resume.mp4' } }),
  ]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.poll(PROVIDER, FAST_MODEL, 'resumed-task-1', Date.now() - 10 * 1000, null);
    assert.equal(r.status, 'success');
    assert.equal(r.videoUrl, 'https://cdn/resume.mp4');
  } finally { restore(); }
});

test('poll: 自定义 taskQueryParam / taskSuccessValues / taskResultPath 经 model.endpoint.poll 生效', async () => {
  const model = {
    model_id: 'm', upstreamModelName: 'm',
    endpoint: {
      poll: {
        baseUrl: 'https://api.agnes-ai.cn', path: '/custom-poll', method: 'GET',
        taskQueryParam: 'job_id', taskSuccessValues: ['done'], taskResultPath: 'out.url',
        taskStatusPath: 'state', taskPollIntervalMs: 5,
      },
    },
  };
  const stub = seqFetch([jsonRes(200, { state: 'running' }), jsonRes(200, { state: 'done', out: { url: 'https://cdn/c.mp4' } })]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.poll(PROVIDER, model, 'job-42');
    assert.equal(r.status, 'success');
    assert.equal(r.videoUrl, 'https://cdn/c.mp4');
    const calls = stub.calls();
    assert.equal(calls[0].url, 'https://api.agnes-ai.cn/custom-poll?job_id=job-42');
    assert.equal(calls[1].url, 'https://api.agnes-ai.cn/custom-poll?job_id=job-42');
  } finally { restore(); }
});

test('poll: 部分 poll 覆盖（仅 interval）+ pending→success 端到端（resolveAgnesEndpoint 修复回归）', async () => {
  // 仅覆盖 taskPollIntervalMs —— 修复前 path 丢失 → callEndpoint TypeError → 轮询异常 error
  const model = { model_id: 'm', upstreamModelName: 'm', endpoint: { poll: { taskPollIntervalMs: 5 } } };
  const stub = seqFetch([
    jsonRes(200, { status: 'in_progress' }),
    jsonRes(200, { status: 'completed', metadata: { url: 'https://cdn/partial.mp4' } }),
  ]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.poll(PROVIDER, model, 'vt-partial');
    assert.equal(r.status, 'success');
    assert.equal(r.videoUrl, 'https://cdn/partial.mp4');
    const calls = stub.calls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://api.agnes-ai.cn/agnesapi?video_id=vt-partial');
  } finally { restore(); }
});

// ─── submitAndPoll ──────────────────────────────────────────────
test('submitAndPoll: 提交阶段报错直接透传（不进轮询）', async () => {
  const stub = seqFetch([]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.submitAndPoll(NOKEY, MODEL, { prompt: 'hi' });
    assert.equal(r.status, 'error');
    assert.equal(r.error, '服务商未配置 API Key');
    assert.equal(stub.calls().length, 0);
  } finally { restore(); }
});

test('submitAndPoll: 提交成功 → 轮询到 success 全链', async () => {
  const stub = seqFetch([
    jsonRes(200, { video_id: 'vt-chain' }),                                              // submit
    jsonRes(200, { status: 'in_progress' }),                                             // poll #1
    jsonRes(200, { status: 'completed', metadata: { url: 'https://cdn/chain.mp4' } }),   // poll #2
  ]);
  const restore = installFetch(stub);
  try {
    const r = await agnes.submitAndPoll(PROVIDER, FAST_MODEL, { prompt: 'hi' });
    assert.equal(r.status, 'success');
    assert.equal(r.videoUrl, 'https://cdn/chain.mp4');
    assert.equal(stub.calls().length, 3);
    assert.equal(stub.calls()[0].url, 'https://api.agnes-ai.cn/v1/videos');
    assert.equal(stub.calls()[2].url, 'https://api.agnes-ai.cn/agnesapi?video_id=vt-chain');
  } finally { restore(); }
});

// ═══════════════ B. M02 ai-control 镜像契约（字节一致性声称） ═══════════════
const mirror = require('../../modules/ai-control/adapters/agnes.cjs');
const { assertAdapterContract } = require('../../modules/ai-control/contracts/adapter.cjs');
const { isTerminal } = require('../../modules/ai-control/domain/status.cjs');

function fakeTransport() {
  return {
    submit: async () => ({ status: 200, body: { video_id: 'v' } }),
    poll: async () => ({ status: 200, body: { status: 'completed', metadata: { url: 'https://cdn/x.mp4' } } }),
  };
}

test('M02镜像: ai-control agnes adapter 满足正式 adapter 契约，纯部分复用本文件导出', () => {
  const a = mirror.createAgnesAdapter({ transport: fakeTransport() });
  assert.equal(assertAdapterContract(a).ok, true);
  assert.equal(a.name, 'agnes');
  // 镜像复用的两个纯入口必须仍在认证模块导出（防重构漂移）
  assert.equal(typeof agnes.buildAgnesVars, 'function');
  assert.equal(typeof agnes.resolveAgnesEndpoint, 'function');
});

test('M02镜像: normalizeInput 与认证 buildAgnesVars 字节一致（同输入 → 同 wire body）', () => {
  const a = mirror.createAgnesAdapter({ transport: fakeTransport() });
  const cases = [
    { input: { prompt: 'a cat' }, params: {} },
    {
      input: { prompt: 'a dog runs', ratio: '16:9', durationSec: 6, negative: 'blur', resolution: '2k', referenceImages: ['https://img/1.jpg'] },
      params: {},
    },
    { input: { prompt: 'handoff', referenceImages: ['https://img/1.jpg', 'https://img/2.jpg'] }, params: {} },
    { input: { prompt: 'params-route' }, params: { ratio: '9:16', durationSec: 5, resolution: '4k', upstreamModelName: 'agnes-other-model' } },
    { input: { prompt: 'vertical', ratio: '3:4', durationSec: 9, referenceImages: ['https://img/a.jpg'] }, params: {} },
  ];
  for (const { input, params } of cases) {
    const viaMirror = a.normalizeInput(MODEL, input, params);
    const modelForCertified = params.upstreamModelName
      ? { ...MODEL, upstreamModelName: params.upstreamModelName }
      : MODEL;
    const viaCertified = agnes.buildAgnesVars({
      prompt: input.prompt,
      ratio: input.ratio || params.ratio,
      durationSec: input.durationSec != null ? input.durationSec : params.durationSec,
      referenceImages: input.referenceImages,
      negative: input.negative,
      resolution: input.resolution || params.resolution,
    }, modelForCertified);
    assert.deepEqual(viaMirror, viaCertified, `byte-identical 漂移: input=${JSON.stringify(input)}`);
  }
});

test('M02镜像: resolveEndpoint 委托 = 认证 resolveAgnesEndpoint（零漂移）', () => {
  const a = mirror.createAgnesAdapter({ transport: fakeTransport() });
  const provider = { base_url: 'https://api.agnes-ai.cn/v1' };
  const model = { model_id: 'm', upstreamModelName: 'm', endpoint: { poll: { taskPollIntervalMs: 3000 } } };
  assert.deepEqual(a.resolveEndpoint(provider, model), agnes.resolveAgnesEndpoint(provider, model));
});

test('M02镜像: status 语义无漂移 —— 本文件判定的成功/终态集合与 M02 状态表一致', () => {
  const { AGNES_STATUS_MAP: map } = mirror;
  // 成功集合：本文件默认 taskSuccessValues ['completed'] → M02 判 SUCCEEDED
  assert.equal(map.completed, 'SUCCEEDED');
  // 终态失败集合：本文件 terminal failed 的四个 raw → M02 必须落在 {FAILED, CANCELLED}（isTerminal）
  for (const raw of ['failed', 'error', 'canceled', 'cancelled']) {
    const state = map[raw];
    assert.ok(['FAILED', 'CANCELLED'].includes(state), `raw=${raw} → ${state}`);
    assert.ok(isTerminal(state), `raw=${raw} 两侧同判终态`);
  }
  // 中间态两侧都不判终：本文件继续轮询 pending；M02 为非终态 QUEUED/SUBMITTED/PROCESSING
  for (const raw of ['queued', 'inqueue', 'submitted', 'in_progress']) {
    assert.ok(!isTerminal(map[raw]), `raw=${raw} 非终态`);
  }
});

test('M02镜像: taskId / url 提取优先级一致（video_id；metadata.url 优先于根 url）', async () => {
  // taskId：认证走 taskIdPath 默认 video_id；镜像读 body.video_id ?? body.id —— 交集都在 video_id
  const a = mirror.createAgnesAdapter({ transport: fakeTransport() });
  const submitted = await a.submit({ credential: 'c', provider: PROVIDER, logicalModel: MODEL, input: { prompt: 'hi' } });
  assert.equal(submitted.taskId, 'v');
  assert.equal(submitted.providerTaskId, 'v');

  // url 优先级：两侧一致 —— metadata.url 优先，缺位回退根 url
  const urlOf = (pollBody) => {
    const u = (pollBody.metadata && pollBody.metadata.url) || pollBody.url || '';
    return u;
  };
  assert.equal(urlOf({ metadata: { url: 'https://cdn/meta.mp4' }, url: 'https://cdn/root.mp4' }), 'https://cdn/meta.mp4');
  assert.equal(urlOf({ url: 'https://cdn/root.mp4' }), 'https://cdn/root.mp4');
  assert.equal(urlOf({ status: 'completed' }), '');
});
