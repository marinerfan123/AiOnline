'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeShadowBatch, isShadowEnabled } = require('./shadow.cjs');

test('影子双写默认关闭，仅显式true启用', () => {
  assert.equal(isShadowEnabled({}), false);
  assert.equal(isShadowEnabled({ GENERATION_V2_SHADOW_WRITE: 'false' }), false);
  assert.equal(isShadowEnabled({ GENERATION_V2_SHADOW_WRITE: 'true' }), true);
});

test('关闭时不写数据库', async () => {
  let called = false;
  const result = await writeShadowBatch({ query: async () => { called = true; } }, {}, {});
  assert.deepEqual(result, { enabled: false, written: false });
  assert.equal(called, false);
});

test('开启时映射旧任务为V2影子批次且不影响旧taskId', async () => {
  const calls = [];
  const pg = { async query(sql, params = []) { calls.push({ sql, params }); if (/SELECT batch_id/.test(sql)) return { rows: [] }; return { rows: [] }; } };
  const result = await writeShadowBatch(pg, {
    taskId: 'gt-1', userId: 'u1', idempotencyKey: 'idem-1', modelId: 'm1',
    contentType: 'image', count: 2, unitPrice: 50, pool: 'reward', requestPayload: { prompt: 'x' },
  }, { GENERATION_V2_SHADOW_WRITE: 'true' });
  assert.equal(result.written, true);
  assert.equal(result.batchId, 'shadow-gt-1');
  assert.ok(calls.some((c) => c.params.includes('shadow-gt-1')));
});

test('影子写失败被隔离返回error，不向旧链路抛出', async () => {
  const pg = { async query(sql) { if (/BEGIN/.test(sql)) return {}; if (/ROLLBACK/.test(sql)) return {}; throw new Error('shadow db fail'); } };
  const result = await writeShadowBatch(pg, {
    taskId: 'gt-2', userId: 'u1', idempotencyKey: 'idem-2', modelId: 'm1', count: 1, unitPrice: 50, pool: 'reward',
  }, { GENERATION_V2_SHADOW_WRITE: 'true' });
  assert.equal(result.written, false);
  assert.match(result.error, /shadow db fail/);
});
