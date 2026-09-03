'use strict';
/**
 * G22 — presencePgStore.cjs unit tests (mock pg 模拟真实 PG 语义).
 *
 * 假 pg 忠实模拟 canvas_presence 在 PostgreSQL 上的行为：
 *   - 复合主键 (canvas_id, user_id)：同 (canvas,user) 的 INSERT ... ON CONFLICT
 *     DO UPDATE 原地覆盖 state/last_seen_ms，绝不产生第二行。
 *   - last_seen_ms 列(int8)：入参为 JS number，SELECT 一律以【字符串】返回 ——
 *     模拟 node-pg 把 int8 读成 string 的行为，验证 store 层 Number() 归一。
 *   - DELETE 按行数返回 rowCount（affected rows）。
 *   - 未识别 SQL 抛错 —— 抓 store 发出计划外语句。
 *
 * 同源断言（复制常量、禁 require 循环）：
 *   - 测试可跨模块 require（测试不属于运行期依赖图，无环），直接对拍
 *     presencePgStore 与 presenceBus 的 PRESENCE_STATES / PRESENCE_STATE_LIST /
 *     PRESENCE_LEGACY_ALIASES / HEARTBEAT_TTL_MS 逐字一致。
 *   - 读 presencePgStore.cjs 源码断言其不含任何 require( —— 常量确为复制、无跨目录依赖。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createPresencePgStore,
  SQL,
  PRESENCE_STATES,
  PRESENCE_STATE_LIST,
  PRESENCE_LEGACY_ALIASES,
  HEARTBEAT_TTL_MS,
} = require('./presencePgStore.cjs');
const presenceBus = require('./presenceBus.cjs');

const MODULE_PATH = path.join(__dirname, 'presencePgStore.cjs');
const MIGRATION_PATH = path.join(__dirname, '../../db/migrations/0047_canvas_presence.sql');
const TTL = 30_000;

function createMockPg() {
  // canvases: canvasId -> Map<userId, storedRow(snake_case)>
  const canvases = new Map();
  const calls = [];

  function getCanvas(canvasId) {
    if (!canvases.has(canvasId)) canvases.set(canvasId, new Map());
    return canvases.get(canvasId);
  }

  async function query(text, params = []) {
    calls.push({ text: String(text).trim(), params: [...params] });
    const sql = String(text).trim();

    if (sql.includes('INSERT INTO canvas_presence') && sql.includes('ON CONFLICT')) {
      // upsert: PK (canvas_id, user_id) 冲突 → DO UPDATE 原地覆盖
      const [canvasId, userId, state, lastSeenMs] = params;
      const canvas = getCanvas(canvasId);
      canvas.set(userId, {
        canvas_id: canvasId,
        user_id: userId,
        state,
        last_seen_ms: String(lastSeenMs), // int8 → string (node-pg 读回行为)
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('DELETE FROM canvas_presence')) {
      if (sql.includes('last_seen_ms <')) {
        // sweep: $1 = cutoff；可选 $2 = canvas_id
        const [cutoff] = params;
        const canvasId = params.length >= 2 ? params[1] : null;
        const targets = canvasId
          ? (canvases.has(canvasId) ? [[canvasId, canvases.get(canvasId)]] : [])
          : [...canvases.entries()];
        let removed = 0;
        for (const [cid, users] of targets) {
          for (const [uid, row] of [...users.entries()]) {
            if (Number(row.last_seen_ms) < cutoff) {
              users.delete(uid);
              removed += 1;
            }
          }
          if (users.size === 0 && canvasId === null) canvases.delete(cid);
        }
        return { rows: [], rowCount: removed };
      }
      // remove: canvas_id = $1 AND user_id = $2
      const [canvasId, userId] = params;
      const canvas = canvases.get(canvasId);
      const had = canvas ? canvas.delete(userId) : false;
      if (had && canvas.size === 0) canvases.delete(canvasId);
      return { rows: [], rowCount: had ? 1 : 0 };
    }

    if (sql.includes('SELECT canvas_id, user_id, state, last_seen_ms')) {
      const [canvasId] = params;
      const canvas = canvases.get(canvasId);
      const rows = canvas
        ? [...canvas.values()]
            .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0))
            .map((r) => ({ ...r, last_seen_ms: String(r.last_seen_ms) }))
        : [];
      return { rows, rowCount: rows.length };
    }

    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }

  return {
    pg: { query },
    calls,
    deleteCount: () => calls.filter((c) => c.text.includes('DELETE FROM canvas_presence')).length,
    insertCount: () => calls.filter((c) => c.text.includes('INSERT INTO canvas_presence')).length,
    storedCount: (canvasId) => (canvases.get(canvasId) ? canvases.get(canvasId).size : 0),
    stored: (canvasId) =>
      canvases.has(canvasId)
        ? [...canvases.get(canvasId).values()].sort((a, b) => (a.user_id < b.user_id ? -1 : 1))
        : [],
  };
}

/* ── 构造守卫 ──────────────────────────────────────────────────── */
test('G22 presencePgStore: 缺 pg / 无 query() 在构造期抛 TypeError', () => {
  assert.throws(() => createPresencePgStore(), TypeError);
  assert.throws(() => createPresencePgStore({}), TypeError);
  assert.throws(() => createPresencePgStore({ pg: 'nope' }), TypeError);
  assert.throws(() => createPresencePgStore({ pg: {} }), /query\(\) required/);
});

/* ── 单一真源：常量复制同源、禁跨目录 require ───────────────────── */
test('G22 presencePgStore: PRESENCE 枚举/TTL 与 presenceBus 逐字一致（复制常量同源）', () => {
  assert.deepEqual(PRESENCE_STATES, presenceBus.PRESENCE_STATES, 'PRESENCE_STATES 同源一致');
  assert.deepEqual(
    PRESENCE_STATE_LIST,
    presenceBus.PRESENCE_STATE_LIST,
    'PRESENCE_STATE_LIST 同源一致',
  );
  assert.deepEqual(
    PRESENCE_LEGACY_ALIASES,
    presenceBus.PRESENCE_LEGACY_ALIASES,
    'PRESENCE_LEGACY_ALIASES 同源一致',
  );
  assert.equal(HEARTBEAT_TTL_MS, presenceBus.HEARTBEAT_TTL_MS);
  assert.equal(HEARTBEAT_TTL_MS, TTL);
  assert.ok(Object.isFrozen(PRESENCE_STATES), '枚举为 frozen');
});

test('G22 presencePgStore: 模块源码零 require —— 常量确为复制、无跨目录依赖', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.doesNotMatch(src, /require\s*\(/, 'presencePgStore.cjs 不得 require 任何模块（防循环）');
  assert.match(src, /单一真源/, '保留同源注释标记');
});

/* ── upsert：插入 + 冲突覆盖 + SQL 契约 ────────────────────────── */
test('G22 presencePgStore: upsert 插入新行，SQL/参数符合 ON CONFLICT DO UPDATE 契约', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  const t0 = 1_752_000_000_000;
  const r = await store.upsert({ canvasId: 'c-1', userId: 'u-1', state: 'online', lastSeenMs: t0 });
  assert.deepEqual(r, { ok: true });
  assert.equal(m.storedCount('c-1'), 1);

  const insert = m.calls.find((c) => c.text.includes('INSERT INTO canvas_presence'));
  assert.match(insert.text, /INSERT INTO canvas_presence/);
  assert.match(insert.text, /ON CONFLICT \(canvas_id, user_id\) DO UPDATE/);
  assert.match(insert.text, /SET state = EXCLUDED\.state, last_seen_ms = EXCLUDED\.last_seen_ms/);
  assert.deepEqual(insert.params, ['c-1', 'u-1', 'online', t0]);
});

test('G22 presencePgStore: 同 (canvas,user) 冲突 upsert —— 原地覆盖、绝无第二行', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  const t0 = 1_752_000_000_000;
  await store.upsert({ canvasId: 'c-1', userId: 'u-1', state: 'online', lastSeenMs: t0 });
  const r2 = await store.upsert({
    canvasId: 'c-1', userId: 'u-1', state: 'editing', lastSeenMs: t0 + 5_000,
  });
  assert.deepEqual(r2, { ok: true });
  assert.equal(m.storedCount('c-1'), 1, 'PK 冲突 → 覆盖而非双行');
  assert.equal(m.insertCount(), 2, '两次 INSERT 都真实发出（DO UPDATE 语义）');

  const rows = await store.list('c-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'editing', 'state 被覆盖为新值');
  assert.equal(rows[0].lastSeenMs, t0 + 5_000, 'lastSeenMs 被刷新为新值');
});

test('G22 presencePgStore: upsert 归一 legacy alias busy→editing（同 presenceBus 口径）', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  await store.upsert({ canvasId: 'c-1', userId: 'u-1', state: 'busy', lastSeenMs: 1000 });
  const [row] = await store.list('c-1');
  assert.equal(row.state, 'editing', 'busy 归一为 editing 后落库');
  assert.equal(row.state, PRESENCE_STATES.EDITING);
});

/* ── upsert 校验：与 presenceBus 同口径的枚举校验，拒则零落行 ───── */
test('G22 presencePgStore: upsert 非法入参拒(400) —— canvasId/userId/state/lastSeenMs', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  const cases = [
    [{}, 'canvasId'],
    [{ canvasId: '  ', userId: 'u', state: 'online', lastSeenMs: 1 }, 'canvasId'],
    [{ canvasId: 7, userId: 'u', state: 'online', lastSeenMs: 1 }, 'canvasId'],
    [{ canvasId: 'c-1', state: 'online', lastSeenMs: 1 }, 'userId'],
    [{ canvasId: 'c-1', userId: 'u-1', state: '', lastSeenMs: 1 }, 'state'],
    [{ canvasId: 'c-1', userId: 'u-1', state: 'idle', lastSeenMs: 1 }, 'state'],
    [{ canvasId: 'c-1', userId: 'u-1', state: 'ONLINE', lastSeenMs: 1 }, 'state'],
    [{ canvasId: 'c-1', userId: 'u-1', state: 'online' }, 'lastSeenMs'],
    [{ canvasId: 'c-1', userId: 'u-1', state: 'online', lastSeenMs: -1 }, 'lastSeenMs'],
    [{ canvasId: 'c-1', userId: 'u-1', state: 'online', lastSeenMs: 'now' }, 'lastSeenMs'],
    [{ canvasId: 'c-1', userId: 'u-1', state: 'online', lastSeenMs: NaN }, 'lastSeenMs'],
  ];
  for (const [input, field] of cases) {
    const r = await store.upsert(input);
    assert.equal(r.ok, false, `[${field}] 应拒绝`);
    assert.equal(r.status, 400, `[${field}] 应带 400`);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, `[${field}] 应带 errors`);
    assert.ok(r.errors.some((e) => e.includes(field)), `[${field}] errors 应点名该字段`);
  }
  // 非对象入参整体拒
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = await store.upsert(bad);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
  assert.equal(m.insertCount(), 0, '全部被拒，无任何 INSERT 发出');
});

/* ── list：纯存储读，状态/过期过滤不在此层 ─────────────────────── */
test('G22 presencePgStore: list 返回画布全部行 —— 不滤 offline、不滤过期、行形状/类型稳定', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  const now = 1_752_000_000_000;
  // 四种 canonical 状态 + 一条远超 TTL 的陈旧行 —— 纯存储都必须原样返回
  await store.upsert({ canvasId: 'c-1', userId: 'u-online', state: 'online', lastSeenMs: now });
  await store.upsert({ canvasId: 'c-1', userId: 'u-away', state: 'away', lastSeenMs: now - 1_000 });
  await store.upsert({ canvasId: 'c-1', userId: 'u-edit', state: 'editing', lastSeenMs: now - 10_000 });
  await store.upsert({ canvasId: 'c-1', userId: 'u-off', state: 'offline', lastSeenMs: now - 20_000 });
  await store.upsert({ canvasId: 'c-1', userId: 'u-stale', state: 'online', lastSeenMs: now - 10 * TTL });

  const rows = await store.list('c-1');
  assert.equal(rows.length, 5, '全部行都在（含 offline 与严重过期行 —— 状态/过期裁决在总线层）');
  const states = rows.map((r) => r.state);
  assert.ok(states.includes('offline'), 'offline 行不被本层过滤');
  assert.ok(rows.some((r) => r.userId === 'u-stale'), '过期行不被本层过滤');
  assert.deepEqual(rows.map((r) => r.userId), ['u-away', 'u-edit', 'u-off', 'u-online', 'u-stale'], '按 user_id 升序');

  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['canvasId', 'lastSeenMs', 'state', 'userId'].sort());
    assert.equal(typeof r.lastSeenMs, 'number', 'int8 string 必须归一为 number');
    assert.equal(typeof r.state, 'string');
  }
});

test('G22 presencePgStore: list 画布隔离；空/缺省 canvasId → [] 且不发 SQL', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  await store.upsert({ canvasId: 'c-1', userId: 'u-1', state: 'online', lastSeenMs: 1 });
  await store.upsert({ canvasId: 'c-2', userId: 'u-9', state: 'away', lastSeenMs: 2 });

  const c1 = await store.list('c-1');
  const c2 = await store.list('c-2');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].userId, 'u-1');
  assert.equal(c2.length, 1);
  assert.equal(c2[0].userId, 'u-9');

  assert.deepEqual(await store.list('c-missing'), [], '无此画布 → []');
  const before = m.calls.length;
  assert.deepEqual(await store.list(''), [], '空白 canvasId → []');
  assert.deepEqual(await store.list(), [], '缺省 canvasId → []（读路径宽容，不报 400）');
  assert.equal(m.calls.length, before, '非法 canvasId 不发 SQL');
});

/* ── remove ────────────────────────────────────────────────────── */
test('G22 presencePgStore: remove 删行、幂等；SQL/参数符合契约；画布间隔离', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  await store.upsert({ canvasId: 'c-1', userId: 'u-1', state: 'online', lastSeenMs: 10 });
  await store.upsert({ canvasId: 'c-1', userId: 'u-2', state: 'away', lastSeenMs: 20 });
  await store.upsert({ canvasId: 'c-2', userId: 'u-1', state: 'editing', lastSeenMs: 30 });

  assert.deepEqual(await store.remove({ canvasId: 'c-1', userId: 'u-1' }), { ok: true });
  assert.equal(m.storedCount('c-1'), 1, '只删目标行');
  assert.equal(m.storedCount('c-2'), 1, '其它画布不受影响');
  const rows = await store.list('c-1');
  assert.deepEqual(rows.map((r) => r.userId), ['u-2']);

  assert.deepEqual(await store.remove({ canvasId: 'c-1', userId: 'u-noexist' }), { ok: true }, '幂等：目标不存在也 ok');

  const del = m.calls.find((c) => c.text.includes('DELETE FROM canvas_presence'));
  assert.match(del.text, /DELETE FROM canvas_presence/);
  assert.match(del.text, /WHERE canvas_id = \$1 AND user_id = \$2/);
  assert.deepEqual(del.params, ['c-1', 'u-1']);
});

test('G22 presencePgStore: remove 非法入参拒(400)，不发 DELETE', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  for (const [input, field] of [
    [{}, 'canvasId'],
    [{ canvasId: 'c-1' }, 'userId'],
    [{ canvasId: '', userId: 'u' }, 'canvasId'],
    [{ canvasId: 'c-1', userId: 7 }, 'userId'],
    ['nope', 'canvasId'],
    [null, 'canvasId'],
  ]) {
    const r = await store.remove(input);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.ok(r.errors.some((e) => e.includes(field)), `errors 应点名 ${field}`);
  }
  assert.equal(m.deleteCount(), 0, '全部被拒，无 DELETE 发出');
});

/* ── sweep：过期边界（严格 <）+ 画布范围/全库 ───────────────────── */
test('G22 presencePgStore: sweep 过期边界 —— age=30000 恰好保留、30001 清除（严格 <）', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  const now = 1_752_000_000_000;
  await store.upsert({ canvasId: 'c-1', userId: 'u-fresh', state: 'online', lastSeenMs: now - 1 }); // age 1ms
  await store.upsert({ canvasId: 'c-1', userId: 'u-edge', state: 'away', lastSeenMs: now - TTL }); // age = 30000（边界）
  await store.upsert({ canvasId: 'c-1', userId: 'u-edge-1', state: 'editing', lastSeenMs: now - TTL - 1 }); // age 30001
  await store.upsert({ canvasId: 'c-1', userId: 'u-old', state: 'online', lastSeenMs: now - TTL - 9_999 }); // 深过期

  const r = await store.sweep('c-1', now);
  assert.equal(r.removed, 2, '只清 age 严格 > 30000 的两条');
  const rows = await store.list('c-1');
  assert.deepEqual(rows.map((x) => x.userId).sort(), ['u-edge', 'u-fresh'].sort(), 'age 恰为 TTL 的边界行本拍保留');
  assert.equal(rows.find((x) => x.userId === 'u-edge').lastSeenMs, now - TTL);

  // 下一拍（now +1ms）边界行即过期 —— 严格 < 只推迟一个调度拍
  const r2 = await store.sweep('c-1', now + 1);
  assert.equal(r2.removed, 1);
  assert.deepEqual((await store.list('c-1')).map((x) => x.userId), ['u-fresh']);
});

test('G22 presencePgStore: sweep(canvasId) 只清该画布；sweep() 全库清；空白 canvasId = 全库', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  const now = 1_752_000_000_000;
  await store.upsert({ canvasId: 'c-1', userId: 'u-a', state: 'online', lastSeenMs: now - 100_000 });
  await store.upsert({ canvasId: 'c-1', userId: 'u-b', state: 'online', lastSeenMs: now });
  await store.upsert({ canvasId: 'c-2', userId: 'u-x', state: 'away', lastSeenMs: now - 100_000 });
  await store.upsert({ canvasId: 'c-2', userId: 'u-y', state: 'away', lastSeenMs: now });

  const scoped = await store.sweep('c-1', now);
  assert.equal(scoped.removed, 1, '只清 c-1 的过期行');
  assert.equal(m.storedCount('c-1'), 1);
  assert.equal(m.storedCount('c-2'), 2, 'c-2 未受影响');

  // 空白 canvasId 视同未传 → 全库清
  const global1 = await store.sweep('', now);
  assert.equal(global1.removed, 1, '清掉 c-2 的过期行');
  assert.equal(m.storedCount('c-2'), 1);

  // 全库形态：不传 canvasId
  await store.upsert({ canvasId: 'c-9', userId: 'u-z', state: 'offline', lastSeenMs: now - 99_000 });
  const global2 = await store.sweep(undefined, now);
  assert.equal(global2.removed, 1);
  assert.equal(m.storedCount('c-9'), 0);
});

test('G22 presencePgStore: sweep 非法 nowMs → {removed:0} 且不发 DELETE；缺省 nowMs = Date.now()', async () => {
  const m = createMockPg();
  const store = createPresencePgStore({ pg: m.pg });
  const before = m.deleteCount();
  assert.deepEqual(await store.sweep('c-1', 'later'), { removed: 0 });
  assert.deepEqual(await store.sweep('c-1', -5), { removed: 0 });
  assert.deepEqual(await store.sweep('c-1', NaN), { removed: 0 });
  assert.equal(m.deleteCount(), before, '非法 nowMs 不产生 DELETE');

  // 缺省 nowMs = Date.now()：seed 一条确定过期的行（相对真实时钟），sweep() 应清掉
  await store.upsert({ canvasId: 'c-1', userId: 'u-stale', state: 'online', lastSeenMs: Date.now() - 2 * TTL });
  await store.upsert({ canvasId: 'c-1', userId: 'u-live', state: 'online', lastSeenMs: Date.now() });
  const r = await store.sweep();
  assert.equal(r.removed, 1);
  assert.deepEqual((await store.list('c-1')).map((x) => x.userId), ['u-live']);
});

/* ── SQL 常量 ↔ 迁移 0047 对拍 ─────────────────────────────────── */
test('G22 presencePgStore: 导出 SQL 常量与迁移 0047 表结构一致', () => {
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS canvas_presence/);
  for (const col of ['canvas_id', 'user_id', 'state', 'last_seen_ms']) {
    assert.ok(migration.includes(col), `迁移应含列 ${col}`);
  }
  assert.match(migration, /PRIMARY KEY \(canvas_id, user_id\)/);
  assert.match(migration, /last_seen_ms\s+BIGINT NOT NULL/);

  assert.match(SQL.INSERT_SQL, /INSERT INTO canvas_presence/);
  assert.match(SQL.INSERT_SQL, /ON CONFLICT \(canvas_id, user_id\) DO UPDATE/);
  assert.match(SQL.INSERT_SQL, /EXCLUDED\.state/);
  assert.match(SQL.INSERT_SQL, /EXCLUDED\.last_seen_ms/);
  assert.match(SQL.LIST_SQL, /FROM canvas_presence/);
  assert.match(SQL.LIST_SQL, /WHERE canvas_id = \$1/);
  assert.match(SQL.REMOVE_SQL, /DELETE FROM canvas_presence/);
  assert.match(SQL.REMOVE_SQL, /WHERE canvas_id = \$1 AND user_id = \$2/);
  assert.match(SQL.SWEEP_SQL_CANVAS, /last_seen_ms < \$1 AND canvas_id = \$2/);
  assert.match(SQL.SWEEP_SQL_ALL, /last_seen_ms < \$1/);
  assert.ok(!SQL.SWEEP_SQL_ALL.includes('canvas_id'), '全库 sweep 无 canvas 条件');
});
