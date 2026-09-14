'use strict';
/**
 * G22 — commandLogStore.cjs unit tests (mock pg 模拟真实 PG 语义).
 *
 * 假 pg 忠实模拟 canvas_command_log 在 PostgreSQL 上的行为：
 *   - seq 来自单条全局序列：每次 INSERT 尝试(含被 ON CONFLICT 吞掉的重复)都消费
 *     nextval —— 即画布内 seq 数值可能有洞(跨画布交错 + 重复尝试留洞)，但真实落行
 *     的 seq 严格按追加序递增，读方只能依赖游标语义。
 *   - UNIQUE (canvas_id, command_id) 冲突 → INSERT 无 RETURNING 行 ({ rows: [] })，
 *     与 PG `ON CONFLICT (canvas_id, command_id) DO NOTHING` 一致。
 *   - BIGINT 列(seq / RETURNING seq / MAX(seq))一律以【字符串】返回 —— 模拟
 *     node-pg 把 int8 读成 string 的行为，验证 store 层 Number() 归一。
 *   - jsonb: 入参收 JSON 字符串，SELECT 返回解析后的对象；timestamptz: 入参收
 *     epoch ms，SELECT 返回 Date —— 均对齐 node-pg 类型解析。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCommandLogStore, SQL } = require('./commandLogStore.cjs');

const NO_CONFLICT_TYPES = ['node.create', 'node.move', 'node.delete', 'canvas.viewport.update'];

function createMockPg() {
  // canvases: canvasId -> Map<command_id, storedRow(snake_case)>
  const canvases = new Map();
  const calls = [];
  let seqCounter = 0; // 全局序列 (BIGSERIAL)：每次 INSERT 尝试都 +1

  function getCanvas(canvasId) {
    if (!canvases.has(canvasId)) canvases.set(canvasId, new Map());
    return canvases.get(canvasId);
  }

  async function query(text, params = []) {
    calls.push({ text: String(text).trim(), params: [...params] });
    const sql = String(text).trim();

    if (sql.includes('INSERT INTO canvas_command_log')) {
      const [canvasId, commandId, type, actorId, baseRevision, payloadJson, receivedAtMs] = params;
      const seq = String(++seqCounter); // 先消费 nextval —— 与 BIGSERIAL 一致
      const canvas = getCanvas(canvasId);
      if (canvas.has(commandId)) {
        // UNIQUE (canvas_id, command_id) 冲突 → DO NOTHING，无 RETURNING 行
        return { rows: [], rowCount: 0 };
      }
      canvas.set(commandId, {
        canvas_id: canvasId,
        seq,
        command_id: commandId,
        type,
        actor_id: actorId,
        base_revision: baseRevision,
        payload: payloadJson, // 原样存 JSON 字符串；SELECT 时再解析 (同 node-pg)
        received_at: new Date(receivedAtMs), // 入参 ms → timestamptz Date
      });
      return { rows: [{ seq }], rowCount: 1 };
    }

    if (sql.includes('ORDER BY seq ASC')) {
      const [canvasId, afterSeq] = params;
      const canvas = canvases.get(canvasId);
      const all = canvas ? [...canvas.values()] : [];
      const rows = all
        .filter((r) => Number(r.seq) > afterSeq)
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((r) => ({
          canvas_id: r.canvas_id,
          seq: String(r.seq), // int8 → string (node-pg)
          command_id: r.command_id,
          type: r.type,
          actor_id: r.actor_id,
          base_revision: r.base_revision,
          payload: r.payload === null ? null : JSON.parse(r.payload), // jsonb → object
          received_at: r.received_at,
        }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('COALESCE(MAX(seq)')) {
      const [canvasId] = params;
      const canvas = canvases.get(canvasId);
      const storedSeqs = canvas ? [...canvas.values()].map((r) => Number(r.seq)) : [];
      const seq = storedSeqs.length ? String(Math.max(...storedSeqs)) : '0';
      return { rows: [{ seq }], rowCount: 1 };
    }

    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }

  return {
    pg: { query },
    calls,
    insertCount: () => calls.filter((c) => c.text.includes('INSERT INTO canvas_command_log')).length,
    /** 某画布实际落行数（不含被幂等吞掉的重复）。 */
    storedCount: (canvasId) => (canvases.get(canvasId) ? canvases.get(canvasId).size : 0),
    stored: (canvasId) => {
      const canvas = canvases.get(canvasId);
      return canvas
        ? [...canvas.values()]
            .sort((a, b) => Number(a.seq) - Number(b.seq))
            .map((r) => ({ ...r, payload: r.payload === null ? null : JSON.parse(r.payload) }))
        : [];
    },
  };
}

/* ── 构造守卫 ──────────────────────────────────────────────────── */
test('G22 commandLogStore: 缺 pg / 无 query() 在构造期抛 TypeError', () => {
  assert.throws(() => createCommandLogStore(), TypeError);
  assert.throws(() => createCommandLogStore({}), TypeError);
  assert.throws(() => createCommandLogStore({ pg: 'nope' }), TypeError);
  assert.throws(() => createCommandLogStore({ pg: {} }), /query\(\) required/);
});

test('G22 commandLogStore: knownTypes 含非字符串条目时构造期抛错', () => {
  const m = createMockPg();
  assert.throws(() => createCommandLogStore({ pg: m.pg, knownTypes: ['node.create', 42] }), TypeError);
});

/* ── 追加：seq 由「PG 序列」分配、递增 ─────────────────────────── */
test('G22 commandLogStore: appendCommand 落行，seq 由序列分配并递增；SQL/参数符合契约', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  const t0 = 1_752_000_000_000;
  const a1 = await store.appendCommand({
    canvasId: 'c-1', commandId: 'cmd-1', type: 'node.create',
    actorId: 'u-1', baseRevision: 0, payload: { schemaVersion: 1, nodeId: 'n1' }, receivedAtMs: t0,
  });
  const a2 = await store.appendCommand({
    canvasId: 'c-1', commandId: 'cmd-2', type: 'node.move',
    actorId: 'u-1', baseRevision: 1, payload: { dx: 5 }, receivedAtMs: t0 + 1,
  });
  const a3 = await store.appendCommand({
    canvasId: 'c-1', commandId: 'cmd-3', type: 'node.delete', payload: { nodeId: 'n1' },
  });
  assert.deepEqual(a1, { ok: true, idempotent: false, seq: 1 });
  assert.deepEqual(a2, { ok: true, idempotent: false, seq: 2 });
  assert.equal(a3.ok, true);
  assert.equal(a3.idempotent, false);
  assert.equal(typeof a3.seq, 'number', 'RETURNING int8 以 string 返回也必须归一为 number');
  assert.equal(a3.seq, 3, 'seq 严格递增');
  assert.equal(m.storedCount('c-1'), 3);

  const insert = m.calls.find((c) => c.text.includes('INSERT INTO canvas_command_log'));
  assert.match(insert.text, /ON CONFLICT \(canvas_id, command_id\) DO NOTHING/);
  assert.match(insert.text, /RETURNING seq/);
  assert.match(insert.text, /to_timestamp\(\$7 \/ 1000\.0\)/);
  assert.deepEqual(insert.params, [
    'c-1', 'cmd-1', 'node.create', 'u-1', 0,
    JSON.stringify({ schemaVersion: 1, nodeId: 'n1' }), t0,
  ]);
});

test('G22 commandLogStore: 多画布交错追加 —— 各自画布内 seq 仍严格按追加序递增', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    ids.push((await store.appendCommand({ canvasId: 'c-A', commandId: `A${i}`, type: 'node.create' })).seq);
    ids.push((await store.appendCommand({ canvasId: 'c-B', commandId: `B${i}`, type: 'node.create' })).seq);
  }
  // 全局序列被两画布共享 → 数值交错（A 拿 1,3,5；B 拿 2,4,6）
  assert.deepEqual(ids.slice(0, 2), [1, 2]);
  const a = ids.filter((_, i) => i % 2 === 0); // 1,3,5
  const b = ids.filter((_, i) => i % 2 === 1); // 2,4,6
  for (const s of [a, b]) {
    assert.deepEqual(s, [...s].sort((x, y) => x - y), '画布内单调不减');
    assert.equal(new Set(s).size, s.length, '画布内 seq 不重复');
  }
  const { commands: ca } = await store.listAfter({ canvasId: 'c-A', seq: 0 });
  const { commands: cb } = await store.listAfter({ canvasId: 'c-B', seq: 0 });
  assert.deepEqual(ca.map((c) => c.seq), a);
  assert.deepEqual(cb.map((c) => c.seq), b);
});

/* ── 幂等：同 (canvas_id, command_id) 不双插 ───────────────────── */
test('G22 commandLogStore: 同 commandId 重复追加 → {ok,idempotent:true} 且不双插（换 payload 也一样）', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  const first = await store.appendCommand({
    canvasId: 'c-1', commandId: 'cmd-x', type: 'node.create', payload: { v: 'original' }, receivedAtMs: 1000,
  });
  const dup = await store.appendCommand({
    canvasId: 'c-1', commandId: 'cmd-x', type: 'node.update', payload: { v: 'evil-retry' }, receivedAtMs: 9999,
  });
  assert.equal(first.idempotent, false);
  assert.deepEqual(dup, { ok: true, idempotent: true }, '重复返回 {ok:true, idempotent:true}');
  assert.equal(m.insertCount(), 2, 'INSERT 确实被尝试了两次…');
  assert.equal(m.storedCount('c-1'), 1, '…但 UNIQUE 语义只保留一行');
  const { commands } = await store.listAfter({ canvasId: 'c-1', seq: 0 });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].payload, { v: 'original' }, '首写内容原样保留，不被重试覆盖');

  // 全新 store 实例、同一 pg —— 幂等契约跨实例成立（持久化语义）
  const store2 = createCommandLogStore({ pg: m.pg });
  const retry = await store2.appendCommand({ canvasId: 'c-1', commandId: 'cmd-x', type: 'node.create', payload: {} });
  assert.deepEqual(retry, { ok: true, idempotent: true });
  assert.equal(m.storedCount('c-1'), 1);

  // 序列消费 ≠ 落行：重复尝试消费 nextval 但不影响 MAX(seq)（游标语义安全）
  const { seq: last } = await store.lastSeq('c-1');
  assert.equal(last, first.seq);
  const { commands: after } = await store.listAfter({ canvasId: 'c-1', seq: first.seq });
  assert.deepEqual(after, []);
});

test('G22 commandLogStore: 不同 commandId 各自落行；幂等键只看 (canvasId,commandId) —— 跨画布同 id 不冲突', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  const r1 = await store.appendCommand({ canvasId: 'c-1', commandId: 'same', type: 'node.create' });
  const r2 = await store.appendCommand({ canvasId: 'c-2', commandId: 'same', type: 'node.move' });
  const r3 = await store.appendCommand({ canvasId: 'c-1', commandId: 'same', type: 'node.update' });
  assert.equal(r1.idempotent, false);
  assert.equal(r2.idempotent, false, '另一画布同 commandId 是全新命令');
  assert.deepEqual(r3, { ok: true, idempotent: true });
  assert.equal(m.storedCount('c-1'), 1);
  assert.equal(m.storedCount('c-2'), 1);
});

/* ── listAfter：seq > 游标 的升序回放 ──────────────────────────── */
test('G22 commandLogStore: listAfter 按 seq 过滤(exclusive)并升序返回', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  for (let i = 1; i <= 4; i++) {
    await store.appendCommand({ canvasId: 'c-1', commandId: `cmd-${i}`, type: 'node.create' });
  }
  const { commands: all } = await store.listAfter({ canvasId: 'c-1', seq: 0 });
  assert.deepEqual(all.map((c) => c.seq), [1, 2, 3, 4], 'seq=0 从头全量，升序');
  const { commands: tail } = await store.listAfter({ canvasId: 'c-1', seq: 1 });
  assert.deepEqual(tail.map((c) => c.commandId), ['cmd-2', 'cmd-3', 'cmd-4'], 'seq 为开区间：>1 不含 1');
  const { commands: none } = await store.listAfter({ canvasId: 'c-1', seq: 4 });
  assert.deepEqual(none, [], '游标在尾部 → 空');
  const { commands: noneAbove } = await store.listAfter({ canvasId: 'c-1', seq: 999 });
  assert.deepEqual(noneAbove, []);
  // 读路径宽容：空 canvasId / 缺 seq / 非法 seq 不抛错
  assert.deepEqual(await store.listAfter({ canvasId: '', seq: 0 }), { commands: [] });
  assert.deepEqual(await store.listAfter({ canvasId: 'c-missing' }), { commands: [] });
  const { commands: negTreatedAsZero } = await store.listAfter({ canvasId: 'c-1', seq: -5 });
  assert.equal(negTreatedAsZero.length, 4, '负数游标按 0 处理');
});

/* ── lastSeq ───────────────────────────────────────────────────── */
test('G22 commandLogStore: lastSeq 返回画布最高 seq；空画布 0；画布隔离；int8-string 归一', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  assert.deepEqual(await store.lastSeq('c-empty'), { seq: 0 }, '空画布 → 0');
  for (let i = 1; i <= 3; i++) {
    await store.appendCommand({ canvasId: 'c-1', commandId: `cmd-${i}`, type: 'node.create' });
  }
  await store.appendCommand({ canvasId: 'c-2', commandId: 'only', type: 'node.create' });
  assert.deepEqual(await store.lastSeq('c-1'), { seq: 3 });
  assert.deepEqual(await store.lastSeq('c-2'), { seq: 4 }, 'MAX 只看本画布落行');
  assert.deepEqual(await store.lastSeq(''), { seq: 0 }, '空 canvasId → 0');
});

/* ── payload JSON 往返 ─────────────────────────────────────────── */
test('G22 commandLogStore: payload JSONB 完整往返（嵌套对象 + null）', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  const nested = {
    schemaVersion: 1,
    node: { id: 'n-9', position: { x: 1.5, y: -2 }, tags: ['a', 'b'], meta: { ok: true, list: [1, [2, 3]] } },
    nullable: null,
    unicode: '中文🎬',
  };
  await store.appendCommand({ canvasId: 'c-1', commandId: 'c1', type: 'node.create', payload: nested });
  await store.appendCommand({ canvasId: 'c-1', commandId: 'c2', type: 'node.delete', payload: null });
  const stored = m.stored('c-1');
  assert.equal(typeof stored[0].payload, 'object', '入参是 JSON 字符串，存储层不提前解析');
  const { commands } = await store.listAfter({ canvasId: 'c-1', seq: 0 });
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].payload, nested, '对象 payload 深度等值往返');
  assert.equal(commands[1].payload, null, 'null payload 原样往返');
  // payload 入参断言：以 JSON 字符串进参数位
  const insert = m.calls.find((c) => c.params.includes(JSON.stringify(nested)));
  assert.ok(insert, 'payload 以 JSON.stringify 结果作为参数');
});

/* ── receivedAtMs 往返 + 缺省 ──────────────────────────────────── */
test('G22 commandLogStore: receivedAtMs 往返为 epoch ms；缺省用 Date.now()', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  const t = Date.parse('2026-09-04T00:00:00.000Z');
  await store.appendCommand({ canvasId: 'c-1', commandId: 'c1', type: 'node.create', receivedAtMs: t });
  await store.appendCommand({ canvasId: 'c-1', commandId: 'c2', type: 'node.create' });
  const before = Date.now();
  const { commands } = await store.listAfter({ canvasId: 'c-1', seq: 0 });
  const after = Date.now();
  assert.equal(commands[0].receivedAtMs, t, '显式 receivedAtMs 精确往返');
  assert.ok(commands[1].receivedAtMs >= before && commands[1].receivedAtMs <= after, '缺省 = Date.now()');
  const insert = m.calls.find((c) => c.params[1] === 'c1');
  assert.equal(insert.params[6], t, 'ms 值作为第 7 个参数进入 to_timestamp');
});

/* ── type 校验：knownTypes 强校验 / 无 knownTypes 弱校验 ────────── */
test('G22 commandLogStore: 注入 knownTypes 后 type ∉ 集合一律拒(400)，不落行', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg, knownTypes: NO_CONFLICT_TYPES });
  const r = await store.appendCommand({ canvasId: 'c-1', commandId: 'c1', type: 'evil.unknown' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.ok(r.errors.some((e) => e.includes('known command types')));
  assert.equal(m.storedCount('c-1'), 0);
  const ok = await store.appendCommand({ canvasId: 'c-1', commandId: 'c1', type: 'node.create' });
  assert.equal(ok.ok, true);
  // Set 注入等效
  const storeSet = createCommandLogStore({ pg: m.pg, knownTypes: new Set(NO_CONFLICT_TYPES) });
  assert.equal((await storeSet.appendCommand({ canvasId: 'c-1', commandId: 'c2', type: 'node.move' })).ok, true);
  assert.equal((await storeSet.appendCommand({ canvasId: 'c-1', commandId: 'c3', type: 'nope.x' })).ok, false);
});

test('G22 commandLogStore: 未注入 knownTypes —— 弱校验(非空 string 即可)，域校验留给信封层', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  // 未登记类型的命令也能落库 —— 存储层不跨模块 require COMMAND_TYPES(注明：域校验
  // 由 validateCommandEnvelope/isKnownCommandType 在上层执行)
  const r = await store.appendCommand({ canvasId: 'c-1', commandId: 'c1', type: 'future.custom.type' });
  assert.deepEqual(r, { ok: true, idempotent: false, seq: 1 });
  const { commands } = await store.listAfter({ canvasId: 'c-1', seq: 0 });
  assert.equal(commands[0].type, 'future.custom.type');
});

/* ── 入参校验矩阵：一律 400、不产生任何 INSERT ─────────────────── */
test('G22 commandLogStore: 非法入参拒(400)；canvasId/commandId/type/actorId/baseRevision/payload/receivedAtMs', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  const cases = [
    [{}, 'canvasId'],
    [{ canvasId: '  ', commandId: 'c', type: 'node.create' }, 'canvasId'],
    [{ canvasId: 7, commandId: 'c', type: 'node.create' }, 'canvasId'],
    [{ canvasId: 'c-1' }, 'commandId'],
    [{ canvasId: 'c-1', commandId: 'c', type: '' }, 'type'],
    [{ canvasId: 'c-1', commandId: 'c', type: 42 }, 'type'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', actorId: '' }, 'actorId'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', actorId: 9 }, 'actorId'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', baseRevision: -1 }, 'baseRevision'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', baseRevision: 1.5 }, 'baseRevision'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', baseRevision: '3' }, 'baseRevision'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', payload: 'not-obj' }, 'payload'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', payload: () => {} }, 'payload'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', receivedAtMs: 'now' }, 'receivedAtMs'],
    [{ canvasId: 'c-1', commandId: 'c', type: 'node.create', receivedAtMs: -5 }, 'receivedAtMs'],
  ];
  for (const [input, field] of cases) {
    const r = await store.appendCommand(input);
    assert.equal(r.ok, false, `[${field}] 应拒绝`);
    assert.equal(r.status, 400, `[${field}] 应带 400`);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, `[${field}] 应带 errors`);
    assert.ok(r.errors.some((e) => e.includes(field)), `[${field}] errors 应点名该字段`);
  }
  assert.equal(m.insertCount(), 0, '全部被拒，无任何 INSERT 发出');
  // 非对象入参整体拒
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = await store.appendCommand(bad);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
  assert.equal(m.insertCount(), 0);
});

/* ── 可空列：actorId / baseRevision 缺省存 NULL、给出则往返 ─────── */
test('G22 commandLogStore: actorId/baseRevision 缺省存 NULL；给出时精确往返', async () => {
  const m = createMockPg();
  const store = createCommandLogStore({ pg: m.pg });
  await store.appendCommand({ canvasId: 'c-1', commandId: 'c1', type: 'node.create' });
  await store.appendCommand({
    canvasId: 'c-1', commandId: 'c2', type: 'node.move', actorId: 'u-9', baseRevision: 4,
  });
  await store.appendCommand({
    canvasId: 'c-1', commandId: 'c3', type: 'node.update', actorId: null, baseRevision: null,
  });
  const { commands } = await store.listAfter({ canvasId: 'c-1', seq: 0 });
  assert.equal(commands[0].actorId, null);
  assert.equal(commands[0].baseRevision, null);
  assert.equal(commands[1].actorId, 'u-9');
  assert.equal(commands[1].baseRevision, 4);
  assert.equal(commands[2].actorId, null, '显式 null 与缺省一致');
  const rowShape = ['canvasId', 'seq', 'commandId', 'type', 'actorId', 'baseRevision', 'payload', 'receivedAtMs'];
  assert.deepEqual(Object.keys(commands[0]).sort(), [...rowShape].sort(), 'listAfter 行字段形状稳定');
});

/* ── SQL 常量导出（供迁移/集成对拍） ────────────────────────────── */
test('G22 commandLogStore: 导出 SQL 常量与迁移 0046 表结构一致', () => {
  assert.match(SQL.INSERT_SQL, /INSERT INTO canvas_command_log/);
  assert.match(SQL.INSERT_SQL, /ON CONFLICT \(canvas_id, command_id\) DO NOTHING/);
  assert.match(SQL.LIST_SQL, /canvas_id = \$1 AND seq > \$2/);
  assert.match(SQL.LIST_SQL, /ORDER BY seq ASC/);
  assert.match(SQL.LAST_SEQ_SQL, /COALESCE\(MAX\(seq\), 0\)/);
});
