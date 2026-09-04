'use strict';
// G21 crash-recovery 死区叶：waiting/resume-image 卫拦修正 + review 处置面 + statusById 自动对账
// 覆盖（全部注入 fake pgPool / fake 上游钩子，零网络、零真实 DB）：
//   1. resumeWaitingArea：cr-only（无 provider_task_id，从未确认触达 provider）→ 重提成功（不再被误拦）
//   2. resumeWaitingArea：cr+provider_task_id（真提交）→ 无 statusById → review_required（error 注明处置端点）
//   3. resumeWaitingArea：cr+provider_task_id + statusById done → 自动对账补 result 终态（一次 commit，无双计费）
//   4. statusById failed → 释放 held + failed 终态；钩子异常 → 不冒险，维持 review
//   5. resumeRunningImageTasks：cr-only 行 → 重驱成功（reviewBlocked=0，不再误标）
//   6. image 适配层 queryById 能力面：三家同步适配器均 UNSUPPORTED（statusById 缺省 null = 上游不支持）
//   7. listReviewTasks：列队字段完整（cost/提交标记/可处置端点）
//   8. resolveReviewTask discard：释放 held 一次 + failed 终态（result 含 discarded）；非 review 态 → 409 不误释放
//   9. resolveReviewTask retry_new（waiting 源）：清 provider_task_id/client_request_id → 重入等待区
//  10. resolveReviewTask retry_new（图片源，无 waitingOpts）：清键 → 重驱
//  11. 参数校验：缺 taskId / 非法 action / 404 / 409
const test = require('node:test');
const assert = require('node:assert');
const { afterEach } = require('node:test');
const dispatcher = require('../../dispatcher.cjs');
const imageIndex = require('../../providers/image/index.cjs');
const billingMod = require('../../billing.cjs');
const accountingMod = require('../../accounting.cjs');
const uploadQueueMod = require('../../uploadQueue.cjs');
const realtimeMod = require('../../realtime.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── fake pgPool：规则匹配 SQL 子串 → 返回 rows；无命中返回 { rows: [] } ───
function makePool(rules) {
  const calls = [];
  const pool = {
    calls,
    query(sql, params) {
      const s = String(sql);
      calls.push({ sql: s, params });
      for (const rule of rules || []) {
        if (rule.match.test(s)) {
          const out = rule.rows;
          const rows = typeof out === 'function' ? (out(s, params, calls) || []) : (out || []);
          const rowCount = typeof rule.rowCount === 'function' ? rule.rowCount(s, params, calls) : rule.rowCount;
          return Promise.resolve({ rows, rowCount });
        }
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return pool;
}
const has = (pool, re) => pool.calls.some((c) => re.test(c.sql));
const lastMatch = (pool, re) => pool.calls.filter((c) => re.test(c.sql)).pop() || null;
// updateTaskStatus 用参数化 status（$2）→ 从 calls 里找 params[1] 为指定 status 的 UPDATE
const lastStatusUpdate = (pool, status) => pool.calls.filter((c) => /UPDATE generation_tasks SET status=\$2/.test(c.sql) && c.params && c.params[1] === status).pop() || null;

// ─── 模块桩（CJS 单例，运行时属性查找 → 可临时替换）───
const saved = {};
function stubAll(overrides) {
  const targets = [
    [billingMod, 'commitCredits'], [billingMod, 'releaseCredits'],
    [accountingMod, 'recordConsumption'],
    [uploadQueueMod, 'enqueueFinalize'], [uploadQueueMod, 'finalizeAndEmit'],
    [realtimeMod, 'emitTaskUpdate'],
  ];
  for (const [mod, name] of targets) {
    if (!(name in saved)) saved[name] = mod[name];
    mod[name] = overrides[name] || (async () => {});
  }
}
function restoreAll() {
  const targets = [
    [billingMod, 'commitCredits'], [billingMod, 'releaseCredits'],
    [accountingMod, 'recordConsumption'],
    [uploadQueueMod, 'enqueueFinalize'], [uploadQueueMod, 'finalizeAndEmit'],
    [realtimeMod, 'emitTaskUpdate'],
  ];
  for (const [mod, name] of targets) {
    if (name in saved) mod[name] = saved[name];
  }
}

function drainWaiting(...ids) {
  for (const id of ids) { try { dispatcher.dequeueWaiting(id); } catch (_) { /* 不在队列则忽略 */ } }
}

const WAIT_SELECT = /FROM generation_tasks[\s\S]*waitingOpts/;
const IMAGE_SELECT = /content_type='image'/;
const PROVIDER_SELECT = /FROM providers WHERE id=\$1/;
const MODEL_SELECT = /FROM models WHERE model_id=\$1 LIMIT 1/;
const TASK_SELECT = /FROM generation_tasks WHERE task_id=\$1/;

function waitingRow(over = {}) {
  const base = {
    task_id: 't-wait', model: 'm-img', model_id: 'm-img', prompt: '一只猫', count: 1,
    content_type: 'image', user_id: 'u1', cost: 5, cost_pool: 'recharge',
    idempotency_key: 'ik-1', client_request_id: 'cr-1', provider_id: null,
    provider_key: null, provider_task_id: null,
    resume_meta: {
      waitingOpts: {
        model: 'm-img', prompt: '一只猫', count: 1, contentType: 'image', user_id: 'u1',
        cost: 5, costPool: 'recharge', idempotencyKey: 'ik-1', userPlan: 'free', ratio: '1:1', resolution: '1k',
      },
      waitingState: { enqueueAt: Date.now() - 60000, lastAttempt: 0, attempts: 0 },
    },
  };
  return Object.assign(base, over);
}

test.afterEach(() => {
  dispatcher.setStatusByIdHook(null);
  restoreAll();
});

// ─── 1) waiting：cr-only 行 → 重提成功（不再误拦 review_required）───
test('resumeWaitingArea: cr-only（无 provider_task_id）→ 重入等待区，绝不标 review_required', async () => {
  const row2 = waitingRow({ task_id: 'wa-cr-only2', client_request_id: 'cr-only-2' });
  const pool2 = makePool([{ match: WAIT_SELECT, rows: [row2] }]);
  const r = await dispatcher.resumeWaitingArea(pool2);
  assert.strictEqual(r.resumed, 1);
  assert.strictEqual(r.reviewBlocked, 0);
  assert.ok(!has(pool2, /review_required/), 'cr-only 行不得写入 review_required');
  assert.ok(dispatcher.getWaitingAreaStatus().waitingAreaSize >= 1, '任务应重入等待区');
  drainWaiting('wa-cr-only2');
  await sleep(10);
});

// ─── 2) waiting：cr+provider_task_id + 无 statusById → review_required（error 注明处置端点）───
test('resumeWaitingArea: 真提交（provider_task_id）且无 statusById → review_required + error 注明处置端点', async () => {
  const row = waitingRow({
    task_id: 'wa-pt', provider_task_id: 'pt-9', client_request_id: 'cr-9',
    provider_id: 'provA', provider_key: 'agnes', model_id: 'm-img',
  });
  const pool = makePool([{ match: WAIT_SELECT, rows: [row] }]);
  dispatcher.setStatusByIdHook(null); // 缺省 = 上游不支持
  const r = await dispatcher.resumeWaitingArea(pool);
  assert.strictEqual(r.resumed, 0);
  assert.strictEqual(r.reviewBlocked, 1);
  const upd = lastMatch(pool, /review_required/);
  assert.ok(upd, '应写入 review_required');
  assert.ok(/provider_task_id/.test(upd.sql), 'error 应含 provider_task_id');
  const errParam = upd.params && upd.params[2];
  assert.ok(errParam && /\/api\/admin\/generate\/review/.test(errParam), 'error 应注明可处置端点');
  assert.strictEqual(dispatcher.getWaitingAreaStatus().waitingAreaSize, 0, '不得重入等待区');
});

// ─── 3) waiting：真提交 + statusById done → 自动对账补终态（一次 commit，无双计费）───
test('resumeWaitingArea: 真提交 + statusById done → 对账补 result（commit 一次，不重提、不 review）', async () => {
  const row = waitingRow({
    task_id: 'wa-done', provider_task_id: 'pt-done', client_request_id: 'cr-done',
    provider_id: 'provA', provider_key: 'agnes', model_id: 'm-img',
  });
  const commits = [];
  const enqueues = [];
  stubAll({
    commitCredits: async (pg, userId, amount, ref) => commits.push({ userId, amount, ref }),
    recordConsumption: async () => {},
    enqueueFinalize: async (pg, job) => enqueues.push(job),
    finalizeAndEmit: async () => {},
  });
  const pool = makePool([
    { match: WAIT_SELECT, rows: [row] },
    { match: PROVIDER_SELECT, rows: [{ id: 'provA', api_key: 'sk-x', enabled: true, base_url: 'https://a/v1' }] },
    { match: MODEL_SELECT, rows: [{ model_id: 'm-img', provider_id: 'provA', enabled: true }] },
  ]);
  dispatcher.setStatusByIdHook(async ({ providerTaskId }) => {
    assert.strictEqual(providerTaskId, 'pt-done');
    return { status: 'done', images: ['https://cdn/reconciled.png'], videoUrl: null };
  });
  const r = await dispatcher.resumeWaitingArea(pool);
  assert.strictEqual(r.resumed, 0);
  assert.strictEqual(r.reviewBlocked, 0);
  assert.ok(!has(pool, /review_required/), '对账成功不应再标 review_required');
  assert.strictEqual(commits.length, 1, '结算 commit 恰好一次（原 accept 只 reserve 一次，无双计费）');
  assert.strictEqual(enqueues.length, 1, '应入上传队列补资产终态');
  assert.deepStrictEqual(enqueues[0].providerImages, ['https://cdn/reconciled.png']);
  assert.strictEqual(enqueues[0].ctx.taskId, 'wa-done');
});

// ─── 4) statusById failed → 释放 held + failed 终态；钩子异常 → 不冒险留 review ───
test('reconcileSubmittedTask: statusById failed → 释放 held + failed 终态', async () => {
  const releases = [];
  const emits = [];
  stubAll({ releaseCredits: async (pg, userId, amount, ref) => releases.push({ userId, amount, ref }), emitTaskUpdate: async (u, ev) => emits.push(ev) });
  const row = waitingRow({
    task_id: 'wa-fail', provider_task_id: 'pt-fail', client_request_id: 'cr-fail',
    provider_id: 'provA', model_id: 'm-img', resume_meta: { waitingOpts: { model: 'm-img' } },
  });
  const pool = makePool([
    { match: PROVIDER_SELECT, rows: [{ id: 'provA', api_key: 'sk-x' }] },
    { match: MODEL_SELECT, rows: [{ model_id: 'm-img', provider_id: 'provA' }] },
  ]);
  dispatcher.setStatusByIdHook(async () => ({ status: 'failed', error: 'upstream rejected' }));
  const ok = await dispatcher.reconcileSubmittedTask(pool, row, { source: 'test' });
  assert.strictEqual(ok, true);
  assert.strictEqual(releases.length, 1);
  assert.deepStrictEqual(releases[0], { userId: 'u1', amount: 5, ref: 'ik-1' });
  const upd = lastStatusUpdate(pool, 'failed');
  assert.ok(upd, '任务应落 failed 终态（updateTaskStatus 参数化 status=failed）');
  assert.strictEqual(upd.params[0], 'wa-fail');
  assert.ok(emits.some((e) => e.status === 'failed'));
});

test('reconcileSubmittedTask: 钩子抛异常 → 返回 false（不冒险终态化，留给 review_required）', async () => {
  stubAll({});
  const row = waitingRow({ task_id: 'wa-ex', provider_task_id: 'pt-ex', provider_id: 'provA', model_id: 'm-img' });
  const pool = makePool([
    { match: PROVIDER_SELECT, rows: [{ id: 'provA', api_key: 'sk-x' }] },
    { match: MODEL_SELECT, rows: [{ model_id: 'm-img', provider_id: 'provA' }] },
  ]);
  dispatcher.setStatusByIdHook(async () => { throw new Error('boom'); });
  const ok = await dispatcher.reconcileSubmittedTask(pool, row, { source: 'test' });
  assert.strictEqual(ok, false);
  assert.strictEqual(lastStatusUpdate(pool, 'failed'), null, '异常时不得终态化');
});

// ─── 5) resume-image：cr-only 行 → 重驱成功（不再误标 review_required）───
test('resumeRunningImageTasks: cr-only 图片行 → 重驱（reviewBlocked=0，无 review_required 写入）', async () => {
  const row = {
    task_id: 'img-cr-only', model: 'm-img', model_id: 'm-img', prompt: 'p', count: 1,
    content_type: 'image', user_id: 'u1', cost: 3, cost_pool: 'recharge',
    idempotency_key: 'ik-img', pending_ids: [], client_meta: { ratio: '1:1', resolution: '1k' },
    created_at: new Date(Date.now() - 120000).toISOString(), client_request_id: 'cr-img',
    provider_id: null, provider_key: null, provider_task_id: null,
  };
  const pool = makePool([{ match: IMAGE_SELECT, rows: [row] }]);
  const r = await dispatcher.resumeRunningImageTasks(pool);
  assert.strictEqual(r.resumed, 1);
  assert.strictEqual(r.reviewBlocked, 0);
  assert.ok(!has(pool, /review_required/), 'cr-only 图片行不得被标 review_required');
  await sleep(50); // 等 fire-and-forget 重驱（fake generate 快速失败终态）跑完，避免悬空
});

// ─── 6) 图像适配层 queryById 能力面：三家同步适配器均 UNSUPPORTED ───
test('image index.queryById：agnes/gpt-image/openai-compat 均 UNSUPPORTED（statusById 缺省 = 上游不支持）', async () => {
  const providers = [
    { base_url: 'https://api.agnes-ai.cn/v1' },  // → agnes
    { base_url: 'https://openai.example.com/v1' },
  ];
  // gpt-image：upstream 名含 gpt-image
  for (const [provider, model] of [
    [providers[0], { model_id: 'm', upstreamModelName: 'gpt-x' }],
    [providers[1], { model_id: 'm', upstreamModelName: 'gpt-image-1' }],
    [providers[1], { model_id: 'm', upstreamModelName: 'dall-e-3' }],
  ]) {
    const out = await imageIndex.queryById({ provider, model, providerTaskId: 'pt-x', clientRequestId: 'cr-x' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'UNSUPPORTED');
  }
  assert.strictEqual(dispatcher.getStatusByIdHook(), null, '无适配器支持 → dispatcher 钩子缺省 null');
});

// ─── 7) listReviewTasks ───
test('listReviewTasks: 列队字段完整（cost/提交标记/端点）', async () => {
  const pool = makePool([
    {
      match: /status='review_required'/,
      rows: [{
        task_id: 'rv-1', model: 'm-img', model_id: 'm-img', content_type: 'image', user_id: 'u1',
        cost: 5, cost_pool: 'recharge', idempotency_key: 'ik-1', client_request_id: 'cr-1',
        provider_task_id: 'pt-1', provider_id: 'provA', provider_key: 'agnes',
        prompt: 'p', error: 'crash…', created_at: '2026-09-04T01:00:00Z', updated_at: '2026-09-04T01:00:00Z',
        resume_meta: { waitingOpts: { model: 'm-img' } },
      }],
    },
  ]);
  const out = await dispatcher.listReviewTasks(pool);
  assert.strictEqual(out.tasks.length, 1);
  assert.strictEqual(out.endpoint, '/api/admin/generate/review');
  assert.strictEqual(out.resolveEndpoint, '/api/admin/generate/review/resolve');
  const t = out.tasks[0];
  assert.strictEqual(t.taskId, 'rv-1');
  assert.strictEqual(t.providerTaskId, 'pt-1');
  assert.strictEqual(t.cost, 5);
  assert.strictEqual(t.costPool, 'recharge');
  assert.strictEqual(t.idempotencyKey, 'ik-1');
  assert.strictEqual(t.hasWaitingOpts, true);
});

// ─── 8) resolveReviewTask discard ───
function reviewRow(over = {}) {
  return Object.assign({
    task_id: 'rv-discard', status: 'review_required', model: 'm-img', model_id: 'm-img',
    prompt: 'p', count: 1, content_type: 'image', user_id: 'u1', cost: 5, cost_pool: 'recharge',
    idempotency_key: 'ik-1', pending_ids: [], client_meta: {}, client_request_id: 'cr-1',
    provider_task_id: 'pt-1', resume_meta: null,
  }, over);
}

test('resolveReviewTask discard: CAS 抢占终态 → 释放 held 一次 + failed 终态（result 含 discarded）', async () => {
  const releases = [];
  const emits = [];
  stubAll({ releaseCredits: async (pg, userId, amount, ref) => releases.push({ userId, amount, ref }), emitTaskUpdate: async (u, ev) => emits.push(ev) });
  let status = 'review_required';
  const pool = makePool([
    { match: TASK_SELECT, rows: () => [reviewRow({ status })] },
    // CAS 抢占 UPDATE：状态仍 review_required → rowCount 1；已被移出 → rowCount 0
    { match: /UPDATE generation_tasks[\s\S]*status='failed'[\s\S]*status='review_required'/, rows: [], rowCount: () => (status === 'review_required' ? 1 : 0) },
  ]);
  const r = await dispatcher.resolveReviewTask(pool, { taskId: 'rv-discard', action: 'discard', reason: '上游确认计费异常', actor: 'admin-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action, 'discard');
  assert.deepStrictEqual(releases, [{ userId: 'u1', amount: 5, ref: 'ik-1' }]);
  const upd = lastMatch(pool, /UPDATE generation_tasks[\s\S]*status='failed'/);
  assert.ok(upd, '应 CAS 写 failed 终态');
  assert.strictEqual(upd.params[0], 'rv-discard');
  const parsed = JSON.parse(upd.params[1]);
  assert.strictEqual(parsed.discarded, true);
  assert.strictEqual(parsed.action, 'discard');
  assert.ok(/人工处置 discard/.test(upd.params[2]));
  assert.ok(emits.some((e) => e.status === 'failed'));
  // 幂等护栏：非 review_required 的任务再次处置 → 409，绝不二次释放
  status = 'failed';
  const again = await dispatcher.resolveReviewTask(pool, { taskId: 'rv-discard', action: 'discard' });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 409);
  assert.strictEqual(releases.length, 1, '不得二次释放 held');
});

test('resolveReviewTask discard: CAS 0 行（已被并发 retry_new 移出 review_required）→ 409 且绝不退款', async () => {
  const releases = [];
  stubAll({ releaseCredits: async (pg, userId, amount, ref) => releases.push({ userId, amount, ref }) });
  // SELECT 仍读到 review_required，但抢占 UPDATE 返回 0 行 = 并发 retry_new 已抢先转 running 重排队
  const pool = makePool([
    { match: TASK_SELECT, rows: [reviewRow({ status: 'review_required' })] },
    { match: /UPDATE generation_tasks[\s\S]*status='failed'/, rows: [], rowCount: 0 },
  ]);
  const r = await dispatcher.resolveReviewTask(pool, { taskId: 'rv-discard', action: 'discard', reason: 'x', actor: 'admin-2' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 409);
  assert.strictEqual(releases.length, 0, 'CAS 0 行 = 已被并发处置移出，绝不退款（防 retry_new 重排队后又被退款）');
});

// ─── 9) resolveReviewTask retry_new（waiting 源：清键后重入等待区）───
test('resolveReviewTask retry_new: 清 provider_task_id/client_request_id → 重入等待区（不释放积分）', async () => {
  const releases = [];
  stubAll({ releaseCredits: async (pg, userId, amount, ref) => releases.push({ userId, amount, ref }) });
  const pool = makePool([
    {
      match: TASK_SELECT,
      rows: [reviewRow({ resume_meta: { waitingOpts: { model: 'm-img', prompt: 'p', contentType: 'image', user_id: 'u1', cost: 5, costPool: 'recharge', idempotencyKey: 'ik-1' }, waitingState: { attempts: 0 } } })],
    },
  ]);
  const r = await dispatcher.resolveReviewTask(pool, { taskId: 'rv-discard', action: 'retry_new', reason: '运营商核实未计费' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.requeued, true);
  const reset = lastMatch(pool, /provider_task_id=NULL/);
  assert.ok(reset, '应清真提交标记（provider_task_id=NULL）');
  assert.ok(!/client_request_id=NULL/.test(reset.sql), 'client_request_id 保留（稳定幂等痕迹，不清不换）');
  assert.ok(/status='running'/.test(reset.sql));
  assert.strictEqual(releases.length, 0, 'retry_new 不释放积分');
  assert.ok(dispatcher.getWaitingAreaStatus().waitingAreaSize >= 1, '任务应重入等待区');
  drainWaiting('rv-discard');
  await sleep(10);
});

// ─── 10) resolveReviewTask retry_new（图片源，无 waitingOpts：清键后重驱）───
test('resolveReviewTask retry_new: 图片任务无 waitingOpts → 清键后重驱（redriven）', async () => {
  stubAll({});
  const pool = makePool([
    {
      match: TASK_SELECT,
      rows: [reviewRow({ task_id: 'rv-img', content_type: 'image', resume_meta: null, client_meta: { ratio: '1:1', resolution: '1k' } })],
    },
  ]);
  const r = await dispatcher.resolveReviewTask(pool, { taskId: 'rv-img', action: 'retry_new', reason: 'x' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.redriven, true);
  const reset = lastMatch(pool, /provider_task_id=NULL/);
  assert.ok(reset, '应清提交标记');
  await sleep(50); // fire-and-forget 重驱（fake 无 pairs → 快速 failed 终态）
});

// ─── 11) 参数校验 / 404 / 非 review 态 409 ───
test('resolveReviewTask: 缺 taskId / 非法 action / 404 / 非 review 态 → 合理拒', async () => {
  stubAll({});
  const pool = makePool([]);
  assert.strictEqual((await dispatcher.resolveReviewTask(pool, { action: 'discard' })).code, 400);
  assert.strictEqual((await dispatcher.resolveReviewTask(pool, { taskId: 'x', action: 'refund' })).code, 400);
  assert.strictEqual((await dispatcher.resolveReviewTask(pool, { taskId: 'nope', action: 'discard' })).code, 404);
  const pool2 = makePool([{ match: TASK_SELECT, rows: [reviewRow({ status: 'done' })] }]);
  const r = await dispatcher.resolveReviewTask(pool2, { taskId: 'rv-done', action: 'discard' });
  assert.strictEqual(r.code, 409);
  assert.strictEqual(r.ok, false);
});
