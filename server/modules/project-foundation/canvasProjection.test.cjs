'use strict';
/**
 * G22 CAS 投影重建① — canvasProjection.cjs 单测（叶 4，纯函数）。
 * 覆盖（对齐任务验收）：字段合并窗 / 位置优先(同域后 seq 胜) / 边增删幂等重放 /
 * 乱序先排序 / 未知拒(ERR_REJECT_BUCKET_IN_LOG) / 纯性(深冻结入参零突变) /
 * append 类 view 忽略 / BUCKET 常量同源。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyLogToProjection, BUCKET, LOGGED_BUCKETS, ERROR_CODES } = require('./canvasProjection.cjs');
const { KIND_BUCKET_BY_COMMAND, BUCKET_KEYS } = require('./canvasCommandDecomposer.cjs');

/* ── 样例构造（对齐 studioCanvasPersistence formatNode/formatEdge wire 行） ── */
function nodeRow(id, over = {}) {
  return {
    nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1,
    position: { x: 10, y: 20 }, size: { width: 260, height: 120 }, zIndex: 0,
    data: { title: `T-${id}`, status: 'IDLE', parameters: { a: 1 } },
    ...over,
  };
}
function edgeRow(id, over = {}) {
  return { edgeId: id, sourceNodeId: 'n-a', targetNodeId: 'n-b', sourceHandle: null, targetHandle: null, edgeType: 'data', data: {}, ...over };
}
/** canvas.patch 日志行：seq + ops + 可选 bucket 标记（payload 支持 baseRevision/mode 元数据）。 */
function ent(seq, ops, over = {}) {
  const payload = { ops };
  if (over.bucket !== undefined) payload.bucket = over.bucket;
  if (over.mode !== undefined) payload.mode = over.mode;
  const row = { command_id: `cmd-${seq}`, command_type: 'canvas.patch', seq, payload };
  if (over.type !== undefined) row.command_type = over.type;
  return row;
}
const nodeOp = (kind, node, extra = {}) => ({ op: 'upsertNode', kind, nodeId: node.nodeId, ...extra, ...node });
const edgeOp = (kind, edge, extra = {}) => {
  const base = { op: kind === 'edge.create' ? 'upsertEdge' : 'deleteEdge', kind, ...extra };
  return edge === null || edge === undefined ? base : { ...base, edgeId: edge.edgeId, ...edge };
};
const ids = (rows) => rows.map((r) => r.nodeId || r.edgeId);

/* ══════════════ 字段合并窗（LWW 同实体 per-field 合并） ══════════════ */

test('字段合并窗: 并发 data 编辑 + position 编辑 各存活（行值带对方陈旧域也不互踩）', () => {
  const base = nodeRow('n-1');
  // A(seq5) 只改 data（其行内 position 与 base 相同）；B(seq9) 只改 position（其行内 data 是旧值）
  const aRow = nodeRow('n-1', { data: { title: 'A-renamed', status: 'DONE', parameters: { a: 2 } } });
  const bRow = nodeRow('n-1', { position: { x: 500, y: 600 }, data: { title: 'STALE', status: 'IDLE', parameters: { a: 1 } } });
  const r = applyLogToProjection({
    current: { nodes: [base], edges: [] },
    entries: [
      ent(5, [nodeOp('node.update', aRow, { fields: ['data'], reason: 'NODE_UPDATE_DATA_ONLY' })]),
      ent(9, [nodeOp('node.move', bRow, { fields: ['position'], reason: 'NODE_MOVE_POSITION_ONLY' })]),
    ],
  });
  assert.equal(r.nodes.length, 1);
  assert.deepEqual(r.nodes[0].position, { x: 500, y: 600 });        // B 的位置生效
  assert.deepEqual(r.nodes[0].data, { title: 'A-renamed', status: 'DONE', parameters: { a: 2 } }); // A 的 data 未被 B 的陈旧行踩掉
  assert.equal(r.nodes[0].size.width, 260);                          // 未列域保留
  assert.equal(r.nodes[0].zIndex, 0);
  assert.equal(r.nodes[0].nodeType, 'prompt');
});

test('字段合并窗: 乱序输入（B 在前 A 在后）→ 按 seq 排序后同结果（收敛）', () => {
  const base = nodeRow('n-1');
  const aRow = nodeRow('n-1', { data: { title: 'A-renamed', status: 'DONE', parameters: {} } });
  const bRow = nodeRow('n-1', { position: { x: 500, y: 600 } });
  const entries = [
    ent(9, [nodeOp('node.move', bRow, { fields: ['position'] })]),
    ent(5, [nodeOp('node.update', aRow, { fields: ['data'] })]),
  ];
  const r = applyLogToProjection({ current: { nodes: [base], edges: [] }, entries });
  assert.deepEqual(r.nodes[0].position, { x: 500, y: 600 });
  assert.deepEqual(r.nodes[0].data.title, 'A-renamed');
});

test('字段合并窗: node.resize 只动 size；node.update fields=[position,data] 合并两域', () => {
  const base = nodeRow('n-1');
  const r1 = applyLogToProjection({
    current: { nodes: [base], edges: [] },
    entries: [ent(1, [nodeOp('node.resize', nodeRow('n-1', { size: { width: 900, height: 100 } }), { fields: ['size'] })])],
  });
  assert.deepEqual(r1.nodes[0].size, { width: 900, height: 100 });
  assert.deepEqual(r1.nodes[0].position, { x: 10, y: 20 }); // 几何未列域保留

  const r2 = applyLogToProjection({
    current: { nodes: [base], edges: [] },
    entries: [ent(1, [nodeOp('node.update', nodeRow('n-1', { position: { x: 1, y: 2 }, data: { title: 'D' } }), { fields: ['position', 'data'] })])],
  });
  assert.deepEqual(r2.nodes[0].position, { x: 1, y: 2 });
  assert.deepEqual(r2.nodes[0].data.title, 'D');
  assert.equal(r2.nodes[0].size.width, 260); // size 未在 fields → 保留
});

test('字段合并窗: node.update fields 缺省/空数组 → 整行覆写（词表整行语义）', () => {
  const base = nodeRow('n-1');
  const next = nodeRow('n-1', { position: { x: 7, y: 8 }, data: { title: 'W' }, size: { width: 1, height: 2 } });
  for (const fields of [undefined, [], null]) {
    const op = fields === undefined ? { op: 'upsertNode', kind: 'node.update', nodeId: next.nodeId, ...next }
      : nodeOp('node.update', next, { fields });
    const r = applyLogToProjection({ current: { nodes: [base], edges: [] }, entries: [ent(1, [op])] });
    assert.deepEqual(r.nodes[0].position, { x: 7, y: 8 });
    assert.deepEqual(r.nodes[0].data.title, 'W');
    assert.equal(r.nodes[0].nodeType, 'prompt');
  }
});

/* ══════════════ 位置优先（同域后 seq 胜） ══════════════ */

test('位置优先: 同域(position) 后 seq 胜；更晚的 data-only 陈旧行不回归位置', () => {
  const base = nodeRow('n-1');
  const r = applyLogToProjection({
    current: { nodes: [base], edges: [] },
    entries: [
      ent(3, [nodeOp('node.move', nodeRow('n-1', { position: { x: 50, y: 50 } }), { fields: ['position'] })]),
      ent(7, [nodeOp('node.move', nodeRow('n-1', { position: { x: 70, y: 80 } }), { fields: ['position'] })]), // 后 seq 胜
      ent(10, [nodeOp('node.update', nodeRow('n-1', { position: { x: 50, y: 50 }, data: { title: 'late-data' } }), { fields: ['data'] })]), // 陈旧的 x=50 不得回归
    ],
  });
  assert.deepEqual(r.nodes[0].position, { x: 70, y: 80 });
  assert.equal(r.nodes[0].data.title, 'late-data'); // data 域按自身 seq 取后胜
});

test('位置优先: zIndex 独立域 —— move 不碰 zIndex，zIndex-only update 后 seq 胜', () => {
  const base = nodeRow('n-1');
  const r = applyLogToProjection({
    current: { nodes: [base], edges: [] },
    entries: [
      ent(4, [nodeOp('node.update', nodeRow('n-1', { zIndex: 5 }), { fields: ['zIndex'] })]),
      ent(6, [nodeOp('node.move', nodeRow('n-1', { position: { x: 11, y: 22 } }), { fields: ['position'] })]),
      ent(8, [nodeOp('node.update', nodeRow('n-1', { zIndex: 9 }), { fields: ['zIndex'] })]),
    ],
  });
  assert.deepEqual(r.nodes[0].position, { x: 11, y: 22 });
  assert.equal(r.nodes[0].zIndex, 9);
});

/* ══════════════ merge 边：键并集 / 增删幂等重放 ══════════════ */

test('merge: 并发 upsert 不同边 → 键并集；同键 upsert 后 seq 整行胜', () => {
  const cur = { nodes: [nodeRow('n-a'), nodeRow('n-b')], edges: [edgeRow('e-0', { data: { v: 0 } })] };
  const r = applyLogToProjection({
    current: cur,
    entries: [
      ent(2, [edgeOp('edge.create', edgeRow('e-x', { sourceNodeId: 'n-a', targetNodeId: 'n-b', data: { from: 'A' } }))]),
      ent(4, [edgeOp('edge.create', edgeRow('e-y', { sourceNodeId: 'n-b', targetNodeId: 'n-a' }))]),
      ent(6, [edgeOp('edge.create', edgeRow('e-0', { data: { v: 6, from: 'B' } }))]), // 同键覆写
    ],
  });
  assert.deepEqual(ids(r.edges), ['e-0', 'e-x', 'e-y']); // 已有键保序 + 并集
  assert.deepEqual(r.edges[0].data, { v: 6, from: 'B' });
  assert.deepEqual(r.edges[1].data, { from: 'A' });
});

test('merge: 边增删幂等重放 —— 同一日志重放两次结果相同；删不存在键=无操作', () => {
  const entries = [
    ent(1, [edgeOp('edge.create', edgeRow('e-1')), edgeOp('edge.create', edgeRow('e-2'))]),
    ent(2, [edgeOp('edge.delete', null, { edgeId: 'e-1' })]),
    ent(3, [edgeOp('edge.delete', null, { edgeId: 'e-nope' })]),  // 删除不存在 → 幂等无操作
    ent(4, [edgeOp('edge.create', edgeRow('e-1', { data: { v: 'reborn' } }))]), // 删后重建
  ];
  const r1 = applyLogToProjection({ current: { nodes: [], edges: [edgeRow('e-old')] }, entries });
  assert.deepEqual(ids(r1.edges), ['e-old', 'e-2', 'e-1']);
  assert.deepEqual(r1.edges[2].data, { v: 'reborn' });
  // 幂等：在同一结果上再重放同一日志 → 不变（edge upsert 幂等 / delete 幂等）
  const r2 = applyLogToProjection({ current: r1, entries });
  assert.deepEqual(r2, r1);
  // 空画布全量重放同日志 → 相同图（e-2 与重建的 e-1）
  const fresh = applyLogToProjection({ current: { nodes: [], edges: [] }, entries });
  assert.deepEqual(fresh, { nodes: [], edges: r1.edges.filter((e) => e.edgeId !== 'e-old') });
});

test('merge: delete 后同 seq 段内 upsert 再 delete 再 upsert → 终态正确（按 seq 线性）', () => {
  const r = applyLogToProjection({
    current: { nodes: [], edges: [edgeRow('e-1')] },
    entries: [
      ent(1, [edgeOp('edge.delete', null, { edgeId: 'e-1' })]),
      ent(2, [edgeOp('edge.create', edgeRow('e-1', { data: { k: 2 } }))]),
      ent(3, [edgeOp('edge.delete', null, { edgeId: 'e-1' })]),
      ent(4, [edgeOp('edge.create', edgeRow('e-1', { data: { k: 4 } }))]),
    ],
  });
  assert.deepEqual(r.edges.map((e) => [e.edgeId, e.data]), [['e-1', { k: 4 }]]);
});

/* ══════════════ 排序 / 收敛 ══════════════ */

test('排序: 强乱序(seq 全倒排)输入 == 按 seq 升序重放（逐 op 线性收敛）', () => {
  const cur = { nodes: [nodeRow('n-1'), nodeRow('n-2')], edges: [] };
  const seqOps = [
    [1, nodeOp('node.move', nodeRow('n-1', { position: { x: 1, y: 1 } }), { fields: ['position'] })],
    [2, nodeOp('node.update', nodeRow('n-1', { data: { title: 'd2' } }), { fields: ['data'] })],
    [5, edgeOp('edge.create', edgeRow('e-a'))],
    [6, nodeOp('node.resize', nodeRow('n-2', { size: { width: 6, height: 6 } }), { fields: ['size'] })],
    [7, edgeOp('edge.delete', null, { edgeId: 'e-a' })],
    [8, edgeOp('edge.create', edgeRow('e-b'))],
    [9, nodeOp('node.move', nodeRow('n-1', { position: { x: 9, y: 9 } }), { fields: ['position'] })],
  ];
  const bySeq = seqOps.map(([s, op]) => ent(s, [op]));
  const shuffled = bySeq.slice().reverse(); // 输入倒序（同一次重放内逐 entry 乱序）
  const fromShuffled = applyLogToProjection({ current: cur, entries: shuffled });
  const fromSorted = applyLogToProjection({ current: cur, entries: bySeq });
  assert.deepEqual(fromShuffled, fromSorted);
  // 按 seq 线性：e-a 先 create(5) 后 delete(7) → 终态无 e-a；e-b(8) 保留
  assert.deepEqual(ids(fromShuffled.edges), ['e-b']);
  assert.deepEqual(fromShuffled.nodes.find((n) => n.nodeId === 'n-1').position, { x: 9, y: 9 });
  assert.equal(fromShuffled.nodes.find((n) => n.nodeId === 'n-1').data.title, 'd2');
  assert.deepEqual(fromShuffled.nodes.find((n) => n.nodeId === 'n-2').size, { width: 6, height: 6 });
});

test('排序: 无序输入与有序输入产出深度相等（纯函数收敛性）', () => {
  const mk = (entries) => applyLogToProjection({ current: { nodes: [nodeRow('n-1')], edges: [edgeRow('e-1')] }, entries });
  const base = [ent(3, [nodeOp('node.move', nodeRow('n-1', { position: { x: 3, y: 3 } }), { fields: ['position'] })]), ent(1, [edgeOp('edge.create', edgeRow('e-2'))])];
  assert.deepEqual(mk(base), mk(base.slice().reverse()));
});

/* ══════════════ 未知拒：ERR_REJECT_BUCKET_IN_LOG ══════════════ */

const rejectErr = (fn) => assert.throws(fn, (e) => e.code === ERROR_CODES.REJECT_BUCKET_IN_LOG);

test('未知拒: ops 含 node.create(nodeId 不在快照也拒——reject 桶永不入 log) → ERR_REJECT_BUCKET_IN_LOG', () => {
  rejectErr(() => applyLogToProjection({
    current: { nodes: [], edges: [] },
    entries: [ent(1, [{ op: 'upsertNode', kind: 'node.create', nodeId: 'n-new' }])],
  }));
});

test('未知拒: ops 含 node.delete → ERR_REJECT_BUCKET_IN_LOG', () => {
  rejectErr(() => applyLogToProjection({
    current: { nodes: [nodeRow('n-1')], edges: [] },
    entries: [ent(1, [{ op: 'deleteNode', kind: 'node.delete', nodeId: 'n-1' }])],
  }));
});

test('未知拒: payload.bucket=reject409（reject 桶入 log）→ ERR_REJECT_BUCKET_IN_LOG', () => {
  rejectErr(() => applyLogToProjection({
    current: { nodes: [], edges: [] },
    entries: [ent(1, [nodeOp('node.update', nodeRow('n-1'), { fields: ['data'] })], { bucket: BUCKET.REJECT409 })],
  }));
});

test('未知拒: payload.bucket 未知字符串 → ERR_REJECT_BUCKET_IN_LOG', () => {
  rejectErr(() => applyLogToProjection({
    current: { nodes: [], edges: [] },
    entries: [ent(1, [], { bucket: 'fast-forward' })],
  }));
});

test('未知拒: command_type 非 canvas.patch 且非 append（如 node.create / workflow.apply / 未知）→ ERR_REJECT_BUCKET_IN_LOG', () => {
  for (const t of ['node.create', 'workflow.apply', 'director.camera.update', 'totally.unknown']) {
    rejectErr(() => applyLogToProjection({
      current: { nodes: [], edges: [] },
      entries: [{ command_id: 'c-1', command_type: t, seq: 1, payload: { ops: [] } }],
    }));
  }
});

/* ══════════════ 校验：形状 / 日志内容 ══════════════ */

const argErr = (fn) => assert.throws(fn, (e) => e.code === ERROR_CODES.INVALID_ARGUMENT);
const logErr = (fn) => assert.throws(fn, (e) => e.code === ERROR_CODES.INVALID_LOG);

test('校验: entries 缺失/非数组 → ERR_INVALID_ARGUMENT', () => {
  argErr(() => applyLogToProjection());
  argErr(() => applyLogToProjection({ current: { nodes: [], edges: [] } }));
  argErr(() => applyLogToProjection({ current: { nodes: [], edges: [] }, entries: 'x' }));
});

test('校验: 多 entry 缺 seq 或 seq 重复 → ERR_INVALID_ARGUMENT（LWW 排序前提）', () => {
  argErr(() => applyLogToProjection({
    current: { nodes: [], edges: [] },
    entries: [{ command_type: 'canvas.patch', payload: { ops: [] } }, { command_type: 'canvas.patch', seq: 2, payload: { ops: [] } }],
  }));
  argErr(() => applyLogToProjection({
    current: { nodes: [], edges: [] },
    entries: [ent(1, []), ent(1, [])],
  }));
});

test('校验: entry 缺 command_type / 值非字符串 → ERR_INVALID_LOG', () => {
  logErr(() => applyLogToProjection({ current: {}, entries: [{ seq: 1, payload: { ops: [] } }] }));
  logErr(() => applyLogToProjection({ current: {}, entries: [{ command_type: 42, seq: 1, payload: { ops: [] } }] }));
});

test('校验: payload 非对象 / ops 非数组(如 legacy 计数对象) → ERR_INVALID_LOG（不可重放行显式拒绝）', () => {
  logErr(() => applyLogToProjection({ current: {}, entries: [{ command_type: 'canvas.patch', seq: 1, payload: 'x' }] }));
  logErr(() => applyLogToProjection({
    current: {}, entries: [ent(1, { nodeUpserts: 1, nodeDeletes: 0 })], // recordCanvasPatch legacy 计数
  }));
});

test('校验: op 缺 op/kind、op↔kind 不匹配、未知 op → ERR_INVALID_LOG', () => {
  logErr(() => applyLogToProjection({ current: {}, entries: [ent(1, [{ kind: 'node.update', nodeId: 'n-1' }])] }));
  logErr(() => applyLogToProjection({ current: {}, entries: [ent(1, [{ op: 'upsertNode', nodeId: 'n-1' }])] }));
  logErr(() => applyLogToProjection({
    current: { nodes: [], edges: [] },
    entries: [ent(1, [{ op: 'upsertNode', kind: 'edge.create', edgeId: 'e-1' }])],
  }));
  logErr(() => applyLogToProjection({ current: {}, entries: [ent(1, [{ op: 'frobnicate', kind: 'node.update' }])] }));
});

test('校验: upsert 行缺键 / 未知节点域 → ERR_INVALID_LOG', () => {
  logErr(() => applyLogToProjection({ current: {}, entries: [ent(1, [{ op: 'upsertNode', kind: 'node.update', position: { x: 1, y: 2 } }])] }));
  logErr(() => applyLogToProjection({ current: {}, entries: [ent(1, [{ op: 'upsertEdge', kind: 'edge.create', sourceNodeId: 'n-a' }])] }));
  logErr(() => applyLogToProjection({
    current: { nodes: [nodeRow('n-1')], edges: [] },
    entries: [ent(1, [nodeOp('node.update', nodeRow('n-1'), { fields: ['warp-speed'] })])],
  }));
});

test('校验: payload.bucket 与 op kind 派生桶不一致 → ERR_INVALID_LOG', () => {
  logErr(() => applyLogToProjection({
    current: { nodes: [], edges: [] },
    entries: [ent(1, [edgeOp('edge.create', edgeRow('e-1'))], { bucket: BUCKET.LWW })],
  }));
});

test('校验: command_id 双键值冲突 → ERR_INVALID_LOG', () => {
  logErr(() => applyLogToProjection({
    current: {},
    entries: [{ command_id: 'a', commandId: 'b', command_type: 'canvas.patch', seq: 1, payload: { ops: [] } }],
  }));
});

/* ══════════════ append 类 / 视图忽略 ══════════════ */

test('append: command_type presence./comment. 前缀 → view 忽略（payload 任意形状不炸）', () => {
  const cur = { nodes: [nodeRow('n-1')], edges: [edgeRow('e-1')] };
  for (const t of ['presence.heartbeat', 'comment.create', 'annotation.add']) {
    const r = applyLogToProjection({
      current: cur,
      entries: [{ command_id: `c-${t}`, command_type: t, seq: 1, payload: 42 }],
    });
    assert.deepEqual(r, { nodes: [cur.nodes[0]], edges: [cur.edges[0]] });
  }
});

test('append: canvas.patch ops 内含 append 前缀 kind → 该 op 忽略，其余照常', () => {
  const r = applyLogToProjection({
    current: { nodes: [nodeRow('n-1')], edges: [] },
    entries: [ent(1, [
      { op: 'upsertNode', kind: 'node.move', nodeId: 'n-1', fields: ['position'], ...nodeRow('n-1', { position: { x: 42, y: 42 } }) },
      { op: 'upsertNode', kind: 'comment.create', nodeId: 'n-1' }, // append 前缀 → 忽略
    ])],
  });
  assert.deepEqual(r.nodes[0].position, { x: 42, y: 42 });
  assert.equal(r.nodes.length, 1);
});

test('view 忽略: canvas.viewport.update op 与空 ops 行 → 图投影不变', () => {
  const cur = { nodes: [nodeRow('n-1')], edges: [edgeRow('e-1')] };
  const vp = applyLogToProjection({
    current: cur,
    entries: [ent(1, [{ op: 'viewport', kind: 'canvas.viewport.update', fields: ['x', 'y', 'zoom'], viewport: { x: 9, y: 9, zoom: 2 } }])],
  });
  assert.deepEqual(vp, { nodes: [cur.nodes[0]], edges: [cur.edges[0]] });
  const empty = applyLogToProjection({ current: cur, entries: [ent(1, [])] });
  assert.deepEqual(empty, { nodes: [cur.nodes[0]], edges: [cur.edges[0]] });
});

test('稳健: 快照缺节点时 node.update 整行兜底入投影（正常日志不触发，防御路径）', () => {
  const r = applyLogToProjection({
    current: { nodes: [], edges: [] },
    entries: [ent(1, [nodeOp('node.update', nodeRow('n-new'))])],
  });
  assert.equal(r.nodes.length, 1);
  assert.deepEqual(r.nodes[0].data.title, 'T-n-new');
});

/* ══════════════ 纯性：深冻结入参零突变、零别名 ══════════════ */

const deepFreeze = (o) => {
  if (o && typeof o === 'object') { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); }
  return o;
};

test('纯性: 深冻结入参调用成功、零突变；输出与入参零别名；重复调用深度相等', () => {
  const input = deepFreeze({
    current: {
      nodes: [nodeRow('n-1'), nodeRow('n-2')],
      edges: [edgeRow('e-1'), edgeRow('e-2')],
    },
    entries: [
      ent(1, [nodeOp('node.move', nodeRow('n-1', { position: { x: 100, y: 100 } }), { fields: ['position'] }), edgeOp('edge.delete', null, { edgeId: 'e-2' })]),
      ent(2, [nodeOp('node.update', nodeRow('n-2', { data: { title: 'frozen-data' } }), { fields: ['data'] }), edgeOp('edge.create', edgeRow('e-9'))]),
    ],
  });
  const snapshot = JSON.stringify(input);
  const r1 = applyLogToProjection(input);
  const r2 = applyLogToProjection(input);
  assert.deepEqual(r1, r2);                                  // 纯：同入参 → 同输出
  assert.equal(JSON.stringify(input), snapshot);             // 入参零突变
  assert.notEqual(r1.nodes[0], input.current.nodes[0]);      // 零别名
  assert.notEqual(r1.nodes[1].data, input.current.nodes[1].data);
  r1.nodes[0].position.x = -999; r1.edges[0].data.hack = 1;  // 改输出不影响下一次调用/入参
  const r3 = applyLogToProjection(input);
  assert.deepEqual(r3, r2);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(r3.nodes[0].position, { x: 100, y: 100 });
});

test('纯性: 全部节点/边未命中的行也以副本返回（不动输入对象引用）', () => {
  const cur = deepFreeze({ nodes: [nodeRow('n-1')], edges: [edgeRow('e-1')] });
  const r = applyLogToProjection({ current: cur, entries: deepFreeze([ent(1, [])]) });
  assert.equal(r.nodes[0] === cur.nodes[0], false);
  assert.equal(r.edges[0] === cur.edges[0], false);
  assert.deepEqual(r.nodes[0], cur.nodes[0]);
});

/* ══════════════ BUCKET 常量同源 ══════════════ */

test('BUCKET: 与 canvasCommandDecomposer 桶同源（reject 桶存在但不可入 log）', () => {
  assert.equal(BUCKET.REJECT409, 'reject409');
  assert.equal(BUCKET.LWW, 'lww');
  assert.equal(BUCKET.MERGE, 'merge');
  assert.equal(BUCKET.APPEND, 'append');
  assert.deepEqual(Object.values(BUCKET).slice().sort(), BUCKET_KEYS.slice().sort());
  assert.deepEqual(LOGGED_BUCKETS.slice().sort(), ['append', 'lww', 'merge']);
  assert.equal(LOGGED_BUCKETS.includes(BUCKET.REJECT409), false); // design 约定：reject 不入 log
  // kind → 桶 与拆解器静态表一致（node.create/node.delete 属 reject409 在投影侧被拒）
  assert.equal(KIND_BUCKET_BY_COMMAND['node.move'], BUCKET.LWW);
  assert.equal(KIND_BUCKET_BY_COMMAND['node.update'], BUCKET.LWW);
  assert.equal(KIND_BUCKET_BY_COMMAND['node.create'], BUCKET.REJECT409);
  assert.equal(KIND_BUCKET_BY_COMMAND['edge.create'], BUCKET.MERGE);
  assert.equal(KIND_BUCKET_BY_COMMAND['edge.delete'], BUCKET.MERGE);
});

/* ══════════════ 嵌套行 / 别名键 兼容 ══════════════ */

test('兼容: op.node/op.edge 嵌套行 与 DB 原行 snake_case(command_id/type) 均可用', () => {
  const r = applyLogToProjection({
    current: { nodes: [nodeRow('n-1')], edges: [] },
    entries: [{
      command_id: 'c-1', type: 'canvas.patch', seq: 1,
      payload: { ops: [
        { op: 'upsertNode', kind: 'node.move', nodeId: 'n-1', fields: ['position'], node: nodeRow('n-1', { position: { x: 77, y: 88 } }) },
        { op: 'upsertEdge', kind: 'edge.create', edge: edgeRow('e-n', { sourceNodeId: 'n-1' }) },
      ] },
    }],
  });
  assert.deepEqual(r.nodes[0].position, { x: 77, y: 88 });
  assert.deepEqual(ids(r.edges), ['e-n']);
});

test('兼容: listAfter fromRow camelCase 行(commandId/commandType) 可用', () => {
  const r = applyLogToProjection({
    current: { nodes: [nodeRow('n-1')], edges: [] },
    entries: [{ commandId: 'c-1', commandType: 'canvas.patch', seq: 1, payload: { ops: [nodeOp('node.move', nodeRow('n-1', { position: { x: 5, y: 6 } }), { fields: ['position'] })] } }],
  });
  assert.deepEqual(r.nodes[0].position, { x: 5, y: 6 });
});
