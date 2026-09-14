'use strict';
/**
 * MiniMax H3 视频 V2 适配器 —— 自测硬化（server/providers/video/minimax.cjs）
 *
 * 覆盖（fake transport，不打上游）：
 *   1. 请求体形状：model/upstream 回退、content[] 编码（text/image_url+role+content:url 平铺）、
 *      resolution 档位映射、duration 秒单位夹取、ratio（文生必填非 adaptive / 图生强制 adaptive）
 *   2. 鉴权头：Authorization: Bearer <api_key>（POST 与 GET poll 同）
 *   3. 上游非 2xx（400/429/500）→ makeError 归一（含 rateLimited）；业务错误码 base_resp.status_code
 *   4. 成功路径 result 形状：{ status:'submitted', taskId, providerTaskId, videoUrl:'' }
 *      （与 video/index + dispatcher.videoGenerate 消费约定一致）
 *   5. 缺参拒：无 api_key 直接拒（不发请求）
 *   6. 网络错/超时归一：submit 阶段 fetch 抛错必须归一为 error 而非向上抛
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mm = require('./minimax.cjs');

const API_KEY = 'sk-test-minimax-0001';
const PROVIDER = { api_key: API_KEY, base_url: 'https://api.minimaxi.com/v2/' };
const MODEL = { model_id: 'hailuo-03-minimax-video-01', upstreamModelName: 'minimax-video-01-hailuo-03' };
const SUBMIT_URL = 'https://api.minimaxi.com/v2/video_generation';

// ── fake fetch 传输层：记录 (url, headers, body)，返回 canned 响应 ──
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
test('minimax submit(t2v): wire body 形状 + URL + 鉴权头 + submitted result', async (t) => {
  const f = fakeFetch(respond(200, { task_id: ' mm-123 ', base_resp: { status_code: 0, status_msg: '' } }));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, MODEL, { prompt: '海浪拍岸', ratio: '16:9', resolution: '2k', durationSec: 6 });
  assert.equal(f.calls.length, 1);
  const c = f.last();
  assert.equal(c.url, SUBMIT_URL);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
  // content[]：text 用 { type:'text', content:prompt }；顶层 resolution/duration/ratio 单位与取值
  assert.deepEqual(c.body, {
    model: 'minimax-video-01-hailuo-03',
    content: [{ type: 'text', content: '海浪拍岸' }],
    resolution: '768P',        // 抽象档 2k → MiniMax 768P
    duration: 6,               // 整数秒
    ratio: '16:9',
  });
  assert.deepEqual(r, { status: 'submitted', taskId: 'mm-123', providerTaskId: 'mm-123', videoUrl: '' });
});

test('minimax submit: upstreamModelName 缺失时 wire model 回退 model_id', async (t) => {
  const f = fakeFetch(respond(200, { task_id: 't9', base_resp: { status_code: 0 } }));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, { model_id: 'hailuo-mini' }, { prompt: 'p', ratio: '16:9' });
  assert.equal(f.last().body.model, 'hailuo-mini');
  assert.equal(r.status, 'submitted');
});

test('minimax submit: base_url 缺省回落官方 /v2；尾斜杠剥除', async (t) => {
  const f = fakeFetch(respond(200, { task_id: 't1', base_resp: { status_code: 0 } }));
  t.after(f.restore);
  await mm.submit({ api_key: API_KEY }, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.equal(f.last().url, 'https://api.minimaxi.com/v2/video_generation');
});

test('minimax submit: resolution 档位映射（抽象→枚举 / 枚举透传 / 未知回落）', async (t) => {
  const cases = [
    [{ resolution: '1k' }, '768P'], [{ resolution: '2k' }, '768P'],
    [{ resolution: '3k' }, '2K'], [{ resolution: '4k' }, '2K'], [{ resolution: '8k' }, '2K'],
    [{ resolution: '2K' }, '2K'],                                    // 已是 MiniMax 枚举 → 透传
    [{ resolution: '768P' }, '768P'],                                // 已是枚举 → 透传
    [{}, '768P'],                                                    // 未传 → 抽象 1k → 768P
    [{ resolution: 'weird' }, '768P'],                               // 未知 → 回落 768P
  ];
  for (const [opts, want] of cases) {
    const f = fakeFetch(respond(200, { task_id: 't1', base_resp: { status_code: 0 } }));
    await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9', ...opts });
    assert.equal(f.last().body.resolution, want, `resolution ${JSON.stringify(opts)}`);
    f.restore();
  }
});

test('minimax submit: duration 秒单位整数 + [4,15] 夹取（浮点四舍五入、越界夹、缺省 6）', async (t) => {
  const cases = [
    [{ durationSec: 6 }, 6], [{ durationSec: 7.6 }, 8], [{ durationSec: 100 }, 15],
    [{ durationSec: -5 }, 4], [{ durationSec: 1 }, 4], [{ durationSec: 0 }, 6],
    [{ durationSec: '12.4' }, 12], [{}, 6],
  ];
  for (const [opts, want] of cases) {
    const f = fakeFetch(respond(200, { task_id: 't1', base_resp: { status_code: 0 } }));
    await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9', ...opts });
    assert.equal(f.last().body.duration, want, `durationSec ${JSON.stringify(opts)}`);
    f.restore();
  }
});

test('minimax submit(i2v_first): 参考帧 role=first_frame + content 平铺 url；ratio 强制 adaptive', async (t) => {
  const f = fakeFetch(respond(200, { task_id: 't1', base_resp: { status_code: 0 } }));
  t.after(f.restore);
  await mm.submit(PROVIDER, MODEL, {
    prompt: '放大', referenceImages: ['https://img/a.png'], resolution: '2K', ratio: '16:9', durationSec: 5,
  });
  const b = f.last().body;
  assert.deepEqual(b.content, [
    { type: 'text', content: '放大' },
    { type: 'image_url', role: 'first_frame', content: 'https://img/a.png' },
  ]);
  assert.equal(b.ratio, 'adaptive'); // 图生恒 adaptive，忽略用户 16:9
  assert.equal(b.resolution, '2K');  // 枚举透传
  assert.equal(b.duration, 5);
});

test('minimax submit(i2v_first_last): 首尾帧双 role，按序 first→last', async (t) => {
  const f = fakeFetch(respond(200, { task_id: 't1', base_resp: { status_code: 0 } }));
  t.after(f.restore);
  await mm.submit(PROVIDER, MODEL, {
    prompt: 'p', referenceImages: ['https://img/f.png', 'https://img/l.png'],
    videoMode: 'i2v_first_last', ratio: '16:9',
  });
  const content = f.last().body.content;
  assert.deepEqual(content.slice(1), [
    { type: 'image_url', role: 'first_frame', content: 'https://img/f.png' },
    { type: 'image_url', role: 'last_frame', content: 'https://img/l.png' },
  ]);
  assert.equal(f.last().body.ratio, 'adaptive');
});

test('minimax submit(reference_image): 多图每张 role=reference_image；videoMode 缺省由 refs 数推导', async (t) => {
  // videoMode 缺省：3 张 → reference_image
  let f = fakeFetch(respond(200, { task_id: 't1', base_resp: { status_code: 0 } }));
  await mm.submit(PROVIDER, MODEL, { prompt: 'p', referenceImages: ['u1', 'u2', 'u3'], ratio: '16:9' });
  const content = f.last().body.content;
  assert.deepEqual(content.slice(1).map((x) => [x.role, x.content]),
    [['reference_image', 'u1'], ['reference_image', 'u2'], ['reference_image', 'u3']]);
  assert.equal(content[0].type, 'text');
  f.restore();
  // 1 张缺省 → i2v_first
  f = fakeFetch(respond(200, { task_id: 't1', base_resp: { status_code: 0 } }));
  await mm.submit(PROVIDER, MODEL, { prompt: 'p', referenceImages: ['u1'], ratio: '16:9' });
  assert.equal(f.last().body.content[1].role, 'first_frame');
  f.restore();
});

// ───────────────────────── 成功 result 形状约定 ─────────────────────────
test('minimax submit: base_resp.status_code=1000 亦视为成功', async (t) => {
  const f = fakeFetch(respond(200, { task_id: 't-ok', base_resp: { status_code: 1000 } }));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.deepEqual(r, { status: 'submitted', taskId: 't-ok', providerTaskId: 't-ok', videoUrl: '' });
});

// ───────────────────────── 缺参拒 ─────────────────────────
test('minimax submit: 缺 api_key 直接拒（error + 不发请求）', async (t) => {
  const f = fakeFetch(respond(200, { task_id: 'x' }));
  t.after(f.restore);
  const r = await mm.submit({}, MODEL, { prompt: 'p' });
  assert.equal(r.status, 'error');
  assert.equal(r.videoUrl, '');
  assert.match(r.error, /未配置 API Key/);
  assert.equal(f.calls.length, 0);
});

// ───────────────────────── 上游非 2xx / 业务错误码 归一 ─────────────────────────
test('minimax submit: HTTP 429 → makeError rateLimited=true', async (t) => {
  const f = fakeFetch(respond(429, { error: { message: 'rate limited' } }));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.equal(r.rateLimited, true);
  assert.equal(r.videoUrl, '');
  assert.deepEqual(r.images, []);
  assert.equal(r.error, '视频任务提交失败：rate limited');
});

test('minimax submit: HTTP 400 body.message → error 文案', async (t) => {
  const f = fakeFetch(respond(400, { message: 'bad request body' }));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.equal(r.rateLimited, false);
  assert.equal(r.error, '视频任务提交失败：bad request body');
});

test('minimax submit: HTTP 500 非 JSON body → 回落 HTTP 500', async (t) => {
  const f = fakeFetch(respond(500, 'upstream gateway exploded'));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.equal(r.error, '视频任务提交失败：HTTP 500');
});

test('minimax submit: 200 但业务错误码 base_resp.status_code≠0/1000 → 提交失败', async (t) => {
  const f = fakeFetch(respond(200, { base_resp: { status_code: 1001, status_msg: 'prompt too long' } }));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.equal(r.error, '提交失败：prompt too long');
});

test('minimax submit: 200 无 task_id → 未返回任务 ID（含响应体切片）', async (t) => {
  const f = fakeFetch(respond(200, { weird: true }));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /^未返回任务 ID：/);
});

test('minimax submit: 200 业务失败但无 status_msg → 回落 JSON 切片', async (t) => {
  const f = fakeFetch(respond(200, { base_resp: { status_code: 40001 } }));
  t.after(f.restore);
  const r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /^提交失败：/);
});

// ───────────────────────── 网络错 / 超时 归一（RED→修复点）─────────────────────────
test('minimax submit: 网络错 fetch 抛错 → 归一为 error（不得向上抛）', async (t) => {
  const f = fakeFetch(failWith(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') })));
  t.after(f.restore);
  let caught;
  let r;
  try { r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' }); } catch (e) { caught = e; }
  assert.equal(caught, undefined, 'submit 网络错必须归一，不得抛异常');
  assert.equal(r.status, 'error');
  assert.equal(r.videoUrl, '');
  assert.match(r.error, /提交|网络|fetch/i);
});

test('minimax submit: 上游超时(AbortError) → 归一为 error', async (t) => {
  const f = fakeFetch(failWith(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  t.after(f.restore);
  let caught;
  let r;
  try { r = await mm.submit(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' }); } catch (e) { caught = e; }
  assert.equal(caught, undefined, 'submit 超时必须归一，不得抛异常');
  assert.equal(r.status, 'error');
  assert.match(r.error, /超时|abort|提交/i);
});

// ───────────────────────── submitAndPoll 短路 ─────────────────────────
test('minimax submitAndPoll: 提交即错 → 直接透传（不再轮询）', async (t) => {
  const f = fakeFetch(respond(401, { error: { message: 'unauthorized' } }));
  t.after(f.restore);
  const r = await mm.submitAndPoll(PROVIDER, MODEL, { prompt: 'p', ratio: '16:9' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /unauthorized/);
  assert.equal(f.calls.length, 1); // 只有 POST，无 poll GET
});

// ───────────────────────── poll 成功/终态/异常/取消 ─────────────────────────
test('minimax poll: 成功 result 形状 {status:success, videoUrl}（task.content.url）', async (t) => {
  const f = fakeFetch(respond(200, { task: { status: 'Success', content: { url: 'https://cdn.mm/v.mp4' } } }));
  t.after(f.restore);
  const r = await mm.poll(PROVIDER, MODEL, 'mm-abc');
  assert.equal(r.status, 'success');
  assert.equal(r.videoUrl, 'https://cdn.mm/v.mp4');
  assert.equal(f.calls.length, 1);
  const c = f.last();
  assert.equal(c.url, 'https://api.minimaxi.com/v2/query/video_generation/mm-abc');
  assert.equal(c.method, 'GET');
  assert.equal(c.headers['Authorization'], `Bearer ${API_KEY}`);
});

test('minimax poll: 任务终态失败 → status failed + error（轮询侧 definitive 终态）', async (t) => {
  const f = fakeFetch(respond(200, { task: { status: 'Failed', error_info: 'model crashed' } }));
  t.after(f.restore);
  const r = await mm.poll(PROVIDER, MODEL, 'mm-abc');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /视频生成失败/);
});

test('minimax poll: 成功但无 URL → error（不吞）', async (t) => {
  const f = fakeFetch(respond(200, { task: { status: 'Success', content: {} } }));
  t.after(f.restore);
  const r = await mm.poll(PROVIDER, MODEL, 'mm-abc');
  assert.equal(r.status, 'error');
  assert.match(r.error, /任务成功但未返回视频 URL/);
});

test('minimax poll: 网络错 → pollLoop 归一为 轮询异常 error', async (t) => {
  const f = fakeFetch(failWith(new TypeError('fetch failed')));
  t.after(f.restore);
  const r = await mm.poll(PROVIDER, MODEL, 'mm-abc');
  assert.equal(r.status, 'error');
  assert.match(r.error, /轮询异常/);
});

test('minimax poll: 取消信号命中 → 立即 canceled，零请求零等待', async (t) => {
  const f = fakeFetch(respond(200, { task: { status: 'Success', content: { url: 'u' } } }));
  t.after(f.restore);
  const t0 = Date.now();
  const r = await mm.poll(PROVIDER, MODEL, 'mm-abc', 0, () => true);
  assert.equal(r.status, 'canceled');
  assert.equal(f.calls.length, 0);
  assert.ok(Date.now() - t0 < 1000, '取消应即时返回');
});
