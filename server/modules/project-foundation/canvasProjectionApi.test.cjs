'use strict';
/**
 * G22 Phase-4 — canvasProjectionApi.cjs 投影读重建面测试。
 * =============================================================================
 * 假 pg 忠实模拟 canvas 域 PostgreSQL 语义（对齐 studioCanvasPersistence.test.cjs
 * 的 mock 约定）:
 *   - 单事务 REPEATABLE READ: BEGIN 冻结整份状态快照, 事务内读用冻结快照, COMMIT
 *     弃快照, ROLLBACK 还原 —— 模拟真实 MVCC 一致窗口(跨语句读同一份快照)。
 *   - BIGINT(seq) 以字符串返回(node-pg int8 → string), 验证 Number() 归一。
 *   - jsonb(data_json) SELECT 返回解析后对象; listAfter 返回 camelCase 行。
 *   - 可注入 preQuery 钩子(按 SQL 匹配)在查询执行前写入「并发已提交写」—— 用于
 *     验证基线守卫: 窗口内读不受其间提交的 CAS/kind 写影响, delta 按 seq<=logMax 过滤。
 * 覆盖(任务验收): 全重建 / 增量透传(零重建) / 快照-日志窗口一致性 / 空日志回快照 /
 *   非法 afterSeq; 另附构造守卫 / 鉴权钩子 / 无画布 / 非 GET / CAS 计数行跳过。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasProjectionApi } = require('./canvasProjectionApi.cjs');

/* ── wire 行 → snake 行（对齐 studioCanvasPersistence.formatNode/formatEdge） ── */
function nodeRow(id, over = {}) {
  return {
    nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1,
    position: { x: 10, y: 20 }, size: { width: 260, height: 120 }, zIndex: 0,
    data: { nodeKind: 'prompt', schemaVersion: 1, title: `T-${id}`, status: 'IDLE', parameters: {} },
    ...over,
  };
}
function edgeRow(id, over = {}) {
  return { edgeId: id, sourceNodeId: 'n-a', targetNodeId: 'n-b', sourceHandle: null, targetHandle: null, edgeType: 'data', data: {}, ...over };
}
function toNodeSnake(n) {
  return {
    node_id: n.nodeId, node_type: n.nodeType, node_schema_version: n.nodeSchemaVersion,
    position_x: n.position.x, position_y: n.position.y,
    width: n.size ? n.size.width : null, height: n.size ? n.size.height : null,
    z_index: n.zIndex == null ? null : n.zIndex, data_json: n.data,
  };
}
function toEdgeSnake(e) {
  return {
    edge_id: e.edgeId, source_node_id: e.sourceNodeId, source_handle: e.sourceHandle,
    target_node_id: e.targetNodeId, target_handle: e.targetHandle,
    edge_type: e.edgeType, data_json: e.data,
  };
}
/* ── 日志 payload（对齐 recordCanvasPatch 三类真实写链行） ─────────── */
function lwwPayload(nodeId, data) {
  return {
    baseRevision: 1, mode: 'kind-scoped-lww',
    ops: [{ op: 'upsertNode', kind: 'node.update', nodeId, fields: ['data'], reason: 'NODE_UPDATE_DATA_ONLY', data }],
  };
}
function mergeUpsertPayload(edge) {
  return { baseRevision: 1, mode: 'kind-scoped-merge', ops: [{ op: 'upsertEdge', kind: 'edge.create', edgeId: edge.edgeId, reason: 'EDGE_CREATE_NEW_ID', edge }] };
}
function mergeDeletePayload(edgeId) {
  return { baseRevision: 1, mode: 'kind-scoped-merge', ops: [{ op: 'deleteEdge', kind: 'edge.delete', edgeId, reason: 'EDGE_DELETE_ELEMENT' }] };
}
const CAS_COUNT_PAYLOAD = { baseRevision: 1, ops: { nodeUpserts: 1, nodeDeletes: 0, edgeUpserts: 1, edgeDeletes: 0 } };

/* ── 假 pg ───────────────────────────────────────────────────────── */
function createFakePg() {
  const state = {
    canvases: new Map(),   // projectId -> {id, revision, schema_version}
    nodes: new Map(),      // canvasId -> Map<node_id, snakeRow>
    edges: new Map(),      // canvasId -> Map<edge_id, snakeRow>
    log: new Map(),        // canvasId -> Map<command_id, logRow>
    nextSeq: 0,
  };
  let txSnap = null;
  const hooks = [];        // { match: RegExp, fn: () => void }

  const mapOf = (m, k) => { if (!m.has(k)) m.set(k, new Map()); return m.get(k); };

  function snap() {
    const cloneMap = (m) => {
      const out = new Map();
      for (const [k, inner] of m) out.set(k, new Map([...inner].map(([kk, v]) => [kk, structuredClone(v)])));
      return out;
    };
    return {
      canvases: new Map([...state.canvases].map(([k, v]) => [k, structuredClone(v)])),
      nodes: cloneMap(state.nodes),
      edges: cloneMap(state.edges),
      log: cloneMap(state.log),
      nextSeq: state.nextSeq,
    };
  }

  async function query(sqlRaw, params = []) {
    const sql = String(sqlRaw).trim();
    for (const h of [...hooks]) if (h.match.test(sql)) h.fn(); // 并发写注入(查询执行前)
    const S = txSnap || state;
    if (sql === 'BEGIN' || sql.startsWith('BEGIN ')) { txSnap = snap(); return { rows: [], rowCount: 0 }; }
    if (sql === 'COMMIT') { txSnap = null; return { rows: [], rowCount: 0 }; }
    if (sql === 'ROLLBACK') { txSnap = null; return { rows: [], rowCount: 0 }; }

    if (sql.includes('FROM studio_canvases')) {
      const [projectId] = params;
      const c = S.canvases.get(projectId);
      return { rows: c ? [{ id: c.id, revision: c.revision, schema_version: c.schema_version }] : [], rowCount: c ? 1 : 0 };
    }
    if (sql.includes('MAX(seq)') && sql.includes('canvas_command_log')) {
      const [canvasId] = params;
      const rows = [...(S.log.get(canvasId) || new Map()).values()];
      const max = rows.length ? Math.max(...rows.map((r) => Number(r.seq))) : 0;
      return { rows: [{ seq: String(max) }], rowCount: 1 };
    }
    if (sql.includes('FROM studio_canvas_nodes')) {
      const [canvasId] = params;
      const rows = [...(S.nodes.get(canvasId) || new Map()).values()]
        .sort((a, b) => (a.node_id < b.node_id ? -1 : 1))
        .map((r) => structuredClone(r));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM studio_canvas_edges')) {
      const [canvasId] = params;
      const rows = [...(S.edges.get(canvasId) || new Map()).values()]
        .sort((a, b) => (a.edge_id < b.edge_id ? -1 : 1))
        .map((r) => structuredClone(r));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM canvas_command_log')) { // listAfter (seq 升序, 开区间)
      const [canvasId, afterSeq] = params;
      const rows = [...(S.log.get(canvasId) || new Map()).values()]
        .filter((r) => Number(r.seq) > Number(afterSeq))
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((r) => ({
          canvas_id: r.canvas_id, seq: String(r.seq), command_id: r.command_id, type: r.type,
          actor_id: r.actor_id, base_revision: r.base_revision, payload: r.payload, received_at: r.received_at,
        }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`fake pg unhandled SQL: ${sql}`);
  }

  return {
    pg: {
      query,
      connect: async () => ({ query, release: () => {} }),
    },
    query,
    hook(match, fn) { hooks.push({ match, fn }); },
    setCanvas(projectId, canvasId, revision = 1) {
      state.canvases.set(projectId, { id: canvasId, revision, schema_version: 1 });
    },
    addNode(canvasId, wire) { mapOf(state.nodes, canvasId).set(wire.nodeId, toNodeSnake(wire)); },
    addEdge(canvasId, wire) { mapOf(state.edges, canvasId).set(wire.edgeId, toEdgeSnake(wire)); },
    addLog(canvasId, { commandId, payload, type = 'canvas.patch' }) {
      state.nextSeq += 1;
      const seq = String(state.nextSeq);
      mapOf(state.log, canvasId).set(commandId, {
        canvas_id: canvasId, seq, command_id: commandId, type, actor_id: 'u-1',
        base_revision: 1, payload: structuredClone(payload), received_at: new Date(),
      });
      return Number(seq);
    },
    logMax(canvasId) {
      const rows = [...(state.log.get(canvasId) || new Map()).values()];
      return rows.length ? Math.max(...rows.map((r) => Number(r.seq))) : 0;
    },
    addEdgeLog(canvasId, { commandId, edge }) {
      return this.addLog(canvasId, { commandId, payload: mergeUpsertPayload(edge) });
    },
  };
}

/* ── helpers ─────────────────────────────────────────────────────── */
function makeApi(fake, overrides = {}) {
  return createCanvasProjectionApi({ pg: fake.pg, ...overrides });
}
function callHandle(api, projectId, query = {}, opts = {}) {
  const req = { method: opts.method || 'GET', query };
  const res = {};
  return api.handle(req, res, { projectId, ...(opts.params || {}) }).then(() => res);
}

/* ══════════════ 构造守卫 / 鉴权 / 基础 ─══════════════════════════ */
test('构造: 缺 pg / 无 query() 抛 TypeError', () => {
  assert.throws(() => createCanvasProjectionApi(), TypeError);
  assert.throws(() => createCanvasProjectionApi({}), TypeError);
  assert.throws(() => createCanvasProjectionApi({ pg: 'nope' }), TypeError);
  assert.throws(() => createCanvasProjectionApi({ pg: {} }), /query\(\) required/);
});

test('鉴权: authProject 缺省放行；拒绝按钩子 status；抛错 → 500', async () => {
  const f = createFakePg();
  f.setCanvas('p-1', 'canvas-1');
  const deny = makeApi(f, { authProject: async () => ({ ok: false, status: 403, error: 'FORBIDDEN' }) });
  const r1 = await callHandle(deny, 'p-1');
  assert.equal(r1.status, 403);
  assert.deepEqual(r1.body, { ok: false, error: 'FORBIDDEN' });

  const boom = makeApi(f, { authProject: async () => { throw new Error('x'); } });
  const r2 = await callHandle(boom, 'p-1');
  assert.equal(r2.status, 500);

  const allow = makeApi(f, { authProject: async () => ({ ok: true }) });
  const r3 = await callHandle(allow, 'p-1');
  assert.equal(r3.status, 200);
});

test('projectId 未注入/空白 → 400；非 GET → 405', async () => {
  const f = createFakePg();
  const api = makeApi(f);
  for (const params of [{}, { projectId: '' }, { projectId: '   ' }, null]) {
    const res = await callHandle(api, undefined, {}, { params: params || {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'PROJECT_ID_REQUIRED');
  }
  const r = await callHandle(api, 'p-1', {}, { method: 'POST' });
  assert.equal(r.status, 405);
});

/* ══════════════ 全重建（afterSeq 缺省 0） ═════════════════════════ */
test('全重建: afterSeq 缺省 0 → 快照 + lww/merge 全量重放；CAS 计数行跳过', async () => {
  const f = createFakePg();
  f.setCanvas('p-1', 'canvas-1', 3);
  f.addNode('canvas-1', nodeRow('n-1'));
  f.addNode('canvas-1', nodeRow('n-2'));
  f.addEdge('canvas-1', edgeRow('e-0', { sourceNodeId: 'n-1', targetNodeId: 'n-2' }));

  // 日志: lww 改 n-1 data; merge 增 e-x + 删 e-0; 夹一条 CAS 计数行(应被跳过)。
  f.addLog('canvas-1', { commandId: 'c-1', payload: CAS_COUNT_PAYLOAD });
  f.addLog('canvas-1', { commandId: 'c-2', payload: lwwPayload('n-1', { nodeKind: 'prompt', title: 'RENAMED', status: 'DONE' }) });
  const eX = edgeRow('e-x', { sourceNodeId: 'n-1', targetNodeId: 'n-2', data: { from: 'A' } });
  f.addLog('canvas-1', { commandId: 'c-3', payload: mergeUpsertPayload(eX) });
  f.addLog('canvas-1', { commandId: 'c-4', payload: mergeDeletePayload('e-0') });
  const logMax = f.logMax('canvas-1');

  const api = makeApi(f);
  const res = await callHandle(api, 'p-1'); // afterSeq 缺省
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.ok, true);
  assert.equal(b.seq, logMax, 'seq = 一致窗口 log max');
  assert.equal(b.revision, 3, 'revision 透传');
  assert.equal(b.rebuiltFrom, 0, '缺省 0 全重建');
  assert.equal(b.passthrough, false, '有 delta → 非透传');

  const ids = (arr) => arr.map((x) => x.edgeId || x.nodeId).sort();
  assert.deepEqual(b.nodes.map((n) => n.nodeId).sort(), ['n-1', 'n-2']);
  assert.deepEqual(ids(b.edges), ['e-x'], 'e-0 被删、e-x 增入');
  const n1 = b.nodes.find((n) => n.nodeId === 'n-1');
  assert.equal(n1.data.title, 'RENAMED', 'lww node.update data 重放生效');
  assert.equal(n1.data.nodeKind, 'prompt', 'lww data 整对象覆盖（recordCanvasPatch 语义）');
  assert.equal(n1.position.x, 10, '未列域(位置)保留自快照');
  const eXOut = b.edges.find((e) => e.edgeId === 'e-x');
  assert.deepEqual(eXOut.data, { from: 'A' });
});

/* ══════════════ 增量透传（afterSeq = log max → 零重建） ═══════════ */
test('增量透传: afterSeq = 当前 log max → 快照透传(passthrough), 不重放', async () => {
  const f = createFakePg();
  f.setCanvas('p-1', 'canvas-1', 5);
  f.addNode('canvas-1', nodeRow('n-1'));
  f.addNode('canvas-1', nodeRow('n-2'));
  f.addEdge('canvas-1', edgeRow('e-0', { sourceNodeId: 'n-1', targetNodeId: 'n-2' }));
  // 快照已含 lww 效果(直写落表), 日志记录该写。
  f.addLog('canvas-1', { commandId: 'c-1', payload: lwwPayload('n-1', { title: 'RENAMED' }) });
  const logMax = f.logMax('canvas-1');

  const api = makeApi(f);
  const res = await callHandle(api, 'p-1', { afterSeq: String(logMax) });
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.passthrough, true, 'afterSeq=logMax → 零重建透传');
  assert.equal(b.seq, logMax);
  assert.equal(b.rebuiltFrom, logMax);
  assert.equal(b.revision, 5);
  assert.equal(b.nodes.length, 2);
  assert.equal(b.edges.length, 1);
  // 透传 = 直接回快照(不重放日志: n-1 data 保持快照原值, 而非日志里被 lww 覆写的值)
  assert.equal(b.nodes.find((n) => n.nodeId === 'n-1').data.title, 'T-n-1', '透传不重放日志');
});

/* ══════════════ 快照-日志窗口一致性（基线守卫） ═══════════════════ */
test('窗口一致性: 事务内 log max 与 nodes/edges 读自同一快照；窗口后并发写被 delta 过滤', async () => {
  const f = createFakePg();
  f.setCanvas('p-1', 'canvas-1', 2);
  f.addNode('canvas-1', nodeRow('n-1'));
  f.addNode('canvas-1', nodeRow('n-2'));
  f.addEdge('canvas-1', edgeRow('e-0', { sourceNodeId: 'n-1', targetNodeId: 'n-2' }));
  f.addLog('canvas-1', { commandId: 'c-1', payload: lwwPayload('n-1', { title: 'D1' }) });
  const logMaxBefore = f.logMax('canvas-1'); // 1

  // 在 log max 读之后、nodes/edges 读之前注入「并发已提交写」(seq=2 的边 create + 日志)。
  const raceEdge = edgeRow('e-race', { sourceNodeId: 'n-1', targetNodeId: 'n-2', data: { race: true } });
  f.hook(/MAX\(seq\)/, () => {
    f.addEdge('canvas-1', raceEdge);
    f.addLog('canvas-1', { commandId: 'c-race', payload: mergeUpsertPayload(raceEdge) });
  });

  const api = makeApi(f);
  const res = await callHandle(api, 'p-1'); // afterSeq 0 全重建
  assert.equal(res.status, 200);
  const b = res.body;
  // 一致窗口: seq 停在事务内读到的 log max(并发写前), 并发写的 seq=2 不在窗口内。
  assert.equal(b.seq, logMaxBefore, 'seq = 窗口 log max(不含窗口后并发写)');
  assert.equal(b.passthrough, false);
  // 快照读自同一冻结快照 → 并发边 e-race 不在返回 edges。
  assert.deepEqual(b.edges.map((e) => e.edgeId).sort(), ['e-0'], '窗口后并发边被过滤(不撕裂快照)');
  assert.equal(b.nodes.find((n) => n.nodeId === 'n-1').data.title, 'D1', 'lww 重放生效');
});

/* ══════════════ 空日志 → 回快照 ═══════════════════════════════════ */
test('空日志: 无命令 → seq 0, 回快照(passthrough), 节点边原样', async () => {
  const f = createFakePg();
  f.setCanvas('p-1', 'canvas-1', 1);
  f.addNode('canvas-1', nodeRow('n-1', { data: { title: 'ONLY' } }));
  f.addEdge('canvas-1', edgeRow('e-1', { sourceNodeId: 'n-1', targetNodeId: 'n-1' }));

  const api = makeApi(f);
  const res = await callHandle(api, 'p-1'); // afterSeq 缺省 0, 但日志空
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.seq, 0, '空日志 log max = 0');
  assert.equal(b.passthrough, true);
  assert.equal(b.revision, 1);
  assert.equal(b.nodes.length, 1);
  assert.deepEqual(b.nodes[0].data, { title: 'ONLY' });
  assert.equal(b.edges.length, 1);
  assert.equal(b.rebuiltFrom, 0);
});

/* ══════════════ 非法 afterSeq ═════════════════════════════════════ */
test('非法 afterSeq → 400 INVALID_AFTERSEQ，不触 DB', async () => {
  const f = createFakePg();
  f.setCanvas('p-1', 'canvas-1');
  const api = makeApi(f);
  for (const bad of ['-1', '1.5', 'abc', '1e5', '0x10', String(Number.MAX_SAFE_INTEGER + 1)]) {
    const res = await callHandle(api, 'p-1', { afterSeq: bad });
    assert.equal(res.status, 400, `afterSeq=${bad} 应拒`);
    assert.equal(res.body.error, 'INVALID_AFTERSEQ');
  }
});

/* ══════════════ 无画布 ════════════════════════════════════════════ */
test('无主画布 → 200 空投影(seq 0, revision null), 读路径不 404', async () => {
  const f = createFakePg();
  const api = makeApi(f);
  const res = await callHandle(api, 'p-none');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, nodes: [], edges: [], seq: 0, revision: null, rebuiltFrom: 0, passthrough: true });
});

/* ══════════════ 部分增量重建（afterSeq 介于 0 与 max） ════════════ */
test('部分增量: afterSeq 介于 0 与 max → 仅重放其后条目（游标语义）', async () => {
  const f = createFakePg();
  f.setCanvas('p-1', 'canvas-1', 2);
  f.addNode('canvas-1', nodeRow('n-1'));
  f.addLog('canvas-1', { commandId: 'c-1', payload: lwwPayload('n-1', { title: 'FIRST' }) });
  f.addLog('canvas-1', { commandId: 'c-2', payload: lwwPayload('n-1', { title: 'SECOND' }) });
  const api = makeApi(f);

  const full = await callHandle(api, 'p-1'); // afterSeq 0
  assert.equal(full.body.nodes[0].data.title, 'SECOND', '全重建 = 后写胜');

  const inc = await callHandle(api, 'p-1', { afterSeq: '1' }); // 只重放 seq>1
  assert.equal(inc.status, 200);
  assert.equal(inc.body.seq, 2);
  assert.equal(inc.body.rebuiltFrom, 1);
  assert.equal(inc.body.passthrough, false);
  assert.equal(inc.body.nodes[0].data.title, 'SECOND', '增量只重放 seq=2 → 仍得 SECOND');
});
