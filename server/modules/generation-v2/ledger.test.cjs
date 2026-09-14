'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { settleHold, reconcileBatch } = require('./ledger.cjs');

function fakePg(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/RETURNING hold_id/.test(sql)) return { rows, rowCount: rows.length };
      if (/RETURNING (?:b\.)?batch_id/.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('settleHold commit 只允许 held→committed CAS', async () => {
  const pg = fakePg([{ hold_id: 1, item_id: 'gi-1', status: 'committed', amount: '50' }]);
  const result = await settleHold(pg, { itemId: 'gi-1', action: 'commit' });
  assert.equal(result.changed, true);
  const call = pg.calls[0];
  // P0 fix 8cafea8: parameterized status (never interpolated).
  assert.match(call.sql, /SET status=\$2, settled_at=NOW\(\)/);
  assert.equal(call.params[1], 'committed');
  assert.match(call.sql, /WHERE item_id=\$1 AND status='held'/);
});

test('settleHold release 只允许 held→released CAS', async () => {
  const pg = fakePg([{ hold_id: 2, item_id: 'gi-2', status: 'released', amount: '50' }]);
  const result = await settleHold(pg, { itemId: 'gi-2', action: 'release' });
  assert.equal(result.changed, true);
  const call = pg.calls[0];
  assert.match(call.sql, /SET status=\$2, settled_at=NOW\(\)/);
  assert.equal(call.params[1], 'released');
});

test('settleHold CAS未命中视为幂等，无重复commit/release', async () => {
  const pg = fakePg([]);
  assert.deepEqual(await settleHold(pg, { itemId: 'gi-1', action: 'commit' }), { changed: false, hold: null });
});

test('settleHold 拒绝非法action', async () => {
  await assert.rejects(() => settleHold(fakePg(), { itemId: 'gi-1', action: 'refund-all' }), /action/);
});

test('reconcileBatch 从item终态聚合 done/partial/failed/canceled', async () => {
  const pg = fakePg([{ batch_id: 'gb-1', status: 'partial', success_count: 2, failed_count: 1, canceled_count: 1 }]);
  const row = await reconcileBatch(pg, 'gb-1');
  assert.equal(row.status, 'partial');
  const sql = pg.calls[0].sql;
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE i\.status='done'\)/);
  assert.match(sql, /WHEN success_count=requested_count THEN 'done'/);
  assert.match(sql, /WHEN success_count>0 AND terminal_count=requested_count THEN 'partial'/);
  assert.match(sql, /WHEN canceled_count=requested_count THEN 'canceled'/);
  assert.match(sql, /WHEN terminal_count=requested_count THEN 'failed'/);
});
