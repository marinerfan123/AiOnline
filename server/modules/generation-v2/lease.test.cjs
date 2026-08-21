'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { claimItems, transitionItem, reapExpiredLeases } = require('./lease.cjs');

function fakePg(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/RETURNING i\.\*/s.test(sql)) return { rows, rowCount: rows.length };
      if (/RETURNING (?:i\.)?item_id/s.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('claimItems 使用 SKIP LOCKED、优先级排序并递增 fencing token', async () => {
  const pg = fakePg([{ item_id: 'gi-1', lease_version: 3 }]);
  const rows = await claimItems(pg, { workerId: 'w1', limit: 8, leaseSeconds: 120 });
  assert.equal(rows.length, 1);
  const call = pg.calls[0];
  assert.match(call.sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(call.sql, /ORDER BY priority DESC, created_at ASC/i);
  assert.match(call.sql, /mode='real'/i);
  assert.match(call.sql, /lease_version=i\.lease_version\+1/i);
  assert.match(call.sql, /status='leased'/i);
  assert.deepEqual(call.params, [8, 'w1', 120]);
});

test('claimItems 限制领取数量，拒绝无 workerId', async () => {
  const pg = fakePg();
  await claimItems(pg, { workerId: 'w1', limit: 999, leaseSeconds: 1 });
  assert.equal(pg.calls[0].params[0], 100);
  assert.equal(pg.calls[0].params[2], 10);
  await assert.rejects(() => claimItems(pg, { limit: 1 }), /workerId/);
});

test('transitionItem 使用 itemId+leaseVersion+前置状态 CAS，旧worker不能回写', async () => {
  const pg = fakePg([{ item_id: 'gi-1', status: 'generating', lease_version: 4 }]);
  const row = await transitionItem(pg, {
    itemId: 'gi-1', leaseVersion: 4, from: 'leased', to: 'generating',
    patch: { provider_id: 'p1', key_id: 'k1' },
  });
  assert.equal(row.item_id, 'gi-1');
  const call = pg.calls[0];
  assert.match(call.sql, /WHERE item_id=\$1 AND lease_version=\$2 AND status=\$3/i);
  assert.deepEqual(call.params.slice(0, 4), ['gi-1', 4, 'leased', 'generating']);
});

test('transitionItem CAS未命中返回null', async () => {
  const pg = fakePg([]);
  assert.equal(await transitionItem(pg, {
    itemId: 'gi-old', leaseVersion: 1, from: 'generating', to: 'generated', patch: {},
  }), null);
});

test('transitionItem 拒绝非法状态边，包括终态回退', async () => {
  const pg = fakePg();
  await assert.rejects(() => transitionItem(pg, {
    itemId: 'gi-1', leaseVersion: 1, from: 'done', to: 'queued', patch: {},
  }), /illegal state transition/);
  assert.equal(pg.calls.length, 0);
});

test('transitionItem 拒绝非法字段，防SQL列注入', async () => {
  const pg = fakePg();
  await assert.rejects(() => transitionItem(pg, {
    itemId: 'gi-1', leaseVersion: 1, from: 'leased', to: 'generating',
    patch: { "status='done' --": 'x' },
  }), /patch field/);
});

test('reapExpiredLeases 将leased安全重试、generating转reconciling防重复提交', async () => {
  const pg = fakePg([{ item_id: 'gi-2' }]);
  const rows = await reapExpiredLeases(pg, { limit: 50 });
  assert.equal(rows.length, 1);
  const call = pg.calls[0];
  assert.match(call.sql, /status IN \('leased','generating'\)/i);
  assert.match(call.sql, /lease_expires_at < NOW\(\)/i);
  assert.match(call.sql, /CASE WHEN i\.status='generating' THEN 'reconciling' ELSE 'retry_wait'/i);
  assert.match(call.sql, /lease_version=i\.lease_version\+1/i);
});
