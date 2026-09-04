'use strict';
// L11 Outbox 接线（legacy 分发）：事务内写 generation_outbox_v2 + relay 消费/recovery + kill-switch 回退
// 全 fake pgPool（零真实 DB、零网络），覆盖：
//   1. enqueueGenerationOutbox：有 connect → BEGIN/INSERT task(含 client_request_id)/INSERT outbox/COMMIT 事务原子
//   2. enqueueGenerationOutbox：无 connect → 顺序双写回退（无 BEGIN）
//   3. generateAsync 默认：写 outbox（task INSERT 内联 client_request_id；payload 含稳定标识 + 回填字段）
//   4. generateAsync kill-switch LEGACY_FIRE_FORGET=1：不写 outbox，退回旧 UPDATE client_request_id
//   5. relay recovery：DB 成功 + queue 失败 → 恢复后 provider 只提交一次（同 client_request_id 幂等）
//   6. dispatchFromOutbox 护栏：already_submitted / terminal_status → skip（不重提）
const test = require('node:test');
const assert = require('node:assert/strict');
const dispatcher = require('../../dispatcher.cjs');
const billingMod = require('../../billing.cjs');
const accountingMod = require('../../accounting.cjs');
const uploadQueueMod = require('../../uploadQueue.cjs');
const realtimeMod = require('../../realtime.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── fake pgPool：规则匹配 SQL 子串；可注入 connect()（事务型 client）───
function makePool(rules = [], opts = {}) {
  const calls = [];
  const pool = {
    calls,
    query(sql, params) {
      const s = String(sql);
      calls.push({ sql: s, params });
      for (const rule of rules) {
        if (rule.match.test(s)) {
          const rows = typeof rule.rows === 'function' ? (rule.rows(s, params, calls) || []) : (rule.rows || []);
          const rowCount = typeof rule.rowCount === 'function' ? rule.rowCount(s, params, calls) : rule.rowCount;
          return Promise.resolve({ rows, rowCount });
        }
      }
      return Promise.resolve({ rows: [] });
    },
  };
  if (opts.connect) {
    pool.connect = async () => ({
      query(sql, params) { return pool.query(sql, params); },
      release() {},
    });
  }
  return pool;
}
const has = (pool, re) => pool.calls.some((c) => re.test(c.sql));
const lastMatch = (pool, re) => pool.calls.filter((c) => re.test(c.sql)).pop() || null;

// ─── 模块桩（CJS 单例，运行时属性替换）───
const saved = {};
function stubAll(overrides = {}) {
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
test.afterEach(() => {
  restoreAll();
  delete process.env.LEGACY_FIRE_FORGET;
});

// ─── 1) enqueueGenerationOutbox 事务原子（有 connect）───
test('enqueueGenerationOutbox：有 connect → BEGIN/INSERT task/INSERT outbox/COMMIT 事务原子，payload 含稳定标识+回填字段', async () => {
  const pool = makePool([], { connect: true });
  const enq = {
    taskId: 't1', clientRequestId: 'cr-1', displayModel: 'm', canonicalModelId: 'm-img',
    prompt: '一只猫', count: 1, contentType: 'image', pendingIds: [], clientMeta: {},
    user_id: 'u1', idempotencyKey: 'ik-1', cost: 5, costPool: 'recharge',
    runOpts: { taskId: 't1', clientRequestId: 'cr-1', onSubmitted: () => {}, user_id: 'u1', model: 'm-img', prompt: '一只猫' },
  };
  const r = await dispatcher.enqueueGenerationOutbox(pool, enq);
  assert.strictEqual(r.transactional, true);
  assert.strictEqual(r.taskId, 't1');
  assert.strictEqual(r.clientRequestId, 'cr-1');
  const seq = pool.calls
    .map((c) => /^BEGIN$/.test(c.sql.trim()) ? 'BEGIN'
      : /^COMMIT$/.test(c.sql.trim()) ? 'COMMIT'
      : /INSERT INTO generation_tasks/.test(c.sql) ? 'TASK'
      : /INSERT INTO generation_outbox_v2/.test(c.sql) ? 'OUTBOX'
      : 'OTHER')
    .filter((x) => x !== 'OTHER');
  assert.deepStrictEqual(seq, ['BEGIN', 'TASK', 'OUTBOX', 'COMMIT']);
  // task INSERT 含 client_request_id（第 13 参）
  const ins = pool.calls.find((c) => /INSERT INTO generation_tasks/.test(c.sql));
  assert.strictEqual(ins.params[12], 'cr-1');
  // outbox payload
  const ob = pool.calls.find((c) => /INSERT INTO generation_outbox_v2/.test(c.sql));
  assert.strictEqual(ob.params[0], 't1');
  const payload = JSON.parse(ob.params[1]);
  assert.strictEqual(payload.client_request_id, 'cr-1');
  assert.strictEqual(payload.provider_task_id, null, 'provider_task_id 入队为 null（回填字段）');
  assert.strictEqual(payload.task_id, 't1');
  assert.ok(!('onSubmitted' in payload.run_opts), 'run_opts 应剔除函数字段 onSubmitted');
  assert.strictEqual(payload.run_opts.clientRequestId, 'cr-1');
});

// ─── 2) enqueueGenerationOutbox 无 connect → 顺序双写回退 ───
test('enqueueGenerationOutbox：无 connect → 顺序双写（无 BEGIN）', async () => {
  const pool = makePool([]);
  const enq = {
    taskId: 't2', clientRequestId: 'cr-2', displayModel: 'm', canonicalModelId: 'm-img',
    prompt: 'p', count: 1, contentType: 'image', pendingIds: [], clientMeta: {},
    user_id: 'u1', idempotencyKey: 'ik', cost: 5, costPool: 'recharge',
    runOpts: { taskId: 't2', clientRequestId: 'cr-2', onSubmitted: () => {} },
  };
  const r = await dispatcher.enqueueGenerationOutbox(pool, enq);
  assert.strictEqual(r.transactional, false);
  assert.ok(has(pool, /INSERT INTO generation_tasks/));
  assert.ok(has(pool, /INSERT INTO generation_outbox_v2/));
  assert.ok(!has(pool, /^BEGIN$/), '无 connect 时不得发 BEGIN');
});

// ─── 3) generateAsync 默认：写 outbox（client_request_id 内联 task INSERT）───
test('generateAsync 默认路径：写 generation_tasks（含 client_request_id）+ generation_outbox_v2', async () => {
  stubAll({});
  const pool = makePool([]);
  const genOpts = {
    model: 'm-img', prompt: '一只猫', count: 1, contentType: 'image', user_id: 'u1',
    cost: 5, costPool: 'recharge', idempotencyKey: 'ik-1', userPlan: 'free',
    ratio: '1:1', resolution: '1k', referenceImages: [], negative: '',
  };
  const { taskId, error } = await dispatcher.generateAsync(pool, genOpts);
  assert.ok(taskId, '应返回 taskId');
  assert.ok(!error, `不应有 error：${error || ''}`);
  const ins = lastMatch(pool, /INSERT INTO generation_tasks/);
  assert.ok(ins, '应写 generation_tasks');
  const crId = ins.params[12];
  assert.ok(crId && crId.startsWith(`cr-${taskId}`), 'task INSERT 应内联 client_request_id（事务内原子写入）');
  const ob = lastMatch(pool, /INSERT INTO generation_outbox_v2/);
  assert.ok(ob, '默认路径应写 generation_outbox_v2');
  const payload = JSON.parse(ob.params[1]);
  assert.strictEqual(payload.client_request_id, crId);
  assert.strictEqual(payload.task_id, taskId);
  assert.strictEqual(payload.provider_task_id, null);
  assert.ok(!has(pool, /UPDATE generation_tasks SET client_request_id/), '默认路径不得走旧分离 UPDATE');
  await sleep(40); // 等后台 fire-and-forget 快速失败终态收敛（fake 无可用服务商）
});

// ─── 4) generateAsync kill-switch LEGACY_FIRE_FORGET=1 → 不写 outbox ───
test('generateAsync kill-switch LEGACY_FIRE_FORGET=1：不写 outbox，退回旧 UPDATE client_request_id', async () => {
  process.env.LEGACY_FIRE_FORGET = '1';
  stubAll({});
  const pool = makePool([]);
  const { taskId, error } = await dispatcher.generateAsync(pool, {
    model: 'm-img', prompt: 'p', count: 1, contentType: 'image', user_id: 'u1',
    cost: 5, costPool: 'recharge', idempotencyKey: 'ik', ratio: '1:1', resolution: '1k',
  });
  assert.ok(taskId, '应返回 taskId');
  assert.ok(!error);
  assert.ok(!has(pool, /INSERT INTO generation_outbox_v2/), 'kill-switch 下不得写 outbox');
  const upd = lastMatch(pool, /UPDATE generation_tasks SET client_request_id/);
  assert.ok(upd, 'kill-switch 下应走旧 UPDATE client_request_id');
  assert.strictEqual(upd.params[1], taskId);
  await sleep(40);
});

// ─── 5) relay recovery：DB 成功 + queue 失败 → 恢复后 provider 只提交一次（同 client_request_id 幂等）───
test('relay recovery：首次提交后 queue 崩溃（未标记 delivered）→ 恢复 relay 不再二次提交（同 client_request_id 幂等）', async () => {
  const state = { status: 'running', provider_task_id: null };
  const submitted = [];
  const ev = {
    event_id: 1, aggregate_id: 't5', aggregate_type: 'generation_task', event_type: 'generate.requested',
    payload: {
      client_request_id: 'cr-5', provider_task_id: null, task_id: 't5',
      run_opts: { user_id: 'u1', cost: 5, costPool: 'recharge', idempotencyKey: 'ik-5', model: 'm-img', prompt: 'p', contentType: 'image' },
    },
  };
  const pool = makePool([
    { match: /FOR UPDATE SKIP LOCKED/, rows: [ev] },
    { match: /SELECT status, provider_task_id FROM generation_tasks/, rows: () => [{ status: state.status, provider_task_id: state.provider_task_id }] },
    { match: /SET published_at=NOW\(\)/, rows: [{ event_id: 1 }] },
  ]);
  const injected = {
    // 模拟真实 drive：provider 接受后 onSubmitted 回填 provider_task_id，随后进程崩溃（queue 失败，未标记 delivered）
    drive: async (pg, runOpts) => {
      submitted.push(runOpts.clientRequestId);
      state.provider_task_id = 'pt-5';   // onSubmitted → persistProviderTaskId 回填
      throw new Error('crash after submit (before mark-delivered)');
    },
  };
  // 第一次 tick：claim → guard 放行（provider_task_id 仍 null）→ drive 提交后抛错 → publishOutbox 捕获 → 未标记 delivered
  const r1 = await dispatcher.runGenerationRelayTick(pool, { workerId: 'w1' }, injected);
  assert.strictEqual(r1.published, 0, '首次提交后崩溃：事件保持未投递');
  assert.strictEqual(submitted.length, 1);
  assert.strictEqual(submitted[0], 'cr-5', '首次提交使用 payload 稳定 client_request_id');

  // 第二次 tick（恢复）：claim 同一行 → guard 见 provider_task_id='pt-5' → already_submitted skip → 标记 delivered
  const r2 = await dispatcher.runGenerationRelayTick(pool, { workerId: 'w1' }, injected);
  assert.strictEqual(submitted.length, 1, '恢复后不得二次提交（provider 只提交一次）');
  assert.strictEqual(r2.published, 1, '恢复后 skip 幂等，事件应标记 delivered');
  assert.ok(has(pool, /SET published_at=NOW\(\)/), '恢复后应标记 delivered');
});

// ─── 6) dispatchFromOutbox 护栏：already_submitted / terminal_status → skip ───
test('dispatchFromOutbox：provider_task_id 已回填 → skip（already_submitted）不重提', async () => {
  const pool = makePool([
    { match: /SELECT status, provider_task_id FROM generation_tasks/, rows: [{ status: 'running', provider_task_id: 'pt-x' }] },
  ]);
  let drives = 0;
  const r = await dispatcher.dispatchFromOutbox(pool, {
    aggregate_id: 't6', payload: { task_id: 't6', client_request_id: 'cr-6', run_opts: {} },
  }, { drive: async () => { drives++; } });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'already_submitted');
  assert.strictEqual(drives, 0, '已提交不得再 drive');
});

test('dispatchFromOutbox：终态 status → skip（terminal_status）', async () => {
  const pool = makePool([
    { match: /SELECT status, provider_task_id FROM generation_tasks/, rows: [{ status: 'done', provider_task_id: null }] },
  ]);
  let drives = 0;
  const r = await dispatcher.dispatchFromOutbox(pool, {
    aggregate_id: 't7', payload: { task_id: 't7', run_opts: {} },
  }, { drive: async () => { drives++; } });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'terminal_status:done');
  assert.strictEqual(drives, 0);
});

test('dispatchFromOutbox：guard 放行 → 重建 runOpts（稳定 client_request_id + onSubmitted 回填）并 drive', async () => {
  const pool = makePool([
    { match: /SELECT status, provider_task_id FROM generation_tasks/, rows: [{ status: 'running', provider_task_id: null }] },
  ]);
  let seen = null;
  const r = await dispatcher.dispatchFromOutbox(pool, {
    aggregate_id: 't8', payload: { task_id: 't8', client_request_id: 'cr-8', run_opts: { model: 'm-img', user_id: 'u1', cost: 5 } },
  }, { drive: async (pg, runOpts) => { seen = runOpts; return { status: 'handled' }; } });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.taskId, 't8');
  assert.strictEqual(r.clientRequestId, 'cr-8');
  assert.ok(seen, '应 drive');
  assert.strictEqual(seen.taskId, 't8');
  assert.strictEqual(seen.clientRequestId, 'cr-8', '重建 runOpts 应携带稳定 client_request_id（幂等键不变）');
  assert.strictEqual(typeof seen.onSubmitted, 'function', '重建 runOpts 应恢复 onSubmitted 回填');
  assert.strictEqual(seen.model, 'm-img', 'run_opts 字段应透传');
});

// ─── 7) checkTaskDispatchable 直接面：running+无提交 → dispatchable ───
test('checkTaskDispatchable：running 且未提交 → dispatchable；缺行 → task_not_found', async () => {
  const pool = makePool([
    { match: /SELECT status, provider_task_id FROM generation_tasks/, rows: [{ status: 'running', provider_task_id: null }] },
  ]);
  assert.deepStrictEqual(await dispatcher.checkTaskDispatchable(pool, 't9'), { dispatchable: true });
  const pool2 = makePool([
    { match: /SELECT status, provider_task_id FROM generation_tasks/, rows: [] },
  ]);
  const r2 = await dispatcher.checkTaskDispatchable(pool2, 't-missing');
  assert.strictEqual(r2.dispatchable, false);
  assert.strictEqual(r2.reason, 'task_not_found');
});
