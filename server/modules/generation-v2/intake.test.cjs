'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCount, createBatchWithItems } = require('./intake.cjs');

function makeFakePg() {
  const calls = [];
  let existing = null;
  return {
    calls,
    setExisting(row) { existing = row; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT batch_id.*generation_batches_v2/s.test(sql)) {
        return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

test('normalizeCount 图片限制1-4，视频固定1', () => {
  assert.equal(normalizeCount('image', 0), 1);
  assert.equal(normalizeCount('image', 3), 3);
  assert.equal(normalizeCount('image', 99), 4);
  assert.equal(normalizeCount('video', 4), 1);
});

test('createBatchWithItems 在单事务创建父批次、N个单图item、每图hold和outbox', async () => {
  const pg = makeFakePg();
  const result = await createBatchWithItems(pg, {
    batchId: 'gb-1', userId: 'u1', idempotencyKey: 'idem-1', modelId: 'm1',
    contentType: 'image', count: 3, unitPrice: 50, pool: 'reward', requestPayload: { prompt: 'x' },
  });
  assert.deepEqual(result, { batchId: 'gb-1', count: 3, idempotent: false });
  assert.match(pg.calls[0].sql, /BEGIN/);
  assert.ok(pg.calls.some((c) => /INSERT INTO generation_batches_v2/.test(c.sql)));
  const itemInsert = pg.calls.find((c) => /INSERT INTO generation_items_v2/.test(c.sql));
  assert.ok(itemInsert);
  assert.equal(itemInsert.params.length, 3 * 3, '每个item应有 itemId/batchId/index');
  const holdInsert = pg.calls.find((c) => /INSERT INTO generation_credit_holds_v2/.test(c.sql));
  assert.ok(holdInsert);
  assert.equal(holdInsert.params.length, 3 * 4, '每个hold应有 itemId/userId/pool/unitPrice');
  assert.ok(pg.calls.some((c) => /INSERT INTO generation_outbox_v2/.test(c.sql)));
  assert.match(pg.calls.at(-1).sql, /COMMIT/);
});

test('createBatchWithItems 命中幂等键时不再创建item或hold', async () => {
  const pg = makeFakePg();
  pg.setExisting({ batch_id: 'gb-existing', requested_count: 4 });
  const result = await createBatchWithItems(pg, {
    batchId: 'gb-new', userId: 'u1', idempotencyKey: 'idem-same', modelId: 'm1',
    contentType: 'image', count: 4, unitPrice: 50, pool: 'reward',
  });
  assert.deepEqual(result, { batchId: 'gb-existing', count: 4, idempotent: true });
  assert.equal(pg.calls.some((c) => /INSERT INTO generation_items_v2/.test(c.sql)), false);
  assert.match(pg.calls.at(-1).sql, /COMMIT/);
});

test('createBatchWithItems 中途失败会ROLLBACK', async () => {
  const pg = makeFakePg();
  const original = pg.query.bind(pg);
  pg.query = async (sql, params) => {
    if (/INSERT INTO generation_items_v2/.test(sql)) throw new Error('boom');
    return original(sql, params);
  };
  await assert.rejects(() => createBatchWithItems(pg, {
    batchId: 'gb-2', userId: 'u1', idempotencyKey: 'idem-2', modelId: 'm1',
    contentType: 'image', count: 2, unitPrice: 50, pool: 'reward',
  }), /boom/);
  assert.ok(pg.calls.some((c) => /ROLLBACK/.test(c.sql)));
});
