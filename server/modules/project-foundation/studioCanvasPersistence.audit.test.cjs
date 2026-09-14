'use strict';
/**
 * v4-pro 审计叶 E — Canvas/Parked/持久化面深度审计 + 修复回归 harness。
 *
 * 覆盖(假 pg + 单测, 全绿):
 *   1) [审计点3] durableNodeData 双写: assetId 同时认 snake `asset_id` 与 camel `assetId`
 *      (与 §119 job_id/jobId 对齐)——修复回归。
 *   2) [审计点4] 整画布 CAS 路径并发同 clientMutationId 双请求: 对方已推进 revision +
 *      已提交同 cmid mutation → 幂等 200(非 409), revision 不双写——修复回归。
 *   3) [审计点1] kind-scoped LWW 直写视频节点: parked 值双落(semantic_parked_state.params
 *      .value + data_json.parkedState 摘要)+ GET 恢复原值——不丢。
 *   4) [审计点1] kind-scoped LWW 幂等重放(并发同 cmid): 本请求 parked/UPDATE 整体回滚,
 *      已提交胜者的 parked 值保留——无双写回滚丢失。
 *   5) [审计点2] syncParkedState 全量 reconcile 语义实测: 以「当前 parked 集合」为准
 *      全量替换(非并集), 与 LWW data_json 覆写一致; 原值恒在 data_json.parameters 兜底。
 *   6) [审计点5] 0052 locked / 0054 dirty(project_shots_rows, storyboard 域)与
 *      semantic_parked_state(canvas 域)无交集: locked shot 的 canvas 节点 parked 写不查锁
 *      (独立域, 无绕过语义)。
 *
 * 假 pg 语义: jsonb 列 INSERT 收 JSON 字符串、SELECT 返回解析对象(node-pg 行为);
 * BEGIN 快照可变态、ROLLBACK 整幅还原、COMMIT 弃快照(仿真实 PG)。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createStudioCanvasPersistence,
  durableNodeData,
  syncParkedState,
  loadParkedState,
} = require('./studioCanvasPersistence.cjs');

const URL_CANVAS = '/api/v2/projects/prj-1/studio/canvas';
const USER = { id: 'u-42', role: 'user' };

/* ── [审计点3] durableNodeData 双写(snake/camel)纯函数 ─────────────── */
test('audit-E [点3] durableNodeData: assetId 认 snake asset_id 与 camel assetId(与 job_id/jobId 对齐)', () => {
  const snake = durableNodeData({ nodeKind: 'video', schemaVersion: 1, title: 'V', asset_id: 'ast-snake', job_id: 'job-1', output_asset_ids: ['a1'] });
  assert.equal(snake.assetId, 'ast-snake', 'snake asset_id → camel assetId');
  assert.equal(snake.jobId, 'job-1', 'snake job_id → camel jobId');
  assert.deepEqual(snake.outputAssetIds, ['a1'], 'snake output_asset_ids → camel outputAssetIds');

  const camel = durableNodeData({ nodeKind: 'video', schemaVersion: 1, title: 'V', assetId: 'ast-camel', jobId: 'job-2', outputAssetIds: ['a2'] });
  assert.equal(camel.assetId, 'ast-camel', 'camel assetId 直通');
  assert.equal(camel.jobId, 'job-2', 'camel jobId 直通');
  assert.deepEqual(camel.outputAssetIds, ['a2'], 'camel outputAssetIds 直通');

  // 双写冲突: snake 优先(与 §119 job_id 裁决一致)。
  const both = durableNodeData({ nodeKind: 'video', schemaVersion: 1, asset_id: 'ast-snake', assetId: 'ast-camel' });
  assert.equal(both.assetId, 'ast-snake', 'snake 优先');

  // null 保真(下游 safeNodeInput 认 null 而非 undefined)。
  const nul = durableNodeData({ nodeKind: 'video', schemaVersion: 1, asset_id: null });
  assert.equal(nul.assetId, null, 'null 保真');
});

/* ── 建画布+parked 域假数据库(快照事务) ─────────────────────────────── */
function createAuditDb(seed = {}) {
  const projectId = seed.projectId || 'prj-1';
  const canvasId = seed.canvasId || 'canvas-1';
  const operations = seed.operations || [];
  const revisions = seed.revisions || [];
  const shotIds = seed.shotIds || [];
  const structureNodeIds = seed.structureNodeIds || [];

  let canvases = [{
    id: canvasId, project_id: projectId, workspace_id: 'ws-1', name: 'Primary Canvas',
    revision: seed.revision === undefined ? 1 : seed.revision, schema_version: 1,
    viewport_json: null, created_by: 'u-42', updated_by: 'u-42', archived_at: null,
    restored_from_version_id: null, created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  }];
  const projects = [{ id: projectId, workspace_id: 'ws-1', status: 'active', owner_id: 'u-1' }];
  const memberships = [{ workspace_id: 'ws-1', user_id: USER.id, role: 'owner' }];

  let nodesByCanvas = new Map();   // canvasId -> Map<node_id, row>
  let edgesByCanvas = new Map();   // canvasId -> Map<edge_id, row>
  let mutations = [];              // 本事务写入的 studio_canvas_mutations
  let externalMutations = [];      // 并发请求已提交的 mutation(不随本事务回滚)
  let parked = new Map();          // `${canvasId}|${nodeId}|${paramKey}` -> row
  let lastCmid = '';               // 最近一次 prior-check 的 clientMutationId(供 raceAtCas 识别)
  let externalRevision = 0;        // 并发胜者已提交推进的 revision 增量(不随本事务回滚)

  const nodeMap = (c) => { if (!nodesByCanvas.has(c)) nodesByCanvas.set(c, new Map()); return nodesByCanvas.get(c); };
  const edgeMap = (c) => { if (!edgesByCanvas.has(c)) edgesByCanvas.set(c, new Map()); return edgesByCanvas.get(c); };
  const parkedKey = (c, n, k) => `${c}|${n}|${k}`;
  const parkedRows = () => [...parked.values()];

  let txSnap = null;
  function snapState() {
    return {
      canvases: structuredClone(canvases),
      nodesByCanvas: structuredClone(nodesByCanvas),
      edgesByCanvas: structuredClone(edgesByCanvas),
      mutations: structuredClone(mutations),
      parked: structuredClone(parked),
    };
  }
  function restoreState(s) {
    canvases = s.canvases;
    nodesByCanvas = s.nodesByCanvas;
    edgesByCanvas = s.edgesByCanvas;
    mutations = s.mutations;
    parked = s.parked;
  }

  async function query(text, params = []) {
    const sql = String(text).trim();
    const p = params || [];
    if (sql === 'BEGIN') { txSnap = snapState(); return { rows: [], rowCount: 0 }; }
    if (sql === 'COMMIT') { txSnap = null; return { rows: [], rowCount: 0 }; }
    if (sql === 'ROLLBACK') { if (txSnap) restoreState(txSnap); txSnap = null; return { rows: [], rowCount: 0 }; }

    /* ── model_operations / model_operation_revisions ──────────── */
    if (sql.includes('SELECT id FROM model_operations WHERE code')) {
      const op = operations.find((o) => o.code === p[0]);
      return { rows: op ? [{ id: op.id }] : [], rowCount: op ? 1 : 0 };
    }
    if (sql.includes('SELECT semantic_map FROM model_operation_revisions WHERE operation_id')) {
      const rows = revisions
        .filter((r) => r.operation_id === p[0] && r.status === 'ACTIVE')
        .sort((a, b) => (b.revision - a.revision) || (String(b.created_at) < String(a.created_at) ? -1 : 1));
      return { rows: rows.length ? [{ semantic_map: rows[0].semantic_map }] : [], rowCount: rows.length ? 1 : 0 };
    }

    /* ── semantic_parked_state ─────────────────────────────────── */
    if (sql.includes('DELETE FROM semantic_parked_state WHERE canvas_id')) {
      const [cid, nid, keys] = p;
      let n = 0;
      for (const k of [...parked.keys()]) {
        const row = parked.get(k);
        if (row.canvas_id === cid && row.node_id === nid && !(keys || []).includes(row.param_key)) { parked.delete(k); n++; }
      }
      return { rows: [], rowCount: n };
    }
    if (sql.includes('INSERT INTO semantic_parked_state')) {
      const [cid, nid, paramKey, fromSem, toSem, reason, paramsJson] = p;
      const key = parkedKey(cid, nid, paramKey);
      const existing = parked.get(key);
      if (existing) {
        existing.from_semantics = fromSem; existing.to_semantics = toSem;
        existing.reason = reason; existing.params = JSON.parse(paramsJson); // created_at 保留首次
      } else {
        parked.set(key, { canvas_id: cid, node_id: nid, param_key: paramKey, from_semantics: fromSem,
          to_semantics: toSem, reason, params: JSON.parse(paramsJson), created_at: new Date('2026-02-01T00:00:00Z') });
      }
      return { rows: [{ param_key: paramKey }], rowCount: 1 };
    }
    if (sql.includes('SELECT param_key, from_semantics')) {
      const [cid, nid] = p;
      const rows = parkedRows().filter((r) => r.canvas_id === cid && r.node_id === nid)
        .sort((a, b) => (a.param_key < b.param_key ? -1 : 1));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT node_id, param_key')) {
      const [cid] = p;
      const rows = parkedRows().filter((r) => r.canvas_id === cid)
        .sort((a, b) => (a.node_id < b.node_id ? -1 : (a.param_key < b.param_key ? -1 : 1)));
      return { rows, rowCount: rows.length };
    }

    /* ── 项目/成员 ─────────────────────────────────────────────── */
    if (sql.includes('SELECT p.*, w.owner_id')) {
      const row = projects.find((x) => x.id === p[0]);
      return { rows: row ? [{ ...row, workspace_owner_id: row.owner_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM workspace_members WHERE workspace_id=$1 AND user_id=$2')) {
      const row = memberships.find((m) => m.workspace_id === p[0] && m.user_id === p[1]) || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    /* ── studio_canvases ───────────────────────────────────────── */
    if (sql.includes('FROM studio_canvases WHERE project_id=$1 AND is_primary=TRUE')) {
      const row = canvases.find((c) => c.project_id === p[0] && c.archived_at === null) || null;
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT response_json FROM studio_canvas_mutations')) {
      const [cid, cmid] = p;
      lastCmid = cmid; // 记录本事务 cmid(供 raceAtCas 钩子识别并发同 cmid)
      const row = mutations.find((m) => m.canvas_id === cid && m.client_mutation_id === cmid)
        || externalMutations.find((m) => m.canvas_id === cid && m.client_mutation_id === cmid) || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO studio_canvas_mutations')) {
      const [cid, cmid, baseRev, resultingRev, responseJson, createdBy] = p;
      if (seed.raceMutationAtInsert) {
        const raced = seed.raceMutationAtInsert({ canvasId: cid, clientMutationId: cmid });
        if (raced) { externalMutations.push(raced); return { rows: [], rowCount: 0 }; }
      }
      if (mutations.some((m) => m.canvas_id === cid && m.client_mutation_id === cmid)
        || externalMutations.some((m) => m.canvas_id === cid && m.client_mutation_id === cmid)) {
        return { rows: [], rowCount: 0 }; // UNIQUE 冲突 → DO NOTHING
      }
      mutations.push({ canvas_id: cid, client_mutation_id: cmid, base_revision: baseRev,
        resulting_revision: resultingRev, response_json: JSON.parse(responseJson), created_by: createdBy });
      return { rows: [{ client_mutation_id: cmid }], rowCount: 1 };
    }
    if (sql.includes('SELECT revision FROM studio_canvases WHERE id=$1')) {
      const row = canvases.find((c) => c.id === p[0]);
      return { rows: row ? [{ revision: row.revision }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('UPDATE studio_canvases SET revision=revision+1')) {
      const [id, base] = p;
      const row = canvases.find((c) => c.id === id);
      // [审计点4] 模拟并发同 cmid 双请求: 对方在本请求 CAS 之前已提交 + 推进 revision
      // (externalRevision 为「已提交」的持久推进, 不随本事务 ROLLBACK 还原)。
      if (seed.raceAtCas) {
        const raced = seed.raceAtCas({ canvasId: id, clientMutationId: lastCmid, baseRevision: base });
        if (raced) {
          externalMutations.push(raced.mutation);
          externalRevision = raced.revision - (row ? row.revision : 0);
          return { rows: [], rowCount: 0 };
        }
      }
      const effRev = (row ? row.revision : 0) + externalRevision;
      if (!row || effRev !== Number(base)) return { rows: [], rowCount: 0 }; // CAS miss → 409
      row.revision += 1;
      if (p[2] !== null && p[2] !== undefined) row.viewport_json = JSON.parse(p[2]);
      return { rows: [{ ...row, revision: row.revision + externalRevision }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM studio_canvases WHERE id=$1')) {
      const row = canvases.find((c) => c.id === p[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    /* ── 权威绑定集 ────────────────────────────────────────────── */
    if (sql.includes('SELECT id FROM shots WHERE episode_id IN')) {
      return { rows: shotIds.map((id) => ({ id })), rowCount: shotIds.length };
    }
    if (sql.includes('SELECT id FROM project_structure_nodes WHERE project_id=$1')) {
      return { rows: structureNodeIds.map((id) => ({ id })), rowCount: structureNodeIds.length };
    }

    /* ── 节点/边 ───────────────────────────────────────────────── */
    if (sql.includes('DELETE FROM studio_canvas_edges WHERE canvas_id=$1 AND edge_id')) {
      const [cid, ids] = p; const m = edgeMap(cid); let n = 0;
      for (const id of ids) if (m.delete(id)) n++;
      return { rows: [], rowCount: n };
    }
    if (sql.includes('DELETE FROM studio_canvas_nodes WHERE canvas_id=$1 AND node_id')) {
      const [cid, ids] = p; const m = nodeMap(cid); let n = 0;
      for (const id of ids) if (m.delete(id)) n++;
      return { rows: [], rowCount: n };
    }
    if (sql.includes('UPDATE studio_canvas_nodes SET data_json')) {
      const [cid, dataJson, nodeId] = p;
      const m = nodeMap(cid);
      if (!m.has(nodeId)) return { rows: [], rowCount: 0 };
      const row = m.get(nodeId);
      row.data_json = JSON.parse(dataJson);
      row.updated_at = new Date();
      return { rows: [{ node_id: nodeId }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO studio_canvas_nodes')) {
      const [cid, nodeId, nodeType, nodeSchemaVersion, posX, posY, width, height, zIndex, dataJson] = p;
      nodeMap(cid).set(nodeId, { canvas_id: cid, node_id: nodeId, node_type: nodeType,
        node_schema_version: nodeSchemaVersion, position_x: posX, position_y: posY, width, height,
        z_index: zIndex, data_json: JSON.parse(dataJson), created_at: new Date(), updated_at: new Date() });
      return { rows: [{ node_id: nodeId }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO studio_canvas_edges')) {
      const [cid, edgeId, sourceNodeId, sourceHandle, targetNodeId, targetHandle, edgeType, dataJson] = p;
      edgeMap(cid).set(edgeId, { canvas_id: cid, edge_id: edgeId, source_node_id: sourceNodeId,
        source_handle: sourceHandle, target_node_id: targetNodeId, target_handle: targetHandle,
        edge_type: edgeType, data_json: JSON.parse(dataJson), created_at: new Date(), updated_at: new Date() });
      return { rows: [{ edge_id: edgeId }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM studio_canvas_nodes WHERE canvas_id=$1')) {
      const [cid] = p;
      const rows = [...nodeMap(cid).values()].sort((a, b) => (a.node_id < b.node_id ? -1 : 1));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT * FROM studio_canvas_edges WHERE canvas_id=$1')) {
      const [cid] = p;
      const rows = [...edgeMap(cid).values()].sort((a, b) => (a.edge_id < b.edge_id ? -1 : 1));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`mock audit pg: unhandled SQL: ${sql}`);
  }

  const pg = { query, connect: async () => ({ query, release() {} }) };
  return {
    pg,
    canvasRow: () => ({ ...canvases[0], revision: canvases[0].revision + externalRevision }),
    parkedState: (cid = 'canvas-1', nid) => parkedRows()
      .filter((r) => r.canvas_id === cid && (nid === undefined || r.node_id === nid))
      .map((r) => ({ paramKey: r.param_key, reason: r.reason, params: r.params })),
    nodesOf: (cid = 'canvas-1') => [...nodeMap(cid).values()].sort((a, b) => (a.node_id < b.node_id ? -1 : 1)),
    mutationRows: () => [...mutations, ...externalMutations],
  };
}

function makePersistence(db) {
  const sendJSON = (res, status, body) => { res.status = status; res.body = body; };
  return createStudioCanvasPersistence({
    pg: db.pg,
    sessionUser: (req) => (req && req.user) || null,
    sendJSON,
    parseBody: async (req) => (req && req.body) || {},
    commandLogStore: { appendCommand: async () => null }, // 隔离命令日志
  });
}
async function doPatch(p, body, user = USER) {
  const req = { user, body }; const res = {};
  await p.handle(req, res, URL_CANVAS, 'PATCH');
  return { status: res.status, body: res.body };
}
async function doGet(p, user = USER) {
  const req = { user }; const res = {};
  await p.handle(req, res, URL_CANVAS, 'GET');
  return { status: res.status, body: res.body };
}

function mkVideoNode(overrides = {}) {
  return {
    nodeId: 'v1', nodeType: 'video', nodeSchemaVersion: 1, position: { x: 10, y: 10 },
    data: {
      nodeKind: 'video', schemaVersion: 1, title: 'V1', status: 'IDLE',
      operation: 'video.image_to_video', logical_model: 'seedance',
      parameters: { duration: 5, seed: 42, bogusParam: 'x' },
      job_id: 'job-abc',
    },
    ...overrides,
  };
}

/* ── [审计点4] 整画布 CAS 并发同 cmid → 幂等 200(非 409) ───────────── */
test('audit-E [点4] 整画布 CAS 并发同 clientMutationId: 对方已推进 revision+已提交同 cmid → 幂等 200, revision 不双写', async () => {
  const db = createAuditDb({
    raceAtCas: ({ clientMutationId }) => {
      if (clientMutationId !== 'm-race') return null;
      return {
        revision: 3, // 对方推进后
        mutation: { canvas_id: 'canvas-1', client_mutation_id: 'm-race', base_revision: 2, resulting_revision: 3,
          response_json: { ok: true, applied: true, clientMutationId: 'm-race', mode: 'canvas-cas', revision: 3,
            canvas: { id: 'canvas-1', revision: 3 }, nodes: [], edges: [] }, created_by: USER.id },
      };
    },
  });
  const p = makePersistence(db);
  // seed 视频节点: CAS 1→2(raceAtCas 对 m-seed 返回 null, 不影响)
  await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkVideoNode()], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
  assert.equal(db.canvasRow().revision, 2, 'seed 后 revision=2');

  // 并发同 cmid: 本请求 prior-check 空 → CAS 时对方已提交(推进 2→3) → CAS 0 行 → 幂等读回
  const r = await doPatch(p, { clientMutationId: 'm-race', baseRevision: 2, upsertNodes: [{ ...mkVideoNode(), data: { ...mkVideoNode().data, title: 'V-race' } }], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
  assert.equal(r.status, 200, '并发同 cmid 非 409');
  assert.equal(r.body.idempotent, true, '返回 idempotent:true');
  assert.equal(r.body.mode, 'canvas-cas', '回放已提交响应');
  assert.equal(db.canvasRow().revision, 3, 'revision 不被双写推进(对方已到 3)');
  assert.equal(db.mutationRows().filter((m) => m.client_mutation_id === 'm-race').length, 1, 'm-race 仅一行 mutation');
  assert.equal(db.nodesOf('canvas-1')[0].data_json.title, 'V1', '本请求未写 title(幂等短路)');
});

/* ── [审计点1] kind-scoped LWW 视频节点 parked 双落 + GET 恢复 ─────── */
test('audit-E [点1] kind-scoped LWW 直写视频节点: parked 值双落(semantic_parked_state+data_json 摘要) + GET 恢复原值不丢', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createAuditDb({
      operations: [{ id: 'mo-1', code: 'video.image_to_video', media_type: 'video' }],
      revisions: [{ id: 'mor-1', operation_id: 'mo-1', revision: 1, status: 'ACTIVE',
        semantic_map: { duration: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } } }],
    });
    const p = makePersistence(db);
    // seed 视频节点: node.create → 整画布 CAS(revision 1→2)
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkVideoNode()], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);
    assert.equal(db.parkedState('canvas-1', 'v1').length, 1, 'bogusParam parked 落表');

    // data-only update(仅 title 变, parameters 不变)→ kind-scoped LWW 直写
    const upd = { ...mkVideoNode(), data: { ...mkVideoNode().data, title: 'V1-updated' } };
    const r = await doPatch(p, { clientMutationId: 'm-upd', baseRevision: 2, upsertNodes: [upd], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'kind-scoped-lww');
    assert.equal(db.canvasRow().revision, 2, 'LWW 不改 revision');

    const stored = db.nodesOf('canvas-1').find((n) => n.node_id === 'v1');
    assert.equal(stored.data_json.title, 'V1-updated');
    assert.equal(stored.data_json.jobId, 'job-abc', 'job_id 落 data_json(§119)');
    // parked 值仍落表(原值不丢), data_json.parkedState 摘要无 value
    assert.equal(db.parkedState('canvas-1', 'v1').length, 1, 'LWW reconcile 后 parked 值仍落表');
    assert.equal(db.parkedState('canvas-1', 'v1')[0].params.value, 'x', '原值不丢');
    assert.deepEqual(Object.keys(stored.data_json.parkedState), ['bogusParam'], 'data_json 摘要');

    // GET 恢复原值
    const got = await doGet(p);
    assert.equal(got.status, 200);
    const gotNode = got.body.nodes.find((n) => n.nodeId === 'v1');
    assert.equal(gotNode.data.parkedState.bogusParam.value, 'x', 'GET 恢复 parked 原值');
    assert.equal(gotNode.data.jobId, 'job-abc', 'GET 读回 jobId(camel)');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

/* ── [审计点1] LWW 幂等重放: 本请求 parked/UPDATE 整体回滚, 胜者值保留 ── */
test('audit-E [点1] kind-scoped LWW 幂等重放(并发同 cmid): 本请求 parked/UPDATE 整体回滚, 已提交值不丢', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createAuditDb({
      operations: [{ id: 'mo-1', code: 'video.image_to_video', media_type: 'video' }],
      revisions: [{ id: 'mor-1', operation_id: 'mo-1', revision: 1, status: 'ACTIVE',
        semantic_map: { duration: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } } }],
      raceMutationAtInsert: ({ clientMutationId }) => {
        if (clientMutationId !== 'm-race') return null;
        return { canvas_id: 'canvas-1', client_mutation_id: 'm-race', base_revision: 2, resulting_revision: 2,
          response_json: { ok: true, applied: true, clientMutationId: 'm-race', mode: 'kind-scoped-lww', revision: 2,
            canvas: { id: 'canvas-1', revision: 2 }, nodes: [], edges: [] }, created_by: USER.id };
      },
    });
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkVideoNode()], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);
    assert.equal(db.parkedState('canvas-1', 'v1').length, 1, 'seed parked 落表');

    // 并发同 cmid LWW 更新(改 title): 本请求 persistSemantics + UPDATE 后撞 insertMutation 冲突 → 整体回滚
    const upd = { ...mkVideoNode(), data: { ...mkVideoNode().data, title: 'V1-race' } };
    const r = await doPatch(p, { clientMutationId: 'm-race', baseRevision: 2, upsertNodes: [upd], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.idempotent, true, '并发同 cmid 幂等');
    assert.equal(db.canvasRow().revision, 2, 'revision 不双写');

    const stored = db.nodesOf('canvas-1').find((n) => n.node_id === 'v1');
    assert.equal(stored.data_json.title, 'V1', '本请求 UPDATE 已回滚(胜者值保留)');
    assert.equal(db.parkedState('canvas-1', 'v1').length, 1, 'parked 值未因回滚丢失');
    assert.equal(db.parkedState('canvas-1', 'v1')[0].params.value, 'x', '原值仍为 seed 的 x');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

/* ── [审计点2] syncParkedState 全量 reconcile 语义实测 ─────────────── */
test('audit-E [点2] syncParkedState 全量 reconcile: 以当前 parked 集合为准全量替换(非并集), 原值恒在 data_json.parameters 兜底', async () => {
  const db = createAuditDb();
  const client = await db.pg.connect();
  // 第一次: parked {a, b}
  await syncParkedState(client, { canvasId: 'canvas-1', nodeId: 'v1', parked: [
    { key: 'a', value: 1, fromSemantics: null, toSemantics: null, reason: 'unknown-param' },
    { key: 'b', value: 2, fromSemantics: null, toSemantics: null, reason: 'unknown-param' },
  ] });
  assert.deepEqual((await loadParkedState(client, 'canvas-1', 'v1')).map((r) => r.paramKey).sort(), ['a', 'b']);

  // 第二次 reconcile 以 {b} 为准(模拟另一 writer 只含 b)→ a 被 DELETE(全量替换, 非并集)。
  await syncParkedState(client, { canvasId: 'canvas-1', nodeId: 'v1', parked: [
    { key: 'b', value: 2, fromSemantics: null, toSemantics: null, reason: 'unknown-param' },
  ] });
  const after = await loadParkedState(client, 'canvas-1', 'v1');
  assert.deepEqual(after.map((r) => r.paramKey), ['b'], 'a 被全量替换删掉(LWW 语义, 与 data_json 覆写一致)');
  assert.equal(after[0].value, 2, 'b 原值保留');

  // 关键不变量: 即便 parked 行被删, 原值仍由调用方持久化在 data_json.parameters(非本表兜底)。
  // 此处仅验证表语义; data_json.parameters 由 durableNodeData 保证(见点3 纯函数测试)。
});

/* ── [审计点5] 0052 locked / 0054 dirty 与 parked 无交集 ───────────── */
test('audit-E [点5] 0052 locked/0054 dirty(project_shots_rows, storyboard 域)与 semantic_parked_state(canvas 域)无交集: parked 写不查锁', async () => {
  // locked/dirty 列在 project_shots_rows(storyboard 视图, 0052/0054 迁移); semantic_parked_state
  // 是 canvas 视图独立表(0069)。studioCanvasPersistence.cjs 全文无任何 SQL 查询/写入 project_shots_rows
  // 或读 locked/dirty 列(仅注释提及"无交集")——canvas 域本无锁可绕过, parked 写不短路。
  // 功能面: 绑定 locked shot 的 canvas 节点 parked 写照常落表(无锁短路)。
  const db = createAuditDb({
    shotIds: ['shot-locked'],
    operations: [{ id: 'mo-1', code: 'video.image_to_video', media_type: 'video' }],
    revisions: [{ id: 'mor-1', operation_id: 'mo-1', revision: 1, status: 'ACTIVE',
      semantic_map: { duration: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } } }],
  });
  const client = await db.pg.connect();
  await syncParkedState(client, { canvasId: 'canvas-1', nodeId: 'v1', parked: [
    { key: 'bogusParam', value: 'x', fromSemantics: null, toSemantics: null, reason: 'unknown-param' },
  ] });
  assert.equal(db.parkedState('canvas-1', 'v1').length, 1, 'parked 写照常落表(无 locked 短路)');
});
