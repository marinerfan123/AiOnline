'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyDurableEventsMode,
  normalizeStatus,
  isTerminalStatus,
  compareOutcome,
  writeShadowCompare,
  recordRelayOutcome,
} = require('./shadowCompare.cjs');

// ─── 1. shadow 模式标记（classifyDurableEventsMode）──────────────────────────
test('classifyDurableEventsMode：默认/0/false → off（零行为变更）', () => {
  assert.equal(classifyDurableEventsMode({}), 'off');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: '0' }), 'off');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 'false' }), 'off');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 'off' }), 'off');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: '' }), 'off');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 'garbage' }), 'off');
});

test('classifyDurableEventsMode：1/true/on → on（与 flags.parseBool 一致）', () => {
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: '1' }), 'on');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 'true' }), 'on');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 'on' }), 'on');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 'yes' }), 'on');
});

test('classifyDurableEventsMode：2 / shadow（大小写不敏感）→ shadow', () => {
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: '2' }), 'shadow');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 'shadow' }), 'shadow');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 'SHADOW' }), 'shadow');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 2 }), 'shadow');
});

test('classifyDurableEventsMode：数字 1 → on，其它数字 → off', () => {
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 1 }), 'on');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 0 }), 'off');
  assert.equal(classifyDurableEventsMode({ FF_VIDEO_DURABLE_EVENTS: 3 }), 'off');
});

// ─── 2. 终态归一（normalizeStatus / isTerminalStatus）───────────────────────
test('normalizeStatus：终态同义词归一为 success/failed/canceled', () => {
  assert.equal(normalizeStatus('done'), 'success');
  assert.equal(normalizeStatus('SUCCEEDED'), 'success');
  assert.equal(normalizeStatus('completed'), 'success');
  assert.equal(normalizeStatus('failed'), 'failed');
  assert.equal(normalizeStatus('error'), 'failed');
  assert.equal(normalizeStatus('canceled'), 'canceled');
  assert.equal(normalizeStatus('cancelled'), 'canceled');
});

test('normalizeStatus：非终态透传，空/缺失 → null', () => {
  assert.equal(normalizeStatus('running'), 'running');
  assert.equal(normalizeStatus('pending'), 'pending');
  assert.equal(normalizeStatus('dispatched'), 'dispatched');
  assert.equal(normalizeStatus('skipped:already_submitted'), 'skipped:already_submitted');
  assert.equal(normalizeStatus(''), null);
  assert.equal(normalizeStatus(undefined), null);
  assert.equal(normalizeStatus(null), null);
});

test('isTerminalStatus：终态 true，非终态/缺失 false', () => {
  assert.equal(isTerminalStatus('done'), true);
  assert.equal(isTerminalStatus('failed'), true);
  assert.equal(isTerminalStatus('canceled'), true);
  assert.equal(isTerminalStatus('running'), false);
  assert.equal(isTerminalStatus('pending'), false);
  assert.equal(isTerminalStatus(undefined), false);
});

// ─── 3. compareOutcome（一致 / 不一致 / 终态未齐 pending 不判）────────────────
test('compareOutcome：两路终态一致 → aligned true（无 diff）', () => {
  assert.deepEqual(compareOutcome({ legacyStatus: 'done', outboxStatus: 'done' }), { aligned: true });
  // 同义词归一后一致也算一致
  assert.deepEqual(compareOutcome({ legacyStatus: 'success', outboxStatus: 'succeeded' }), { aligned: true });
  assert.deepEqual(compareOutcome({ legacyStatus: 'failed', outboxStatus: 'error' }), { aligned: true });
});

test('compareOutcome：两路均终态但不一致 → aligned false + MISMATCH', () => {
  const r = compareOutcome({ legacyStatus: 'done', outboxStatus: 'failed', providerTaskId: 'pt-1' });
  assert.equal(r.aligned, false);
  assert.equal(r.diff.reason, 'MISMATCH');
  assert.equal(r.diff.legacyStatus, 'done');
  assert.equal(r.diff.outboxStatus, 'failed');
  assert.equal(r.diff.providerTaskId, 'pt-1');
  assert.deepEqual(r.diff.normalized, { legacy: 'success', outbox: 'failed' });
});

test('compareOutcome：终态未齐（任一路非终态）→ pending 不判', () => {
  const r1 = compareOutcome({ legacyStatus: 'done', outboxStatus: 'running' });
  assert.equal(r1.aligned, false);
  assert.equal(r1.diff.reason, 'PENDING');

  const r2 = compareOutcome({ legacyStatus: 'pending', outboxStatus: 'done' });
  assert.equal(r2.aligned, false);
  assert.equal(r2.diff.reason, 'PENDING');

  // 缺失状态视为未齐，不判
  const r3 = compareOutcome({ legacyStatus: 'done', outboxStatus: undefined });
  assert.equal(r3.aligned, false);
  assert.equal(r3.diff.reason, 'PENDING');
});

// ─── 4. writeShadowCompare（落点 writer，fake pg）────────────────────────────
function fakePg(rowsBySql = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      for (const [pat, rows] of Object.entries(rowsBySql)) {
        if (sql.includes(pat)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('writeShadowCompare：写 generation_events（type/source/job_id/provider_event_id + payload_hash）', async () => {
  const pg = fakePg();
  const r = await writeShadowCompare(pg, {
    taskId: 'gt-1', providerTaskId: 'pt-9', legacyStatus: 'done', outboxStatus: 'done',
  });
  assert.equal(r.ok, true);
  assert.equal(r.aligned, true);
  assert.ok(r.payloadHash && r.payloadHash.length === 64, 'payload_hash 为 SHA-256 hex');
  const ins = pg.calls.find((c) => c.sql.includes('INSERT INTO generation_events'));
  assert.ok(ins, '存在 generation_events INSERT');
  const params = ins.params;
  assert.equal(params[0], 'shadow_compare:gt-1'); // event_id
  assert.equal(params[1], 'gt-1');                 // job_id
  assert.equal(params[3], 'shadow_compare');       // type
  assert.equal(params[4], 'traffic_switch');       // source
  assert.equal(params[5], 'pt-9');                 // provider_event_id
});

test('writeShadowCompare：不一致落 MISMATCH 对照行', async () => {
  const pg = fakePg();
  const r = await writeShadowCompare(pg, {
    taskId: 'gt-2', legacyStatus: 'done', outboxStatus: 'failed',
  });
  assert.equal(r.ok, true);
  assert.equal(r.aligned, false);
  assert.equal(r.diff.reason, 'MISMATCH');
});

test('writeShadowCompare：终态未齐落 PENDING 对照行（不判但留痕）', async () => {
  const pg = fakePg();
  const r = await writeShadowCompare(pg, {
    taskId: 'gt-3', legacyStatus: 'done', outboxStatus: 'skipped:already_submitted',
  });
  assert.equal(r.ok, true);
  assert.equal(r.aligned, false);
  assert.equal(r.diff.reason, 'PENDING');
});

test('writeShadowCompare：缺 taskId → 拒绝，不写库', async () => {
  const pg = fakePg();
  const r = await writeShadowCompare(pg, { legacyStatus: 'done', outboxStatus: 'done' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_TASK_ID');
  assert.equal(pg.calls.length, 0);
});

test('writeShadowCompare：DB 异常被隔离，返回 error 不 throw', async () => {
  const pg = { async query() { throw new Error('db down'); } };
  const r = await writeShadowCompare(pg, { taskId: 'gt-4', legacyStatus: 'done', outboxStatus: 'done' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /db down/);
});

// ─── 5. recordRelayOutcome（relay 消费面包装，fake pg）───────────────────────
test('recordRelayOutcome：relay dispatched → outbox 侧终态 = task 行状态', async () => {
  const pg = fakePg({
    'SELECT status, provider_task_id': [{ status: 'done', provider_task_id: 'pt-1' }],
  });
  const ev = { aggregate_id: 'gt-10', payload: { task_id: 'gt-10' } };
  const r = await recordRelayOutcome(pg, ev, { dispatched: true, taskId: 'gt-10', status: 'handled' });
  assert.equal(r.ok, true);
  assert.equal(r.aligned, true); // done vs done
});

test('recordRelayOutcome：relay skipped → 记 skipped:<reason>（去重安全证据）', async () => {
  const pg = fakePg({
    'SELECT status, provider_task_id': [{ status: 'done', provider_task_id: 'pt-2' }],
  });
  const ev = { aggregate_id: 'gt-11', payload: { task_id: 'gt-11' } };
  const r = await recordRelayOutcome(pg, ev, { dispatched: false, skipped: true, reason: 'already_submitted' });
  assert.equal(r.ok, true);
  assert.equal(r.aligned, false);
  assert.equal(r.diff.reason, 'PENDING');
  assert.equal(r.diff.outboxStatus, 'skipped:already_submitted');
});

test('recordRelayOutcome：无法关联 task_id → MISSING_TASK_ID', async () => {
  const pg = fakePg();
  const r = await recordRelayOutcome(pg, { payload: {} }, { dispatched: false, skipped: true, reason: 'missing_task_id' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_TASK_ID');
});
