'use strict';
/**
 * 火山方舟 Seedance 视频适配器 —— 自测硬化（server/providers/video/volcano.cjs）
 *
 * 覆盖（fake transport，不打上游）：
 *   1. 请求体形状：model/upstream 回退、content[] 编码（text 用 text 字段 / image_url 嵌套 url）、
 *      resolution 档位映射、duration 秒单位 + Seedance 家族 [4,30]/[4,15]/[4,12]/[2,12] 规则与 -1 智能、
 *      ratio 规则（t2v 可选 / 2.5 图生强制 adaptive）
 *   2. 鉴权头 Authorization: Bearer <api_key>
 *   3. 上游非 2xx（400/429/500）makeError 归一（含 rateLimited）；200 但缺 id/带 error 业务错
 *   4. 成功路径 result 形状 { status:'submitted', taskId, providerTaskId, videoUrl:'' }
 *   5. 缺参拒：无 api_key 直接拒（不发请求）
 *   6. 网络错/超时归一：submit 阶段 fetch 抛错必须归一为 error 而非向上抛
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vc = require('./volcano.cjs');

const API_KEY = 'sk-test-volcano-0001';
const PROVIDER = { api_key: API_KEY, base_url: 'https://ark.cn-beijing.volces.com/api/v3/' };
const SUBMIT_URL = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';

const MODEL_25 = { model_id: 'doubao-seedance-2-5-pro-250815', upstreamModelName: 'doubao-seedance-2-5-pro-250815' };
const MODEL_20 = { model_id: 'doubao-seedance-2-0-lite-t2v-250415', upstreamModelName: 'x-seedance-2-0' };
const MODEL_15 = { model_id: 'doubao-seedance-1-5-pro-250528', upstreamModelName: 'y-seedance-1-5' };
const MODEL_10 = { model_id: 'doubao-seedance-1-0-pro-250428', upstreamModelName: 'z-seedance-1-0' };

// ── fake fetch 传输层 ──
function fakeFetch(responder) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const rec = {
      url: String(url),
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      body: init && init.body != null ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(rec);
    const out = await responder(rec);
    return { status: out.status, text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)) };
  };
  return {
    calls,
    restore() { global.fetch = orig; },
    last() { return calls[calls.length - 1]; },
  };
}
const respond = (status, body) => async () => ({ status, body });
const failWith = (err) => async () => { throw err; };

// ───────────────────────── 请求体形状 ─────────────────────────
test('volcano submit(t2v): wire body 形状 + URL + 鉴权头 + submitted result', async (t) => {
  const f = fakeFetch(respond(200, { id: 'ark-task-1' }));
  t.after(f.restore);
  const r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'cat on sofa', ratio: '16:9', resolution: '4k', durationSec: 10 });
  assert.equal(f.calls.length, 1);
  const c = f.last();
  assert.equal(c.url, SUBMIT_URL);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
  assert.deepEqual(c.body, {
    model: 'doubao-seedance-2-5-pro-250815',
    content: [{ type: 'text', text: 'cat on sofa' }],   // Volcano text 用 text 字段
    resolution: '4k',                                   // 枚举透传
    ratio: '16:9',
    duration: 10,                                       // 秒
  });
  assert.deepEqual(r, { status: 'submitted', taskId: 'ark-task-1', providerTaskId: 'ark-task-1', videoUrl: '' });
});

test('volcano submit: response 在 data.id → 同样 submitted', async (t) => {
  const f = fakeFetch(respond(200, { data: { id: 'ark-d-2' } }));
  t.after(f.restore);
  const r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9' });
  assert.deepEqual(r, { status: 'submitted', taskId: 'ark-d-2', providerTaskId: 'ark-d-2', videoUrl: '' });
});

test('volcano submit: upstreamModelName 缺失时 wire model 回退 model_id', async (t) => {
  const f = fakeFetch(respond(200, { id: 't1' }));
  t.after(f.restore);
  const r = await vc.submit(PROVIDER, { model_id: 'doubao-seedance-2-5-pro' }, { prompt: 'p', ratio: '16:9' });
  assert.equal(f.last().body.model, 'doubao-seedance-2-5-pro');
  assert.equal(r.status, 'submitted');
});

test('volcano submit: base_url 缺省回落官方 /api/v3；尾斜杠剥除', async (t) => {
  const f = fakeFetch(respond(200, { id: 't1' }));
  t.after(f.restore);
  await vc.submit({ api_key: API_KEY }, MODEL_25, { prompt: 'p', ratio: '16:9' });
  assert.equal(f.last().url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
});

test('volcano submit: resolution 档位映射（抽象→枚举 / 枚举透传 / 未知回落 720p）', async (t) => {
  const cases = [
    [{ resolution: '1k' }, '480p'], [{ resolution: '2k' }, '720p'],
    [{ resolution: '3k' }, '1080p'], [{ resolution: '4k' }, '4k'], [{ resolution: '8k' }, '4k'],
    [{ resolution: '720p' }, '720p'], [{ resolution: '480p' }, '480p'],  // 枚举透传
    [{ resolution: 'weird' }, '720p'],                                   // 未知 → 720p
  ];
  for (const [opts, want] of cases) {
    const f = fakeFetch(respond(200, { id: 't1' }));
    await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9', ...opts });
    assert.equal(f.last().body.resolution, want, `resolution ${JSON.stringify(opts)}`);
    f.restore();
  }
});

test('volcano submit: Seedance 家族时长规则（-1 智能 / 显式夹取）', async (t) => {
  const cases = [
    // [model, durationSec, want]
    [MODEL_25, undefined, -1], [MODEL_25, -1, -1],        // 2.5：支持智能
    [MODEL_25, 45, 30], [MODEL_25, 3, 4],                 // 2.5: [4,30]
    [MODEL_20, -1, -1], [MODEL_20, 99, 15],               // 2.0: [4,15] 支持智能
    [MODEL_15, 3.6, 4], [MODEL_15, 12.5, 12],             // 1.5: [4,12] 四舍五入
    [MODEL_10, undefined, 12], [MODEL_10, -1, 12],        // 1.0: 不支持智能 → 回落 max
    [MODEL_10, 1, 2], [MODEL_10, 99, 12],                 // 1.0: [2,12]
    [{ model_id: 'unknown-seedance-v9' }, -1, -1],         // 未知家族 → 最宽松兜底(-1 智能)
  ];
  for (const [model, durationSec, want] of cases) {
    const f = fakeFetch(respond(200, { id: 't1' }));
    await vc.submit(PROVIDER, model, { prompt: 'p', ratio: '16:9', durationSec });
    assert.equal(f.last().body.duration, want, `family=${model.model_id} durationSec=${durationSec}`);
    f.restore();
  }
});

test('volcano submit(i2v_first): 参考帧嵌套 image_url.url + role=first_frame；2.5 图生 ratio 强制 adaptive', async (t) => {
  const f = fakeFetch(respond(200, { id: 't1' }));
  t.after(f.restore);
  await vc.submit(PROVIDER, MODEL_25, {
    prompt: 'zoom', referenceImages: ['https://img/a.png'], ratio: '16:9', durationSec: 5,
  });
  const b = f.last().body;
  assert.deepEqual(b.content, [
    { type: 'text', text: 'zoom' },
    { type: 'image_url', role: 'first_frame', image_url: { url: 'https://img/a.png' } },
  ]);
  assert.equal(b.ratio, 'adaptive'); // 2.5 图生仅支持 adaptive
});

test('volcano submit(i2v_first_last): 首尾帧双 role 按序；2.0 图生允许显式 ratio 透传', async (t) => {
  const f = fakeFetch(respond(200, { id: 't1' }));
  t.after(f.restore);
  await vc.submit(PROVIDER, MODEL_20, {
    prompt: 'p', referenceImages: ['https://img/f.png', 'https://img/l.png'],
    videoMode: 'i2v_first_last', ratio: '9:16',
  });
  const content = f.last().body.content;
  assert.deepEqual(content.slice(1), [
    { type: 'image_url', role: 'first_frame', image_url: { url: 'https://img/f.png' } },
    { type: 'image_url', role: 'last_frame', image_url: { url: 'https://img/l.png' } },
  ]);
  assert.equal(f.last().body.ratio, '9:16'); // 非 2.5 系列不强制 adaptive
});

test('volcano submit(reference_image): 多图每张 role=reference_image；缺省推导 + reference_image 缺省 ratio=adaptive', async (t) => {
  const f = fakeFetch(respond(200, { id: 't1' }));
  t.after(f.restore);
  await vc.submit(PROVIDER, MODEL_20, { prompt: 'p', referenceImages: ['u1', 'u2', 'u3'] });
  const b = f.last().body;
  assert.deepEqual(b.content.slice(1).map((x) => [x.role, x.image_url.url]),
    [['reference_image', 'u1'], ['reference_image', 'u2'], ['reference_image', 'u3']]);
  assert.equal(b.ratio, 'adaptive'); // 缺省：非 t2v → adaptive
});

// ───────────────────────── 缺参拒 ─────────────────────────
test('volcano submit: 缺 api_key 直接拒（error + 不发请求）', async (t) => {
  const f = fakeFetch(respond(200, { id: 'x' }));
  t.after(f.restore);
  const r = await vc.submit({}, MODEL_25, { prompt: 'p' });
  assert.equal(r.status, 'error');
  assert.equal(r.videoUrl, '');
  assert.match(r.error, /未配置 API Key/);
  assert.equal(f.calls.length, 0);
});

// ───────────────────────── 上游非 2xx / 业务错误码 归一 ─────────────────────────
test('volcano submit: HTTP 429 → makeError rateLimited=true', async (t) => {
  const f = fakeFetch(respond(429, { error: { message: 'Too Many Requests' } }));
  t.after(f.restore);
  const r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.equal(r.rateLimited, true);
  assert.equal(r.videoUrl, '');
  assert.deepEqual(r.images, []);
  assert.equal(r.error, '视频任务提交失败：Too Many Requests');
});

test('volcano submit: HTTP 400 error.message → 归一文案', async (t) => {
  const f = fakeFetch(respond(400, { error: { code: 'InvalidParameter', message: 'bad ratio' } }));
  t.after(f.restore);
  const r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: 'bad' });
  assert.equal(r.status, 'error');
  assert.equal(r.rateLimited, false);
  assert.equal(r.error, '视频任务提交失败：bad ratio');
});

test('volcano submit: HTTP 500 非 JSON body → 回落 HTTP 500', async (t) => {
  const f = fakeFetch(respond(500, 'internal server error!!'));
  t.after(f.restore);
  const r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.equal(r.error, '视频任务提交失败：HTTP 500');
});

test('volcano submit: 200 但无 id 且带 error/message → 未返回任务 ID + 上游文案', async (t) => {
  const f = fakeFetch(respond(200, { error: { code: 'QuotaExhausted', message: 'no quota left' } }));
  t.after(f.restore);
  const r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.equal(r.error, '未返回任务 ID：no quota left');
});

test('volcano submit: 200 空 body → 未返回任务 ID（回落 JSON 切片）', async (t) => {
  const f = fakeFetch(respond(200, {}));
  t.after(f.restore);
  const r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /^未返回任务 ID：/);
});

// ───────────────────────── 网络错 / 超时 归一（RED→修复点）─────────────────────────
test('volcano submit: 网络错 fetch 抛错 → 归一为 error（不得向上抛）', async (t) => {
  const f = fakeFetch(failWith(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })));
  t.after(f.restore);
  let caught;
  let r;
  try { r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9' }); } catch (e) { caught = e; }
  assert.equal(caught, undefined, 'submit 网络错必须归一，不得抛异常');
  assert.equal(r.status, 'error');
  assert.equal(r.videoUrl, '');
  assert.match(r.error, /提交|网络|fetch/i);
});

test('volcano submit: 上游超时(AbortError) → 归一为 error', async (t) => {
  const f = fakeFetch(failWith(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  t.after(f.restore);
  let caught;
  let r;
  try { r = await vc.submit(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9' }); } catch (e) { caught = e; }
  assert.equal(caught, undefined, 'submit 超时必须归一，不得抛异常');
  assert.equal(r.status, 'error');
  assert.match(r.error, /超时|abort|提交/i);
});

// ───────────────────────── submitAndPoll 短路 ─────────────────────────
test('volcano submitAndPoll: 提交即错 → 直接透传（不再轮询）', async (t) => {
  const f = fakeFetch(respond(403, { error: { message: 'forbidden' } }));
  t.after(f.restore);
  const r = await vc.submitAndPoll(PROVIDER, MODEL_25, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /forbidden/);
  assert.equal(f.calls.length, 1);
});

// ───────────────────────── poll 成功/终态/pending/异常/取消 ─────────────────────────
test('volcano poll: 成功 result 形状（data.status=succeeded + data.video_url）', async (t) => {
  const f = fakeFetch(respond(200, { data: { status: 'succeeded', video_url: 'https://arkcdn/v.mp4' } }));
  t.after(f.restore);
  const r = await vc.poll(PROVIDER, MODEL_25, 'ark-task-1');
  assert.equal(r.status, 'success');
  assert.equal(r.videoUrl, 'https://arkcdn/v.mp4');
  assert.equal(f.calls.length, 1);
  const c = f.last();
  assert.equal(c.url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/ark-task-1');
  assert.equal(c.method, 'GET');
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
});

test('volcano poll: root.status=succeeded + root.video_url 兜底路径', async (t) => {
  const f = fakeFetch(respond(200, { status: 'succeeded', video_url: 'https://arkcdn/r.mp4' }));
  t.after(f.restore);
  const r = await vc.poll(PROVIDER, MODEL_25, 'ark-task-1');
  assert.equal(r.status, 'success');
  assert.equal(r.videoUrl, 'https://arkcdn/r.mp4');
});

test('volcano poll: queued → 继续轮询 → succeeded（pending 非终态）', async (t) => {
  let n = 0;
  const f = fakeFetch(async () => {
    n += 1;
    if (n === 1) return { status: 200, body: { data: { status: 'queued' } } };
    return { status: 200, body: { data: { status: 'succeeded', video_url: 'https://arkcdn/q.mp4' } } };
  });
  t.after(f.restore);
  const r = await vc.poll(PROVIDER, MODEL_25, 'ark-task-1');
  assert.equal(r.status, 'success');
  assert.equal(r.videoUrl, 'https://arkcdn/q.mp4');
  assert.ok(n >= 2, 'queued 后应至少轮询两次');
});

test('volcano poll: 任务终态 failed → status failed + error（不吞、不空转）', async (t) => {
  const f = fakeFetch(respond(200, { data: { status: 'failed', error: { code: 'TaskFailed', message: 'generation died' } } }));
  t.after(f.restore);
  const r = await vc.poll(PROVIDER, MODEL_25, 'ark-task-1');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /视频生成失败/);
});

test('volcano poll: succeeded 但无 video_url → error', async (t) => {
  const f = fakeFetch(respond(200, { data: { status: 'succeeded' } }));
  t.after(f.restore);
  const r = await vc.poll(PROVIDER, MODEL_25, 'ark-task-1');
  assert.equal(r.status, 'error');
  assert.match(r.error, /任务成功但未返回 video_url/);
});

test('volcano poll: 网络错 → pollLoop 归一为 轮询异常 error', async (t) => {
  const f = fakeFetch(failWith(new TypeError('fetch failed')));
  t.after(f.restore);
  const r = await vc.poll(PROVIDER, MODEL_25, 'ark-task-1');
  assert.equal(r.status, 'error');
  assert.match(r.error, /轮询异常/);
});

test('volcano poll: 取消信号命中 → 立即 canceled，零请求零等待', async (t) => {
  const f = fakeFetch(respond(200, { data: { status: 'succeeded' } }));
  t.after(f.restore);
  const t0 = Date.now();
  const r = await vc.poll(PROVIDER, MODEL_25, 'ark-task-1', 0, () => true);
  assert.equal(r.status, 'canceled');
  assert.equal(f.calls.length, 0);
  assert.ok(Date.now() - t0 < 1000, '取消应即时返回');
});
