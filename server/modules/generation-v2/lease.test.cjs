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
    itemId: 'gi-1', leaseVersion: 4, workerId: 'w1', from: 'leased', to: 'generating',
    patch: { provider_id: 'p1', key_id: 'k1' },
  });
  assert.equal(row.item_id, 'gi-1');
  const call = pg.calls[0];
  assert.match(call.sql, /WHERE item_id=\$1 AND lease_version=\$2 AND status=\$3/i);
  assert.match(call.sql, /lease_owner=\$5/i);
  assert.match(call.sql, /lease_expires_at > NOW\(\)/i);
  assert.deepEqual(call.params.slice(0, 5), ['gi-1', 4, 'leased', 'generating', 'w1']);
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

// ===== L10 — Activity lease (generation_activity_runs / 0060) =====
const {
  claimActivity, adoptActivity, renewActivityLease, completeActivity, failActivity,
  ACTIVITY_TYPES,
} = require('./lease.cjs');

function fakeActivityPg(result) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const rows = typeof result === 'function' ? result(sql, params) : (result || []);
      return { rows, rowCount: rows.length };
    },
  };
}

test('ACTIVITY_TYPES 是 §42 的 8 类词表', () => {
  assert.equal(ACTIVITY_TYPES.length, 8);
  assert.deepEqual(ACTIVITY_TYPES, [
    'PREPARE_ASSETS', 'ACQUIRE_QUOTA', 'SUBMIT_PROVIDER', 'OBSERVE_PROVIDER',
    'FETCH_OUTPUT', 'VERIFY_OUTPUT', 'FINALIZE_ASSETS', 'SETTLE_BILLING',
  ]);
});

test('claimActivity 领 pending/waiting_retry 且 lease 空闲或过期，CAS lease+heartbeat 并递增 attempt_count', async () => {
  const pg = fakeActivityPg([{ id: 'a1', status: 'running', lease_owner: 'w1', attempt_count: 1 }]);
  const rows = await claimActivity(pg, { workerId: 'w1', limit: 8, leaseSeconds: 60 });
  assert.equal(rows.length, 1);
  const { sql, params } = pg.calls[0];
  assert.match(sql, /status IN \('pending','waiting_retry'\)/);
  assert.match(sql, /lease_expires_at IS NULL OR lease_expires_at < NOW\(\)/);
  assert.match(sql, /next_retry_at <= NOW\(\)/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /status='running'/);
  assert.match(sql, /heartbeat_at=NOW\(\)/);
  assert.match(sql, /attempt_count=a\.attempt_count\+1/);
  assert.deepEqual(params, [8, 'w1', 60]);
});

test('claimActivity 拒绝无 workerId 并 clamp limit/lease', async () => {
  const pg = fakeActivityPg([]);
  await claimActivity(pg, { workerId: 'w1', limit: 999, leaseSeconds: 1 });
  assert.equal(pg.calls[0].params[0], 100);
  assert.equal(pg.calls[0].params[2], 10);
  await assert.rejects(() => claimActivity(pg, { limit: 1 }), /workerId/);
});

test('adoptActivity 到期接管 running/pending/waiting_retry（严格 lease_expires_at < NOW）', async () => {
  const pg = fakeActivityPg([{ id: 'a2', status: 'running', lease_owner: 'w9', attempt_count: 2 }]);
  const rows = await adoptActivity(pg, { workerId: 'w2', limit: 5, leaseSeconds: 60 });
  assert.equal(rows.length, 1);
  const { sql, params } = pg.calls[0];
  assert.match(sql, /status IN \('pending','waiting_retry','running'\)/);
  assert.match(sql, /lease_expires_at < NOW\(\)/);
  assert.doesNotMatch(sql, /lease_expires_at IS NULL/);
  assert.match(sql, /attempt_count=a\.attempt_count\+1/);
  assert.deepEqual(params, [5, 'w2', 60]);
});

test('renewActivityLease 心跳续租：仅本人且未过期时延长 lease+heartbeat，否则返回 null', async () => {
  const pg = fakeActivityPg([{ id: 'a1', lease_owner: 'w1' }]);
  const row = await renewActivityLease(pg, { id: 'a1', workerId: 'w1', leaseSeconds: 90 });
  assert.ok(row);
  const { sql, params } = pg.calls[0];
  assert.match(sql, /WHERE id=\$1 AND lease_owner=\$2/);
  assert.match(sql, /lease_expires_at > NOW\(\)/);
  assert.match(sql, /heartbeat_at=NOW\(\)/);
  assert.deepEqual(params, ['a1', 'w1', 90]);
  const pgNone = fakeActivityPg([]);
  assert.equal(await renewActivityLease(pgNone, { id: 'a1', workerId: 'w2', leaseSeconds: 90 }), null);
});

test('completeActivity/failActivity fencing：UPDATE WHERE id AND lease_owner=$me，旧 owner 写入返回 null', async () => {
  const pg = fakeActivityPg([]);
  assert.equal(await completeActivity(pg, { id: 'a1', workerId: 'old' }), null);
  const c0 = pg.calls[0];
  assert.match(c0.sql, /WHERE id=\$1 AND lease_owner=\$2/);
  assert.match(c0.sql, /SET status='succeeded'/);
  assert.match(c0.sql, /lease_owner=NULL, lease_expires_at=NULL/);
  assert.match(c0.sql, /status IN \('pending','waiting_retry','running'\)/);
  assert.deepEqual(c0.params, ['a1', 'old']);

  await failActivity(pg, { id: 'a1', workerId: 'old', status: 'waiting_retry', errorCode: 'RATE_LIMIT' });
  const f0 = pg.calls[1];
  assert.match(f0.sql, /WHERE id=\$1 AND lease_owner=\$2/);
  assert.match(f0.sql, /status IN \('pending','waiting_retry','running'\)/);
  assert.match(f0.sql, /next_retry_at=COALESCE\(\$5::timestamptz, NOW\(\)\)/);
  assert.deepEqual(f0.params.slice(0, 2), ['a1', 'old']);
});

test('failActivity 拒绝非法终态', async () => {
  const pg = fakeActivityPg([]);
  await assert.rejects(() => failActivity(pg, { id: 'a1', workerId: 'w', status: 'done' }), /terminal status/);
});
