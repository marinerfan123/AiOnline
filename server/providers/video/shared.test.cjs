'use strict';
/**
 * providers/video/shared.cjs 自测硬化（G10 波）—— 纯 fake transport / fake fetch，零真实出网。
 *
 * 覆盖四块：
 *   1) 归一：normalizeVideoStatus / deriveVideoMode / agnesVideoSize / makeError / getByPath / fillTemplate / resolveEndpoint / buildVideoContent
 *   2) HTTP 构造：callEndpoint（POST/GET/DELETE、query 拼装、Authorization、bodyTemplate、JSON 解析回退）
 *   3) 超时：callEndpoint / fetchJson 60s AbortController 接线（测试期把 setTimeout 夹到 15ms，秒级验证中止路径）
 *   4) 重试/轮询：pollLoop 的 重试直至终态 / terminal 短路 / 取消信号×3 / pollFn 异常 / 超时返 timeout 非 error
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fillTemplate, getByPath, sleep, callEndpoint, fetchJson, resolveEndpoint, makeError,
  agnesVideoSize, deriveVideoMode, buildVideoContent, normalizeVideoStatus, pollLoop,
} = require('./shared.cjs');

// ─── fake fetch helpers ─────────────────────────────────────────
function jsonRes(status, body) { return { status, text: async () => JSON.stringify(body) }; }
function textRes(status, text) { return { status, text: async () => text }; }

function installFetch(stub) {
  const orig = global.fetch;
  global.fetch = stub;
  return () => { global.fetch = orig; };
}

// 序列响应：按调用次数依次出响应；超出队列立即抛错（fail-fast，避免测试误挂 90 分钟）
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

// 期间把全局 setTimeout 夹到 ≤15ms，让 60s AbortController 超时秒级触发；结束必还原
async function withFastTimeout(fn) {
  const orig = global.setTimeout;
  global.setTimeout = (cb, ms, ...args) => orig(cb, Math.max(0, Math.min(ms, 15)), ...args);
  try { return await fn(); } finally { global.setTimeout = orig; }
}

// ─── 归一：normalizeVideoStatus ─────────────────────────────────
test('normalizeVideoStatus: 供应商原始态 → canonical success/failed/pending', () => {
  for (const ok of ['succeeded', 'success', 'succeed', 'done', 'completed']) {
    assert.equal(normalizeVideoStatus(ok), 'success', ok);
    assert.equal(normalizeVideoStatus(ok.toUpperCase()), 'success', ok.toUpperCase());
  }
  for (const fail of ['failed', 'error', 'cancelled', 'canceled', 'expired']) {
    assert.equal(normalizeVideoStatus(fail), 'failed', fail);
  }
  for (const pend of ['processing', 'queued', 'in_progress', 'pending', 'unknown', '', null, undefined]) {
    assert.equal(normalizeVideoStatus(pend), 'pending', String(pend));
  }
  // 非字符串入参兜底
  assert.equal(normalizeVideoStatus(42), 'pending');
});

// ─── 归一：deriveVideoMode ──────────────────────────────────────
test('deriveVideoMode: 参考图数量 → t2v / i2v_first / i2v_first_last / reference_image', () => {
  assert.equal(deriveVideoMode(), 't2v');
  assert.equal(deriveVideoMode([]), 't2v');
  assert.equal(deriveVideoMode(['a']), 'i2v_first');
  assert.equal(deriveVideoMode(['a', 'b']), 'i2v_first_last');
  assert.equal(deriveVideoMode(['a', 'b', 'c']), 'reference_image');
  assert.equal(deriveVideoMode(['a', 'b', 'c', 'd']), 'reference_image');
});

// ─── 归一：agnesVideoSize ───────────────────────────────────────
test('agnesVideoSize: ratio→基础尺寸，resolution 档位缩放（大小写不敏感）', () => {
  assert.deepEqual(agnesVideoSize('16:9'), { width: 1152, height: 648 });
  assert.deepEqual(agnesVideoSize('9:16'), { width: 648, height: 1152 });
  assert.deepEqual(agnesVideoSize('4:3'), { width: 1024, height: 768 });
  assert.deepEqual(agnesVideoSize('3:4'), { width: 768, height: 1024 });
  assert.deepEqual(agnesVideoSize('1:1'), { width: 1024, height: 1024 });
  assert.deepEqual(agnesVideoSize('21:9'), { width: 1024, height: 1024 }); // 未知 ratio → 默认
  assert.deepEqual(agnesVideoSize('16:9', '2k'), { width: 1728, height: 972 });   // ×1.5
  assert.deepEqual(agnesVideoSize('16:9', '4K'), { width: 2880, height: 1620 });  // ×2.5 且大小写不敏感
  assert.deepEqual(agnesVideoSize('9:16', '3k'), { width: 1296, height: 2304 });  // ×2
  assert.deepEqual(agnesVideoSize('16:9', 'bogus'), { width: 1152, height: 648 }); // 未知档 → 1k
  assert.deepEqual(agnesVideoSize('16:9', undefined), { width: 1152, height: 648 });
  assert.equal(agnesVideoSize('16:9').width % 1, 0); // 缩放四舍五入为整数
});

// ─── 归一：makeError ────────────────────────────────────────────
test('makeError: 错误信息提取优先级 + 429 标记 rateLimited + 固定形状', () => {
  const a = makeError({ error: { message: 'boom' } }, 500, '视频任务提交失败');
  assert.equal(a.status, 'error');
  assert.equal(a.error, '视频任务提交失败：boom');
  assert.deepEqual(a.images, []);
  assert.equal(a.videoUrl, '');
  assert.equal(a.rateLimited, false);

  assert.equal(makeError({ message: 'm1' }, 400, 'X').error, 'X：m1');
  assert.equal(makeError('raw-string-error', 502, 'X').error, 'X：raw-string-error');
  assert.equal(makeError(null, 500, 'X').error, 'X：HTTP 500');
  assert.equal(makeError({}, 429, 'X').error, 'X：HTTP 429');
  assert.equal(makeError({ error: { message: 'too many' } }, 429, 'X').rateLimited, true);
});

// ─── 归一：getByPath ────────────────────────────────────────────
test('getByPath: 点路径 + 数组下标 + 缺位兜底', () => {
  const obj = { metadata: { url: 'https://v/1.mp4' }, items: [{ name: 'a' }, { name: 'b' }] };
  assert.equal(getByPath(obj, 'metadata.url'), 'https://v/1.mp4');
  assert.equal(getByPath(obj, 'items[1].name'), 'b');
  assert.equal(getByPath(obj, 'items[0]'), obj.items[0]);
  assert.equal(getByPath(obj, 'nope.deep'), undefined);
  assert.equal(getByPath(obj, ''), undefined);
  assert.equal(getByPath(null, 'a'), undefined);
  assert.equal(getByPath(obj, undefined), undefined);
});

// ─── 归一：fillTemplate ─────────────────────────────────────────
test('fillTemplate: {{path}} 占位替换（缺值 → null，字符串带引号）', () => {
  const vars = { model: 'm1', prompt: 'a cat', nested: { depth: 7 } };
  assert.equal(fillTemplate('{{model}}', vars), '"m1"');
  assert.equal(fillTemplate('{{prompt}}', vars), '"a cat"');
  assert.equal(fillTemplate('{{nested.depth}}', vars), '7');
  assert.equal(fillTemplate('missing={{missing}}', vars), 'missing=null');
  assert.equal(fillTemplate('{{model}}:{{missing}}', vars), '"m1":null');
  assert.equal(fillTemplate('no placeholders', vars), 'no placeholders');
});

// ─── 归一：resolveEndpoint ──────────────────────────────────────
test('resolveEndpoint: model.endpoint 覆盖 > provider.default_endpoint > openai-compatible 兜底', () => {
  const provider = {
    default_endpoint: { generate: 'https://pe/videos' },
    protocol: 'custom',
  };
  const model = { endpoint: { generate: 'https://me/videos' } };
  // me/pe 命中时 protocol 取自该端点对象自身（通常未配 → undefined）
  assert.deepEqual(resolveEndpoint(provider, model, 'generate'), { protocol: undefined, endpoint: 'https://me/videos' });
  assert.deepEqual(resolveEndpoint(provider, {}, 'generate'), { protocol: undefined, endpoint: 'https://pe/videos' });
  // 全缺 → openai-compatible 兜底（provider.protocol 仅在最终兜底分支浮出）
  assert.deepEqual(resolveEndpoint({ protocol: 'custom' }, {}, 'generate'), { protocol: 'custom', endpoint: undefined });
  assert.deepEqual(resolveEndpoint({}, {}, 'poll'), { protocol: 'openai-compatible', endpoint: undefined });
  // camelCase defaultEndpoint 也认
  assert.equal(resolveEndpoint({ defaultEndpoint: { generate: 'https://pe2/v' } }, {}, 'generate').endpoint, 'https://pe2/v');
});

// ─── 归一：buildVideoContent ────────────────────────────────────
test('buildVideoContent: minimax（content:url 平铺）与 volcano（image_url.url 嵌套）双词汇', () => {
  const refs = ['https://i/1.jpg', 'https://i/2.jpg', 'https://i/3.jpg'];
  // minimax t2v → 仅 text
  assert.deepEqual(buildVideoContent([], 't2v', 'p', 'minimax'), [{ type: 'text', content: 'p' }]);
  // minimax i2v_first_last → first/last_frame
  assert.deepEqual(buildVideoContent(refs, 'i2v_first_last', 'p', 'minimax'), [
    { type: 'text', content: 'p' },
    { type: 'image_url', role: 'first_frame', content: refs[0] },
    { type: 'image_url', role: 'last_frame', content: refs[1] },
  ]);
  // minimax reference_image → 全部 reference_image
  const mmRef = buildVideoContent(refs, 'reference_image', 'p', 'minimax');
  assert.equal(mmRef.length, 4);
  assert.equal(mmRef[1].role, 'reference_image');
  assert.equal(mmRef[3].content, refs[2]);
  // volcano i2v_first → image_url.url 嵌套
  assert.deepEqual(buildVideoContent([refs[0]], 'i2v_first', 'p', 'volcano'), [
    { type: 'text', text: 'p' },
    { type: 'image_url', role: 'first_frame', image_url: { url: refs[0] } },
  ]);
  // volcano 单图但未显式 mode → 同样走 first_frame
  const vSingle = buildVideoContent([refs[0]], null, 'p', 'volcano');
  assert.equal(vSingle[1].role, 'first_frame');
  // i2v_first_last 只有 1 图 → 退化为 first_frame（不越界）
  const mmShort = buildVideoContent([refs[0]], 'i2v_first_last', 'p', 'minimax');
  assert.equal(mmShort.length, 2);
  assert.equal(mmShort[1].role, 'first_frame');
  // 未知 providerKey → volcano 词汇（默认分支）
  assert.equal(buildVideoContent([], 't2v', 'p', '???') [0].text, 'p');
});

// ─── HTTP：callEndpoint POST/GET/DELETE ─────────────────────────
test('callEndpoint: POST 拼 base+path、JSON body、Bearer、响应 JSON 解析', async () => {
  const stub = seqFetch([jsonRes(200, { ok: 1 })]);
  const restore = installFetch(stub);
  try {
    const r = await callEndpoint('https://api.test.com/v1', { path: '/videos', method: 'POST' }, 'sk-1', { prompt: 'hi', n: 2 });
    assert.deepEqual(r, { status: 200, body: { ok: 1 } });
    const [call] = stub.calls();
    assert.equal(call.url, 'https://api.test.com/v1/videos');
    assert.equal(call.opts.method, 'POST');
    assert.equal(call.opts.headers['Content-Type'], 'application/json');
    assert.equal(call.opts.headers.Authorization, 'Bearer sk-1');
    assert.equal(JSON.parse(call.opts.body).prompt, 'hi');
    assert.ok(call.opts.signal instanceof AbortSignal);
  } finally { restore(); }
});

test('callEndpoint: endpoint.baseUrl 优先于入参 baseUrl；path 无前导 / 自动补', async () => {
  const stub = seqFetch([jsonRes(200, {})]);
  const restore = installFetch(stub);
  try {
    await callEndpoint('https://a.com', { baseUrl: 'https://b.com/', path: 'jobs', method: 'POST' }, null, { x: 1 });
    assert.equal(stub.calls()[0].url, 'https://b.com/jobs');
    assert.equal(stub.calls()[0].opts.headers.Authorization, undefined); // 无 key 不加头
  } finally { restore(); }
});

test('callEndpoint: GET/DELETE 把 vars 拼成 query（滤掉空值）且不带 body', async () => {
  const stub = seqFetch([jsonRes(200, {}), jsonRes(200, {})]);
  const restore = installFetch(stub);
  try {
    await callEndpoint('https://a.com', { path: '/agnesapi', method: 'GET' }, 'sk', { video_id: 'v1', empty: '', nil: null, und: undefined });
    assert.equal(stub.calls()[0].url, 'https://a.com/agnesapi?video_id=v1');
    assert.equal(stub.calls()[0].opts.body, undefined);
    await callEndpoint('https://a.com', { path: '/t', method: 'DELETE' }, 'sk', { id: '9', junk: null });
    assert.equal(stub.calls()[1].url, 'https://a.com/t?id=9');
    assert.equal(stub.calls()[1].opts.method, 'DELETE');
  } finally { restore(); }
});

test('callEndpoint: 已有 ? 的 URL 追加用 &；非 JSON 文本 → body null', async () => {
  const stub = seqFetch([jsonRes(200, { a: 1 }), textRes(201, 'plain-not-json')]);
  const restore = installFetch(stub);
  try {
    await callEndpoint('https://a.com', { path: '/p?x=1', method: 'GET' }, null, { y: '2' });
    assert.equal(stub.calls()[0].url, 'https://a.com/p?x=1&y=2');
    const r2 = await callEndpoint('https://a.com', { path: '/raw', method: 'POST' }, null, {});
    assert.equal(r2.status, 201);
    assert.equal(r2.body, null);
  } finally { restore(); }
});

test('callEndpoint: bodyTemplate 占位替换优先于 JSON body', async () => {
  const stub = seqFetch([jsonRes(200, {})]);
  const restore = installFetch(stub);
  try {
    // 模板内 {{key}} 不带引号 —— fillTemplate 对字符串值会 JSON.stringify（含引号）
    await callEndpoint('https://a.com', { path: '/tpl', method: 'POST', bodyTemplate: '{"model":{{model}},"key":{{apiKey}}}' }, 'sk-9', { model: 'm1' });
    assert.equal(stub.calls()[0].opts.body, '{"model":"m1","key":"sk-9"}');
  } finally { restore(); }
});

test('callEndpoint: 60s AbortController 接线 —— 超时中止而非无限挂起', async () => {
  // fetch 永不 resolve，只监听 abort；超时后必须 reject（AbortError）
  const neverStub = async (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const restore = installFetch(neverStub);
  try {
    const p = withFastTimeout(() => callEndpoint('https://a.com', { path: '/slow', method: 'POST' }, null, { x: 1 }));
    await assert.rejects(p, { name: 'AbortError' });
  } finally { restore(); }
});

// ─── HTTP：fetchJson ────────────────────────────────────────────
test('fetchJson: 绝对 URL + 头合并 + 对象 body 序列化 + JSON 解析', async () => {
  const stub = seqFetch([jsonRes(200, { video_url: 'https://cdn/v.mp4' }), jsonRes(200, { task_id: 't1' }), jsonRes(200, { raw: true })]);
  const restore = installFetch(stub);
  try {
    const r = await fetchJson('https://api.x.com/tasks/1', { method: 'GET', headers: { 'X-Extra': '1' } });
    assert.equal(r.body.video_url, 'https://cdn/v.mp4');
    assert.equal(stub.calls()[0].url, 'https://api.x.com/tasks/1');
    assert.equal(stub.calls()[0].opts.headers['X-Extra'], '1');

    await fetchJson('https://api.x.com/gen', { method: 'POST', body: { prompt: 'p' } });
    assert.equal(JSON.parse(stub.calls()[1].opts.body).prompt, 'p');
    // 字符串 body 原样透传
    await fetchJson('https://api.x.com/s', { method: 'POST', body: '{"raw":true}' });
    assert.equal(stub.calls()[2].opts.body, '{"raw":true}');
  } finally { restore(); }
});

test('fetchJson: 60s AbortController 接线 —— 超时中止', async () => {
  const neverStub = async (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const restore = installFetch(neverStub);
  try {
    const p = withFastTimeout(() => fetchJson('https://a.com/slow'));
    await assert.rejects(p, { name: 'AbortError' });
  } finally { restore(); }
});

// ─── 轮询：pollLoop 重试/终态/取消/超时 ─────────────────────────
test('pollLoop: pending 重试至成功即停（不多打、不空等）', async () => {
  let polls = 0;
  const r = await pollLoop({
    intervalMs: 5, timeoutMs: 2000,
    pollFn: async () => {
      polls += 1;
      if (polls < 4) return { videoUrl: '', status: 'pending' };
      return { videoUrl: 'https://cdn/v.mp4', status: 'success' };
    },
  });
  assert.equal(r.status, 'success');
  assert.equal(r.videoUrl, 'https://cdn/v.mp4');
  assert.equal(polls, 4, '成功即终态返回，不应再多打一次');
});

test('pollLoop: 生成端 terminal failed / 瞬时 error 一次即终态返回（不重试空转）', async () => {
  let polls = 0;
  const r = await pollLoop({
    intervalMs: 5, timeoutMs: 2000,
    pollFn: async () => { polls += 1; return { videoUrl: '', status: 'failed', error: '生成失败' }; },
  });
  assert.equal(r.status, 'failed');
  assert.equal(polls, 1);

  polls = 0;
  const r2 = await pollLoop({
    intervalMs: 5, timeoutMs: 2000,
    pollFn: async () => { polls += 1; return { videoUrl: '', status: 'error', error: '网络抖动' }; },
  });
  assert.equal(r2.status, 'error');
  assert.equal(polls, 1);
});

test('pollLoop: pollFn 返回 timeout 视作继续等待（不判失败），后续成功仍归 success', async () => {
  let polls = 0;
  const r = await pollLoop({
    intervalMs: 5, timeoutMs: 2000,
    pollFn: async () => {
      polls += 1;
      if (polls === 1) return { videoUrl: '', status: 'timeout' };
      return { videoUrl: 'https://cdn/x.mp4', status: 'success' };
    },
  });
  assert.equal(r.status, 'success');
  assert.equal(polls, 2);
});

test('pollLoop: 超时（安全线）→ 返 timeout 非 error，绝不判失败', async () => {
  let polls = 0;
  const t0 = Date.now();
  const r = await pollLoop({
    intervalMs: 5, timeoutMs: 40,
    pollFn: async () => { polls += 1; return { videoUrl: '', status: 'pending' }; },
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 'timeout');
  assert.match(r.error, /90分钟/);
  assert.ok(elapsed >= 35, `应至少等到 deadline 附近（实际 ${elapsed}ms）`);
  assert.ok(polls >= 2, 'pending 期间持续重试');
});

test('pollLoop: pollFn 抛异常 → 瞬时 error（不透传 stack），且只打一次', async () => {
  let polls = 0;
  const r = await pollLoop({
    intervalMs: 5, timeoutMs: 500,
    pollFn: async () => { polls += 1; throw new Error('boom-network'); },
  });
  assert.equal(r.status, 'error');
  assert.match(r.error, /轮询异常：boom-network/);
  assert.equal(polls, 1);
});

test('pollLoop: 取消信号 —— sleep 前命中 → canceled 且 0 次出网', async () => {
  let polls = 0;
  const r = await pollLoop({
    intervalMs: 5, timeoutMs: 500,
    isCancelled: () => true,
    pollFn: async () => { polls += 1; return { videoUrl: '', status: 'pending' }; },
  });
  assert.equal(r.status, 'canceled');
  assert.equal(polls, 0);
});

test('pollLoop: 取消信号 —— sleep 后 / 拿到回复后命中同样中止', async () => {
  let polls = 0;
  // 第 2 次 poll 返回后立刻命中取消 → 2 次出网后 canceled
  const r = await pollLoop({
    intervalMs: 5, timeoutMs: 500,
    isCancelled: () => polls >= 2,
    pollFn: async () => { polls += 1; return { videoUrl: '', status: 'pending' }; },
  });
  assert.equal(r.status, 'canceled');
  assert.equal(polls, 2);
  assert.equal(r.error, '用户已取消');
});

test('pollLoop: startedAt 持久化语义（重启不重置密度计时基准，不抛错）', async () => {
  let polls = 0;
  const r = await pollLoop({
    intervalMs: 5, timeoutMs: 200, startedAt: Date.now() - 30_000, adaptive: true, // 30s 前：仍在基线区间，interval 不被拉疏
    pollFn: async () => { polls += 1; return { videoUrl: 'https://cdn/v.mp4', status: 'success' }; },
  });
  assert.equal(r.status, 'success');
  assert.equal(polls, 1);
});

// sleep 微冒烟：本文件轮询测试依赖它
test('sleep: 基础延时可用', async () => {
  const t0 = Date.now();
  await sleep(5);
  assert.ok(Date.now() - t0 >= 4);
});
