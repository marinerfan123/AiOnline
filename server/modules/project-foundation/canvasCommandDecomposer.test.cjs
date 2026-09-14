'use strict';
/**
 * G22 CAS 拆解① — canvasCommandDecomposer.cjs 单测（叶 2，纯函数）。
 * 覆盖：各桶样例 / 新节点 vs 更新节点分流 / node.move|resize 细分 / loadGraph 必
 * reject / 未知键拒 / 形状校验 / 空 patch / ctx 三态 / KIND_BUCKET_BY_COMMAND 契约对齐。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decomposeCanvasPatch, KIND_BUCKET_BY_COMMAND, REASONS } = require('./canvasCommandDecomposer.cjs');
const { COMMAND_TYPES } = require('../studio-contracts/envelopes.cjs');
const { conflictPolicyFor } = require('../studio-contracts/collabContract.cjs');

/* ── 样例构造（对齐 persistence.ts 序列化形状 / studioCanvasPersistence 测试风格） ── */
function node(id, over = {}) {
  return {
    nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1,
    position: { x: 10, y: 20 }, size: { width: 260, height: 120 }, zIndex: 0,
    data: { nodeKind: 'prompt', schemaVersion: 1, title: `T-${id}`, status: 'IDLE', parameters: { a: 1 } },
    ...over,
  };
}
function edge(id, over = {}) {
  return { edgeId: id, sourceNodeId: 'n-a', targetNodeId: 'n-b', sourceHandle: null, targetHandle: null, edgeType: 'data', data: {}, ...over };
}
const P = (ops) => decomposeCanvasPatch({ ops }, { existingNodes: [node('n-a'), node('n-b')], existingEdges: [edge('e-1')] });

/* ── 各桶样例 ─────────────────────────────────────────────────────── */

test('lww: 仅 data 变更的已有节点 → node.update 单条 lww, fields=["data"]', () => {
  const r = P({ upsertNodes: [node('n-a', { data: { nodeKind: 'prompt', schemaVersion: 1, title: 'T-renamed', status: 'IDLE', parameters: {} } })] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.buckets.lww.map((o) => [o.op, o.kind, o.reason, o.fields]), [
    ['upsertNode', 'node.update', REASONS.NODE_UPDATE_DATA_ONLY, ['data']],
  ]);
  assert.equal(r.buckets.reject409.length, 0);
  assert.equal(r.buckets.merge.length, 0);
  assert.equal(r.summary.structural, false);
});

test('lww: viewport-only patch → canvas.viewport.update lww', () => {
  const r = decomposeCanvasPatch({ ops: { viewport: { x: 1, y: 2, zoom: 1.5 } } }, { existingNodes: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.buckets.lww.map((o) => [o.kind, o.reason]), [['canvas.viewport.update', REASONS.VIEWPORT_PARAM_UPDATE]]);
  assert.equal(r.summary.byBucket.lww, 1);
});

test('merge: upsertEdges（新边）+ deleteEdgeIds → 全归 merge', () => {
  const r = P({ upsertEdges: [edge('e-new'), edge('e-1', { data: { label: 'x' } })], deleteEdgeIds: ['e-0'] });
  assert.equal(r.ok, true);
  assert.equal(r.buckets.merge.length, 3);
  assert.deepEqual(r.buckets.merge.map((o) => [o.kind, o.edgeId, o.reason]), [
    ['edge.create', 'e-new', REASONS.EDGE_CREATE_NEW_ID],
    ['edge.create', 'e-1', REASONS.EDGE_UPSERT_OVERWRITE], // 词表无 edge.update → 元素键覆写仍 merge
    ['edge.delete', 'e-0', REASONS.EDGE_DELETE_ELEMENT],
  ]);
  assert.equal(r.buckets.reject409.length, 0);
  assert.equal(r.buckets.lww.length, 0);
});

test('reject409: deleteNodeIds → node.delete 结构删除', () => {
  const r = P({ deleteNodeIds: ['n-a'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.buckets.reject409.map((o) => [o.op, o.kind, o.nodeId, o.reason]), [
    ['deleteNode', 'node.delete', 'n-a', REASONS.NODE_DELETE_STRUCTURAL],
  ]);
  assert.equal(r.summary.structural, true);
});

test('append: canvas PATCH 词表永不产出 append（桶恒空）', () => {
  const r = P({ upsertNodes: [node('n-a')], upsertEdges: [edge('e-1')], viewport: { x: 0, y: 0, zoom: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.buckets.append, []);
  assert.equal(r.summary.byBucket.append, 0);
});

/* ── 新节点 vs 更新节点分流 ───────────────────────────────────────── */

test('分流: 同 patch 新节点(n-new)→reject409 node.create, 已有节点(n-a)→lww node.update', () => {
  const r = P({ upsertNodes: [node('n-a', { data: { nodeKind: 'prompt', schemaVersion: 1, title: 'B', status: 'IDLE', parameters: {} } }), node('n-new')] });
  assert.equal(r.ok, true);
  assert.equal(r.buckets.reject409.length, 1);
  assert.deepEqual([r.buckets.reject409[0].kind, r.buckets.reject409[0].nodeId, r.buckets.reject409[0].reason], ['node.create', 'n-new', REASONS.NODE_CREATE_NEW_ID]);
  assert.equal(r.buckets.lww.length, 1);
  assert.equal(r.buckets.lww[0].kind, 'node.update');
  assert.equal(r.buckets.lww[0].nodeId, 'n-a');
  assert.equal(r.summary.structural, true); // 含 node.create ⇒ 整 patch 需过 CAS 门
});

test('分流: 空画布基线 existingNodes:[] → 一切 upsert 都是 node.create(reject)', () => {
  const r = decomposeCanvasPatch({ ops: { upsertNodes: [node('n-1')] } }, { existingNodes: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.buckets.reject409.map((o) => o.kind), ['node.create']);
  assert.equal(r.buckets.lww.length, 0);
});

test('分流: 完全不传 ctx → 默认 node.update(lww) 并给 warning（无法判别新建）', () => {
  const r = decomposeCanvasPatch({ ops: { upsertNodes: [node('n-a')] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.buckets.lww.map((o) => [o.kind, o.reason]), [['node.update', REASONS.NODE_UPDATE_NO_BASELINE]]);
  assert.ok(r.warnings.some((w) => w.includes('n-a')));
  assert.equal(r.buckets.reject409.length, 0);
});

/* ── node 细分：move / resize / update ────────────────────────────── */

test('细分: 仅 position 变 → node.move', () => {
  const r = P({ upsertNodes: [node('n-a', { position: { x: 999, y: 999 } })] });
  assert.equal(r.buckets.lww.length, 1);
  assert.deepEqual([r.buckets.lww[0].kind, r.buckets.lww[0].fields], ['node.move', ['position']]);
});

test('细分: 仅 size 变 → node.resize', () => {
  const r = P({ upsertNodes: [node('n-a', { size: { width: 500, height: 300 } })] });
  assert.equal(r.buckets.lww.length, 1);
  assert.deepEqual([r.buckets.lww[0].kind, r.buckets.lww[0].fields], ['node.resize', ['size']]);
});

test('细分: position+data 同变 → node.update(整行覆写语义, fields 列两域)', () => {
  const r = P({ upsertNodes: [node('n-a', { position: { x: 5, y: 6 }, data: { nodeKind: 'prompt', schemaVersion: 1, title: 'Z', status: 'IDLE', parameters: {} } })] });
  assert.equal(r.buckets.lww.length, 1);
  assert.equal(r.buckets.lww[0].kind, 'node.update');
  assert.deepEqual(r.buckets.lww[0].fields.sort(), ['data', 'position']);
});

test('细分: 完全相同的 upsert（幂等 no-op）→ node.update(多域空变更集)', () => {
  const r = P({ upsertNodes: [node('n-a')] });
  assert.equal(r.buckets.lww.length, 1);
  assert.equal(r.buckets.lww[0].kind, 'node.update');
  assert.deepEqual(r.buckets.lww[0].fields, []);
});

/* ── loadGraph 必 reject ──────────────────────────────────────────── */

test('loadGraph: 无论是否混有参数 patch 一律 reject409（整图替换 = 结构变更）', () => {
  const alone = decomposeCanvasPatch({ ops: { loadGraph: true } }, { existingNodes: [] });
  assert.equal(alone.ok, true);
  assert.deepEqual(alone.buckets.reject409.map((o) => [o.op, o.kind, o.reason, o.policy]), [
    ['loadGraph', null, REASONS.LOAD_GRAPH_STRUCTURAL_REPLACE, 'reject-409'],
  ]);
  assert.equal(alone.summary.structural, true);

  const mixed = P({ loadGraph: { nodes: [], edges: [] }, upsertNodes: [node('n-a')], viewport: { x: 1, y: 1, zoom: 1 } });
  assert.equal(mixed.ok, true);
  assert.ok(mixed.buckets.reject409.some((o) => o.op === 'loadGraph'));
  assert.equal(mixed.summary.structural, true); // 混合 kind ⇒ 整 patch 必须走 CAS 门
});

/* ── 未知键 / 形状校验拒 ──────────────────────────────────────────── */

test('未知 ops 键 → ok:false 拒', () => {
  const r = decomposeCanvasPatch({ ops: { bogusKey: [1] } }, { existingNodes: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unknown ops key: bogusKey')));
});

test('未知顶层键（wrapper/flat）→ 拒', () => {
  const w = decomposeCanvasPatch({ ops: {}, wat: 1 }, {});
  assert.equal(w.ok, false);
  assert.ok(w.errors.some((e) => e.includes('unknown top-level key: wat')));
  const f = decomposeCanvasPatch({ upsertNodes: [], totallyUnknown: 1 }, {});
  assert.equal(f.ok, false);
});

test('canonical + 别名同给（deleteNodeIds+deleteNodes）→ 歧义拒', () => {
  const r = decomposeCanvasPatch({ ops: { deleteNodeIds: ['x'], deleteNodes: ['x'] } }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ambiguous ops keys')));
});

test('legacy 别名 deleteNodes/deleteEdges 平铺可接受（任务域拼写兼容）', () => {
  const r = decomposeCanvasPatch({ deleteNodes: ['n-a'], deleteEdges: ['e-1'] }, { existingNodes: [node('n-a')], existingEdges: [edge('e-1')] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.buckets.reject409.map((o) => [o.kind, o.nodeId]), [['node.delete', 'n-a']]);
  assert.deepEqual(r.buckets.merge.map((o) => o.kind), ['edge.delete']);
});

test('形状: 非数组 op / 缺 nodeId / 缺 edgeId / 重复 id / 非字符串删除 id → 拒', () => {
  const cases = [
    { ops: { upsertNodes: 'not-array' } },
    { ops: { upsertNodes: [{}] } },
    { ops: { upsertEdges: [{ sourceNodeId: 'a' }] } },
    { ops: { upsertNodes: [node('n-x'), node('n-x')] } },
    { ops: { deleteNodeIds: [42] } },
    { ops: { viewport: 'v' } },
    { ops: { loadGraph: 42 } },
  ];
  for (const c of cases) {
    const r = decomposeCanvasPatch(c, { existingNodes: [], existingEdges: [] });
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(c.ops)}`);
    assert.ok(r.errors.length >= 1);
  }
});

test('空 patch（无任何 op/数组空）→ EMPTY_PATCH 拒', () => {
  const r = decomposeCanvasPatch({ ops: {} }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e === 'EMPTY_PATCH: no upsert/delete ops, viewport, or loadGraph present'));
});

test('ctx 未知键 / 坏类型 → 校验失败拒', () => {
  const badKey = decomposeCanvasPatch({ ops: { upsertNodes: [node('a')] } }, { bogus: [] });
  assert.equal(badKey.ok, false);
  assert.ok(badKey.errors.some((e) => e.includes('invalid ctx')));
});

/* ── 输入形态 / 输出结构 ──────────────────────────────────────────── */

test('wrapper 与平铺两种输入等价', () => {
  const w = decomposeCanvasPatch({ ops: { deleteNodeIds: ['n-a'] }, baseRevision: 3, clientMutationId: 'cm-1' }, {});
  const f = decomposeCanvasPatch({ deleteNodeIds: ['n-a'], baseRevision: 3, clientMutationId: 'cm-1' }, {});
  assert.equal(w.ok, true);
  assert.deepEqual(w.buckets, f.buckets);
});

test('输出结构完整: 四桶恒定 + summary + per-op policy', () => {
  const r = P({ upsertNodes: [node('n-new')], deleteNodeIds: ['n-a'], viewport: { x: 0, y: 0, zoom: 1 } });
  assert.equal(r.ok, true);
  for (const k of ['reject409', 'lww', 'merge', 'append']) assert.ok(Array.isArray(r.buckets[k]));
  assert.deepEqual(r.summary.byBucket, { reject409: 2, lww: 1, merge: 0, append: 0 });
  assert.equal(r.summary.total, 3);
  for (const bucket of Object.values(r.buckets)) for (const op of bucket) {
    assert.ok(typeof op.reason === 'string' && op.reason.length > 0);
    assert.ok(['reject-409', 'last-write-wins', 'merge', 'append'].includes(op.policy));
  }
});

/* ── KIND_BUCKET_BY_COMMAND 契约对齐 ──────────────────────────────── */

test('KIND_BUCKET_BY_COMMAND: 键均 ∈ COMMAND_TYPES(35) 且与 CONFLICT_POLICY_BY_KIND 同源', () => {
  const kinds = Object.keys(KIND_BUCKET_BY_COMMAND);
  assert.equal(kinds.length, 8);
  for (const k of kinds) {
    assert.ok(COMMAND_TYPES.includes(k), `${k} must be a registered command type`);
    const policy = conflictPolicyFor(k);
    const expected = { 'reject-409': 'reject409', 'last-write-wins': 'lww', merge: 'merge', append: 'append' }[policy];
    assert.equal(KIND_BUCKET_BY_COMMAND[k], expected, `${k}: bucket must match contract policy ${policy}`);
  }
  // 关键语义锚点
  assert.equal(KIND_BUCKET_BY_COMMAND['node.create'], 'reject409');
  assert.equal(KIND_BUCKET_BY_COMMAND['node.delete'], 'reject409');
  assert.equal(KIND_BUCKET_BY_COMMAND['node.move'], 'lww');
  assert.equal(KIND_BUCKET_BY_COMMAND['node.resize'], 'lww');
  assert.equal(KIND_BUCKET_BY_COMMAND['node.update'], 'lww');
  assert.equal(KIND_BUCKET_BY_COMMAND['canvas.viewport.update'], 'lww');
  assert.equal(KIND_BUCKET_BY_COMMAND['edge.create'], 'merge');
  assert.equal(KIND_BUCKET_BY_COMMAND['edge.delete'], 'merge');
  assert.equal(KIND_BUCKET_BY_COMMAND['edge.update'], undefined); // 词表无 edge.update —— 已知边覆写仍 edge.create/merge
});

test('桶中 kind 值域 ⊆ KIND_BUCKET_BY_COMMAND ∪ {null=loadGraph}', () => {
  const r = P({ upsertNodes: [node('n-x'), node('n-a')], deleteNodeIds: ['n-b'], upsertEdges: [edge('e-x')], deleteEdgeIds: ['e-9'], loadGraph: true, viewport: { x: 0, y: 0, zoom: 1 } });
  for (const bucket of Object.values(r.buckets)) {
    for (const op of bucket) {
      if (op.kind === null) continue; // 仅 loadGraph（词表无 canvas.replace 类）
      assert.ok(Object.prototype.hasOwnProperty.call(KIND_BUCKET_BY_COMMAND, op.kind), `kind ${op.kind} must be in KIND_BUCKET_BY_COMMAND`);
    }
  }
});
