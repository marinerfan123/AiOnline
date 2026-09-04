'use strict';
/**
 * 0070 generation_groups + generation_group_items + runGroupTick（L45, §112/§113）。
 *
 * 覆盖：
 *   1. 组创建（generation_groups/generation_group_items 落库 + policy JSONB 读回）。
 *   2. status CHECK 五态词表（词表外 23514）。
 *   3. UNIQUE(group_id, item_id)（重复 23505）。
 *   4. FK 强制（item/group 缺父 23503）+ ON DELETE CASCADE。
 *   5. 组内并发上限 + 按序推进（concurrency=2 只领 2 个、按 position 顺序、二 tick 0 增领）。
 *   6. 失败策略 fail_fast（任一 failed → 整组 failed + 剩余 queued 项 cancel）。
 *   7. 失败策略 continue（单 item 失败不阻塞，其余继续推进到 done，组终态 failed）。
 *   8. runGroupTick 默认 off（§138 渐进上线）与 normalizeGroupPolicy 纯函数。
 *
 * 运行：TEST_PG_PORT=5433 TEST_PG_DATABASE=moling_test node --test server/modules/generation-v2/generation-group.test.cjs
 * （沿用 lease-fencing-pg.test.cjs 的隔离 DB 约定：initTestSchema + 应用 0070 单一迁移文件。）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createTestPool, initTestSchema, truncateAll, closeTestPool, assertSafeTestDatabase,
} = require('../../tests/helpers/test-db.cjs');
const { runGroupTick, createPgGroupStore, normalizeGroupPolicy } = require('./generation-worker.cjs');

const MIGRATION_0070 = path.join(__dirname, '../../db/migrations/0070_generation_group.sql');

let pg;
test.before(async () => {
  assertSafeTestDatabase(process.env.TEST_PG_DATABASE || 'moling_test');
  pg = createTestPool();
  await initTestSchema(pg);
  await pg.query(fs.readFileSync(MIGRATION_0070, 'utf8'));
});
test.after(async () => closeTestPool(pg));
test.beforeEach(async () => {
  await truncateAll(pg);
  await pg.query('TRUNCATE generation_groups, generation_group_items RESTART IDENTITY CASCADE');
});

async function seedUser() {
  await pg.query(
    `INSERT INTO users (id,email,display_name,password_hash,reward_credits,recharge_credits)
     VALUES ('u-g','group@test.local','Group','$2b$10$fake',100,100)`);
}

async function seedItem({ itemId, status = 'queued' }) {
  await pg.query(
    `INSERT INTO generation_batches_v2 (batch_id,user_id,idempotency_key,model_id,content_type,requested_count,unit_price,reserved_total,request_payload)
     VALUES ($1,'u-g',$2,'m-g','video',1,1,1,'{}'::jsonb)`,
    [`b-${itemId}`, `idem-${itemId}`]);
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id,batch_id,item_index,status,mode,next_attempt_at)
     VALUES ($1,$2,0,$3,'real',NOW())`,
    [itemId, `b-${itemId}`, status]);
}

async function seedGroup({ groupId = 'g-1', policy = {}, itemIds = [], positions, itemStatuses }) {
  await seedUser();
  const items = itemIds.map((itemId, idx) => ({
    itemId, status: (itemStatuses && itemStatuses[idx]) || 'queued',
  }));
  for (const it of items) await seedItem(it);
  await pg.query(
    `INSERT INTO generation_groups (id,project_id,name,media_type,status,policy)
     VALUES ($1,'p-1','Shot 010','video','queued',$2::jsonb)`,
    [groupId, JSON.stringify(policy)]);
  for (let i = 0; i < items.length; i++) {
    await pg.query(
      `INSERT INTO generation_group_items (group_id,item_id,position) VALUES ($1,$2,$3)`,
      [groupId, items[i].itemId, positions ? positions[i] : i]);
  }
}

async function itemStatuses(itemIds) {
  const r = await pg.query(
    `SELECT item_id, status FROM generation_items_v2 WHERE item_id = ANY($1::text[]) ORDER BY item_id`,
    [itemIds]);
  const map = {};
  for (const row of r.rows) map[row.item_id] = row.status;
  return map;
}

async function groupRow(groupId) {
  const r = await pg.query(
    `SELECT id,name,media_type,status,policy,finished_at FROM generation_groups WHERE id=$1`, [groupId]);
  return r.rows[0] || null;
}

async function expectError(promise, code, label) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `${label}: 预期 SQLSTATE ${code} 的报错，实际未报错`);
  assert.equal(err.code, code, `${label}: 预期 SQLSTATE ${code}，实际 ${err.code}（${err.message}）`);
}

// 纯函数：策略归一化
test('normalizeGroupPolicy：concurrency clamp + failurePolicy 缺省 fail_fast', () => {
  assert.deepEqual(normalizeGroupPolicy({ concurrency: 5, failurePolicy: 'continue' }),
    { concurrency: 5, failurePolicy: 'continue' });
  assert.deepEqual(normalizeGroupPolicy({}), { concurrency: 1, failurePolicy: 'fail_fast' });
  assert.deepEqual(normalizeGroupPolicy({ concurrency: 0 }), { concurrency: 1, failurePolicy: 'fail_fast' });
  assert.deepEqual(normalizeGroupPolicy({ concurrency: 999 }), { concurrency: 50, failurePolicy: 'fail_fast' });
  assert.deepEqual(normalizeGroupPolicy(null), { concurrency: 1, failurePolicy: 'fail_fast' });
  assert.deepEqual(normalizeGroupPolicy({ failurePolicy: 'bogus' }), { concurrency: 1, failurePolicy: 'fail_fast' });
});

// 默认 off（§138 渐进上线）
test('runGroupTick 默认 off：未显式开启时 no-op，不要求 workerId', async () => {
  const r = await runGroupTick(pg, {}, {});
  assert.equal(r.enabled, false);
  assert.equal(r.claimed, 0);
});

// 组创建
test('组创建：generation_groups + generation_group_items 落库，policy JSONB 读回', async () => {
  await seedGroup({
    groupId: 'g-1',
    policy: { concurrency: 3, failurePolicy: 'continue' },
    itemIds: ['i-1', 'i-2', 'i-3'],
  });
  const g = await groupRow('g-1');
  assert.ok(g, '组应存在');
  assert.equal(g.name, 'Shot 010');
  assert.equal(g.media_type, 'video');
  assert.equal(g.status, 'queued');
  assert.deepEqual(g.policy, { concurrency: 3, failurePolicy: 'continue' });
  const n = await pg.query(`SELECT count(*)::int AS c FROM generation_group_items WHERE group_id='g-1'`);
  assert.equal(n.rows[0].c, 3, '组内应有 3 个成员');
});

// status CHECK
test('组 status CHECK：词表外值被拒（23514）', async () => {
  await seedUser();
  await expectError(
    pg.query(`INSERT INTO generation_groups (id,name,status) VALUES ('g-bogus','Bogus','bogus')`),
    '23514', 'status 词表外值');
});

// UNIQUE + FK + CASCADE
test('UNIQUE(group_id,item_id)：同组重复成员被拒（23505）', async () => {
  await seedGroup({ groupId: 'g-u', itemIds: ['i-u'] });
  await expectError(
    pg.query(`INSERT INTO generation_group_items (group_id,item_id) VALUES ('g-u','i-u')`),
    '23505', '同 (group_id, item_id) 重复');
});

test('FK 强制：缺父 item/group 被拒（23503）+ ON DELETE CASCADE', async () => {
  await seedGroup({ groupId: 'g-fk', itemIds: ['i-fk'] });
  await expectError(
    pg.query(`INSERT INTO generation_group_items (group_id,item_id) VALUES ('g-fk','i-missing')`),
    '23503', 'item_id 引用不存在的 item');
  await expectError(
    pg.query(`INSERT INTO generation_group_items (group_id,item_id) VALUES ('g-missing','i-fk')`),
    '23503', 'group_id 引用不存在的组');
  // 删除组 → 成员级联删除
  await pg.query(`DELETE FROM generation_groups WHERE id='g-fk'`);
  const remain = await pg.query(`SELECT count(*)::int AS c FROM generation_group_items WHERE group_id='g-fk'`);
  assert.equal(remain.rows[0].c, 0, '删除组后成员应级联删除');
});

// 并发上限 + 按序推进
test('并发上限 + 按序推进：concurrency=2 只领 2 个（按 position 顺序），二 tick 0 增领', async () => {
  await seedGroup({
    groupId: 'g-c',
    policy: { concurrency: 2, failurePolicy: 'continue' },
    itemIds: ['i-1', 'i-2', 'i-3', 'i-4', 'i-5'],
    positions: [0, 1, 2, 3, 4],
  });
  const claimedItems = [];
  const noopProcess = async (_pg, item) => { claimedItems.push(item.item_id); return { status: 'leased' }; };

  const r1 = await runGroupTick(pg, { workerId: 'w-1', enabled: true }, { processItem: noopProcess });
  assert.equal(r1.claimed, 2, '首个 tick 应按并发上限只领 2 个');
  assert.equal(r1.dispatched, 2);
  assert.deepEqual(claimedItems, ['i-1', 'i-2'], '应按 position 顺序领取前两个');

  const st = await itemStatuses(['i-1', 'i-2', 'i-3', 'i-4', 'i-5']);
  assert.equal(st['i-1'], 'leased');
  assert.equal(st['i-2'], 'leased');
  assert.equal(st['i-3'], 'queued');
  assert.equal(st['i-4'], 'queued');
  assert.equal(st['i-5'], 'queued');

  // 二 tick：组内在途 = 2 == 上限，0 增领
  const r2 = await runGroupTick(pg, { workerId: 'w-1', enabled: true }, { processItem: noopProcess });
  assert.equal(r2.claimed, 0, '在途已达上限，二 tick 不应增领');
});

// 失败策略 fail_fast
test('失败策略 fail_fast：任一 item failed → 整组 failed + 剩余 queued 项 cancel', async () => {
  await seedGroup({
    groupId: 'g-ff',
    policy: { concurrency: 3, failurePolicy: 'fail_fast' },
    itemIds: ['i-a', 'i-b', 'i-c'],
    itemStatuses: ['queued', 'failed', 'queued'],
  });
  const noopProcess = async () => ({ status: 'leased' });
  const r = await runGroupTick(pg, { workerId: 'w-1', enabled: true }, { processItem: noopProcess });

  assert.equal(r.failFastStopped, 1);
  assert.equal(r.claimed, 0, 'fail_fast 下不应领取新 item');
  const g = await groupRow('g-ff');
  assert.equal(g.status, 'failed');
  assert.ok(g.finished_at, '组终态应写 finished_at');
  const st = await itemStatuses(['i-a', 'i-b', 'i-c']);
  assert.equal(st['i-a'], 'canceled');
  assert.equal(st['i-b'], 'failed');
  assert.equal(st['i-c'], 'canceled');
});

// 失败策略 continue
test('失败策略 continue：单 item 失败不阻塞，其余推进到 done，组终态 failed', async () => {
  await seedGroup({
    groupId: 'g-ct',
    policy: { concurrency: 3, failurePolicy: 'continue' },
    itemIds: ['i-x', 'i-y', 'i-z'],
    itemStatuses: ['queued', 'failed', 'queued'],
  });
  const completeToDone = async (_pg, item) => {
    await pg.query(`UPDATE generation_items_v2 SET status='done' WHERE item_id=$1`, [item.item_id]);
    return { status: 'generated' };
  };
  const r = await runGroupTick(pg, { workerId: 'w-1', enabled: true }, { processItem: completeToDone });

  assert.equal(r.claimed, 2, 'continue 下应领取除 failed 外的 2 个可领 item');
  assert.equal(r.finalized, 1);
  const g = await groupRow('g-ct');
  assert.equal(g.status, 'failed', '全组终态后仍有失败成员 → 组 failed');
  assert.ok(g.finished_at);
  const st = await itemStatuses(['i-x', 'i-y', 'i-z']);
  assert.equal(st['i-x'], 'done', 'continue 下其余 item 应推进到 done（非 cancel）');
  assert.equal(st['i-y'], 'failed');
  assert.equal(st['i-z'], 'done');
});
