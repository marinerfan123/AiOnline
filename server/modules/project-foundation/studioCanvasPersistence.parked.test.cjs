'use strict';
/**
 * L44/L46 — semantic_parked_state(0069) 持久化 + 视频节点语义迁移 harness test.
 *
 * 覆盖(假 pg + 单测, 全绿):
 *   1) computeVideoNodeSemantics 纯函数三态迁移(exact/adjusted/parked)。
 *   2) parked 保存(syncParkedState) + 恢复(loadParkedState 原值不丢)。
 *   3) 重试 exact 后清理(syncParkedState 以当前 parked 集合 reconcile, 旧 parked 行被 DELETE)。
 *   4) loadParkedStateForCanvas 整画布聚合恢复。
 *   5) persistVideoNodeSemantics: operation_code 引用解析(model_operations → ACTIVE revision
 *      semantic_map) + parked 落表; operation 未解析 → 全参数 parked(不丢)。
 *   6) handlePatch/handleGet 集成: 视频节点 operation 引用语义持久化(data.semanticState/
 *      parkedState + semantic_parked_state 落行) + GET 恢复原值。
 *
 * 假 pg 语义: jsonb 列 INSERT 收 JSON 字符串、SELECT 返回解析对象(node-pg 行为);
 * semantic_parked_state UNIQUE(canvas_id,node_id,param_key) 冲突 → DO UPDATE(覆写, 保留
 * 首次 created_at); 与 0052 locked / 0054 dirty 无关(独立表), 不影响既有 PATCH 主链。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createStudioCanvasPersistence,
  computeVideoNodeSemantics,
  syncParkedState,
  loadParkedState,
  loadParkedStateForCanvas,
  persistVideoNodeSemantics,
} = require('./studioCanvasPersistence.cjs');

const USER = { id: 'u-42', role: 'user' };
const URL_CANVAS = '/api/v2/projects/prj-1/studio/canvas';

/** 建假 pg: model_operations + model_operation_revisions + semantic_parked_state + 画布域。 */
function createDb(seed = {}) {
  const projectId = seed.projectId || 'prj-1';
  const canvasId = seed.canvasId || 'canvas-1';
  const operations = seed.operations || [];
  const revisions = seed.revisions || [];
  let canvases = [{
    id: canvasId, project_id: projectId, workspace_id: 'ws-1', name: 'Primary Canvas',
    revision: seed.revision === undefined ? 1 : seed.revision, schema_version: 1,
    viewport_json: null, created_by: 'u-42', updated_by: 'u-42', archived_at: null,
    restored_from_version_id: null, created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  }];
  const projects = [{ id: projectId, workspace_id: 'ws-1', status: 'active', owner_id: 'u-1' }];
  const memberships = [{ workspace_id: 'ws-1', user_id: USER.id, role: 'owner' }];
  const nodesByCanvas = new Map();   // canvasId -> Map<node_id, row>
  const mutations = [];              // studio_canvas_mutations rows
  const parked = new Map();          // `${canvasId}|${nodeId}|${paramKey}` -> row

  const nodeMap = (c) => { if (!nodesByCanvas.has(c)) nodesByCanvas.set(c, new Map()); return nodesByCanvas.get(c); };
  const parkedKey = (c, n, k) => `${c}|${n}|${k}`;
  const parkedRows = () => [...parked.values()];

  async function query(text, params = []) {
    const sql = String(text).trim();
    const p = params || [];
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };

    /* ── model_operations / model_operation_revisions(0059) ─────── */
    if (sql.includes('SELECT id FROM model_operations WHERE code')) {
      const [code] = p;
      const op = operations.find((o) => o.code === code);
      return { rows: op ? [{ id: op.id }] : [], rowCount: op ? 1 : 0 };
    }
    if (sql.includes('SELECT semantic_map FROM model_operation_revisions WHERE operation_id')) {
      const [opId] = p;
      const rows = revisions
        .filter((r) => r.operation_id === opId && r.status === 'ACTIVE')
        .sort((a, b) => (b.revision - a.revision) || (String(b.created_at) < String(a.created_at) ? -1 : 1));
      return { rows: rows.length ? [{ semantic_map: rows[0].semantic_map }] : [], rowCount: rows.length ? 1 : 0 };
    }

    /* ── semantic_parked_state(0069) ────────────────────────────── */
    if (sql.includes('DELETE FROM semantic_parked_state WHERE canvas_id')) {
      const [cid, nid, keys] = p;
      let n = 0;
      for (const k of [...parked.keys()]) {
        const row = parked.get(k);
        if (row.canvas_id === cid && row.node_id === nid && !(keys || []).includes(row.param_key)) {
          parked.delete(k); n++;
        }
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
        parked.set(key, { canvas_id: cid, node_id: nid, param_key: paramKey,
          from_semantics: fromSem, to_semantics: toSem, reason,
          params: JSON.parse(paramsJson), created_at: new Date('2026-02-01T00:00:00Z') });
      }
      return { rows: [{ param_key: paramKey }], rowCount: 1 };
    }
    if (sql.includes('SELECT param_key, from_semantics, to_semantics, reason, params, created_at FROM semantic_parked_state WHERE canvas_id=$1 AND node_id=$2')) {
      const [cid, nid] = p;
      const rows = parkedRows().filter((r) => r.canvas_id === cid && r.node_id === nid)
        .sort((a, b) => (a.param_key < b.param_key ? -1 : 1));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT node_id, param_key, from_semantics, to_semantics, reason, params, created_at FROM semantic_parked_state WHERE canvas_id')) {
      const [cid] = p;
      const rows = parkedRows().filter((r) => r.canvas_id === cid)
        .sort((a, b) => (a.node_id < b.node_id ? -1 : (a.param_key < b.param_key ? -1 : 1)));
      return { rows, rowCount: rows.length };
    }

    /* ── 画布域(handlePatch/handleGet 集成) ─────────────────────── */
    if (sql.includes('SELECT p.*, w.owner_id')) {
      const [id] = p;
      const row = projects.find((x) => x.id === id);
      return { rows: row ? [{ ...row, workspace_owner_id: row.owner_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM workspace_members WHERE workspace_id=$1 AND user_id=$2')) {
      const [wid, uid] = p;
      const row = memberships.find((m) => m.workspace_id === wid && m.user_id === uid) || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM studio_canvases WHERE project_id=$1 AND is_primary=TRUE')) {
      const [pid] = p;
      const row = canvases.find((c) => c.project_id === pid && c.archived_at === null) || null;
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('UPDATE studio_canvases SET revision=revision+1')) {
      const [id, base] = p;
      const row = canvases.find((c) => c.id === id);
      if (!row || row.revision !== Number(base)) return { rows: [], rowCount: 0 };
      row.revision += 1;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM studio_canvases WHERE id=$1')) {
      const [id] = p;
      const row = canvases.find((c) => c.id === id);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM studio_canvas_mutations WHERE canvas_id=$1 AND client_mutation_id=$2')) {
      const [cid, cmid] = p;
      const row = mutations.find((m) => m.canvas_id === cid && m.client_mutation_id === cmid) || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO studio_canvas_mutations')) {
      const [cid, cmid, baseRev, resultingRev, responseJson, createdBy] = p;
      if (mutations.some((m) => m.canvas_id === cid && m.client_mutation_id === cmid)) return { rows: [], rowCount: 0 };
      mutations.push({ canvas_id: cid, client_mutation_id: cmid, base_revision: baseRev,
        resulting_revision: resultingRev, response_json: JSON.parse(responseJson), created_by: createdBy });
      return { rows: [{ client_mutation_id: cmid }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO studio_canvas_nodes')) {
      const [cid, nodeId, nodeType, nodeSchemaVersion, posX, posY, width, height, zIndex, dataJson] = p;
      nodeMap(cid).set(nodeId, { canvas_id: cid, node_id: nodeId, node_type: nodeType,
        node_schema_version: nodeSchemaVersion, position_x: posX, position_y: posY, width, height,
        z_index: zIndex, data_json: JSON.parse(dataJson), created_at: new Date(), updated_at: new Date() });
      return { rows: [{ node_id: nodeId }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM studio_canvas_nodes WHERE canvas_id=$1')) {
      const [cid] = p;
      const rows = [...nodeMap(cid).values()].sort((a, b) => (a.node_id < b.node_id ? -1 : 1));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT * FROM studio_canvas_edges WHERE canvas_id=$1')) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }

  const pg = { query, connect: async () => ({ query, release() {} }) };
  return {
    pg,
    canvasRow: () => canvases[0],
    parkedRows,
    parkedState: (cid = 'canvas-1', nid) => parkedRows()
      .filter((r) => r.canvas_id === cid && (nid === undefined || r.node_id === nid))
      .map((r) => ({ paramKey: r.param_key, fromSemantics: r.from_semantics, toSemantics: r.to_semantics, reason: r.reason, params: r.params, createdAt: r.created_at })),
    nodesOf: (cid = 'canvas-1') => [...nodeMap(cid).values()].sort((a, b) => (a.node_id < b.node_id ? -1 : 1)),
  };
}

function makePersistence(db) {
  const sendJSON = (res, status, body) => { res.status = status; res.body = body; };
  return createStudioCanvasPersistence({
    pg: db.pg,
    sessionUser: (req) => (req && req.user) || null,
    sendJSON,
    parseBody: async (req) => (req && req.body) || {},
    commandLogStore: { appendCommand: async () => null }, // 隔离命令日志, 专注语义/parked 链
  });
}

async function doPatch(p, body, user = USER) {
  const req = { user, body };
  const res = {};
  await p.handle(req, res, URL_CANVAS, 'PATCH');
  return { status: res.status, body: res.body };
}
async function doGet(p, user = USER) {
  const req = { user };
  const res = {};
  await p.handle(req, res, URL_CANVAS, 'GET');
  return { status: res.status, body: res.body };
}

/** 视频节点构造: operation_code 引用 + 语义参数 + job_id(存 data_json)。 */
function mkVideoNode(overrides = {}) {
  return {
    nodeId: 'v1', nodeType: 'video', nodeSchemaVersion: 1, position: { x: 10, y: 10 },
    data: {
      nodeKind: 'video', schemaVersion: 1, title: 'V1', status: 'IDLE',
      operation: 'video.image_to_video', logical_model: 'seedance',
      parameters: { duration: 5, resolution: '1280x720', seed: 42, bogusParam: 'x' },
      job_id: 'job-abc',
    },
    ...overrides,
  };
}

/* ── 1) 纯函数三态迁移 ─────────────────────────────────────────── */
test('computeVideoNodeSemantics: duration(sec→ms) adjusted / resolution+seed exact / bogusParam parked', () => {
  const { report, semanticState } = computeVideoNodeSemantics({
    params: { duration: 5, resolution: '1280x720', seed: 42, bogusParam: 'x' },
    operationSemanticMap: { duration: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } },
  });
  assert.deepEqual(report.exact.sort(), ['resolution', 'seed']);
  assert.equal(report.adjusted.length, 1);
  assert.equal(report.adjusted[0].key, 'duration');
  assert.equal(report.adjusted[0].to, 5000, 'sec→ms 单位换算');
  assert.deepEqual(report.parked.map((x) => x.key), ['bogusParam']);
  assert.equal(report.parked[0].reason, 'unknown-param');
  assert.equal(semanticState.duration.status, 'adjusted');
  assert.equal(semanticState.duration.semantic, 'video.duration');
  assert.equal(semanticState.resolution.status, 'exact');
  assert.equal(semanticState.seed.semantic, 'generation.seed');
});

/* ── 2) parked 保存 + 恢复(原值不丢) ──────────────────────────── */
test('syncParkedState 保存 → loadParkedState 恢复原值(params.value)', async () => {
  const db = createDb();
  const client = await db.pg.connect();
  await syncParkedState(client, {
    canvasId: 'canvas-1', nodeId: 'v1',
    parked: [{ key: 'bogusParam', value: 'x', fromSemantics: null, toSemantics: null, reason: 'unknown-param' }],
  });
  const rows = await loadParkedState(client, 'canvas-1', 'v1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paramKey, 'bogusParam');
  assert.equal(rows[0].value, 'x', '原值不丢');
  assert.equal(rows[0].reason, 'unknown-param');
  assert.equal(rows[0].fromSemantics, null);
  assert.equal(rows[0].toSemantics, null);
});

/* ── 3) 重试 exact 后清理(以当前 parked 集合 reconcile) ───────── */
test('syncParkedState 重试: parked→exact 后旧行被清理(不残留)', async () => {
  const db = createDb();
  const client = await db.pg.connect();
  await syncParkedState(client, {
    canvasId: 'canvas-1', nodeId: 'v1',
    parked: [
      { key: 'a', value: 1, fromSemantics: null, toSemantics: null, reason: 'unknown-param' },
      { key: 'b', value: 2, fromSemantics: 'video.fps', toSemantics: null, reason: 'unsupported-in-target:video.fps' },
    ],
  });
  assert.equal((await loadParkedState(client, 'canvas-1', 'v1')).length, 2);
  // 重试: a 变 exact(不在 parked 集合), b 仍 parked → 只剩 b, a 的旧行被 DELETE。
  await syncParkedState(client, {
    canvasId: 'canvas-1', nodeId: 'v1',
    parked: [{ key: 'b', value: 2, fromSemantics: 'video.fps', toSemantics: null, reason: 'unsupported-in-target:video.fps' }],
  });
  const rows = await loadParkedState(client, 'canvas-1', 'v1');
  assert.deepEqual(rows.map((r) => r.paramKey), ['b'], 'a 已清理');
  assert.equal(rows[0].value, 2);
});

/* ── 4) 整画布聚合恢复 ─────────────────────────────────────────── */
test('loadParkedStateForCanvas: 多节点聚合归并 { nodeId: [entries] }', async () => {
  const db = createDb();
  const client = await db.pg.connect();
  await syncParkedState(client, { canvasId: 'canvas-1', nodeId: 'v1', parked: [{ key: 'x', value: 1, fromSemantics: null, toSemantics: null, reason: 'unknown-param' }] });
  await syncParkedState(client, { canvasId: 'canvas-1', nodeId: 'v2', parked: [{ key: 'y', value: 'z', fromSemantics: null, toSemantics: null, reason: 'unknown-param' }] });
  const byNode = await loadParkedStateForCanvas(client, 'canvas-1');
  assert.deepEqual(Object.keys(byNode).sort(), ['v1', 'v2']);
  assert.equal(byNode.v1[0].paramKey, 'x');
  assert.equal(byNode.v2[0].value, 'z');
});

/* ── 5) operation_code 引用解析 + parked 落表 / operation 未解析全 parked ── */
test('persistVideoNodeSemantics: operation_code 经 model_operations→ACTIVE revision semantic_map 落 parked', async () => {
  const db = createDb({
    operations: [{ id: 'mo-1', code: 'video.image_to_video', media_type: 'video' }],
    revisions: [{ id: 'mor-1', operation_id: 'mo-1', revision: 1, status: 'ACTIVE',
      semantic_map: { duration: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } } }],
  });
  const client = await db.pg.connect();
  const result = await persistVideoNodeSemantics(client, {
    canvasId: 'canvas-1', nodeId: 'v1',
    data: { operation: 'video.image_to_video', parameters: { duration: 5, seed: 42, bogusParam: 'x' } },
  });
  assert.equal(result.semanticState.duration.value, 5000, 'adjusted');
  assert.equal(result.semanticState.seed.status, 'exact');
  assert.deepEqual(Object.keys(result.parkedState), ['bogusParam']);
  const parkedRows = db.parkedState('canvas-1', 'v1');
  assert.equal(parkedRows.length, 1);
  assert.equal(parkedRows[0].paramKey, 'bogusParam');
  assert.equal(parkedRows[0].params.value, 'x');
});

test('persistVideoNodeSemantics: operation 未解析 → 全参数 parked(不丢)', async () => {
  const db = createDb({ operations: [], revisions: [] }); // 无 model_operations 登记
  const client = await db.pg.connect();
  const result = await persistVideoNodeSemantics(client, {
    canvasId: 'canvas-1', nodeId: 'v1',
    data: { operation: 'video.unknown', parameters: { duration: 5, seed: 42 } },
  });
  assert.deepEqual(result.report.exact, []);
  assert.equal(result.report.parked.length, 2, '全参数 parked');
  assert.ok(result.report.parked.every((x) => x.reason === 'operation-unresolved'));
  const parkedRows = db.parkedState('canvas-1', 'v1');
  assert.equal(parkedRows.length, 2, '两个参数原值均落表');
});

/* ── 6) 集成: PATCH 视频节点 → semantic/parked/job_id 持久化 + GET 恢复 ── */
test('handlePatch/handleGet: 视频节点 operation 引用语义持久化(semanticState/parkedState/jobId) + GET 恢复原值', async () => {
  const db = createDb({
    operations: [{ id: 'mo-1', code: 'video.image_to_video', media_type: 'video' }],
    revisions: [{ id: 'mor-1', operation_id: 'mo-1', revision: 1, status: 'ACTIVE',
      semantic_map: { duration: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } } }],
  });
  const p = makePersistence(db);

  const patch = await doPatch(p, {
    clientMutationId: 'm-v1', baseRevision: 1,
    upsertNodes: [mkVideoNode()], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  });
  assert.equal(patch.status, 200);
  assert.equal(db.canvasRow().revision, 2, 'CAS 通过 revision+1');

  // 落库的 node.data_json 含 §119 白名单字段(operation/logicalModel/jobId) + 服务端语义态。
  const stored = db.nodesOf('canvas-1').find((n) => n.node_id === 'v1');
  assert.ok(stored, '视频节点已落表');
  assert.equal(stored.data_json.operation, 'video.image_to_video', 'operation_code 引用');
  assert.equal(stored.data_json.logicalModel, 'seedance');
  assert.equal(stored.data_json.jobId, 'job-abc', 'job_id 存 data_json(裁决: 不新增列)');
  assert.equal(stored.data_json.semanticState.duration.value, 5000, 'adjusted 语义态');
  assert.equal(stored.data_json.semanticState.resolution.status, 'exact');
  assert.deepEqual(Object.keys(stored.data_json.parkedState), ['bogusParam']);

  // semantic_parked_state 落行(原值)。
  const parkedRows = db.parkedState('canvas-1', 'v1');
  assert.equal(parkedRows.length, 1);
  assert.equal(parkedRows[0].paramKey, 'bogusParam');
  assert.equal(parkedRows[0].params.value, 'x');

  // GET 恢复: parkedState 合并回原值(params.value)。
  const got = await doGet(p);
  assert.equal(got.status, 200);
  const gotNode = got.body.nodes.find((n) => n.nodeId === 'v1');
  assert.equal(gotNode.data.parkedState.bogusParam.value, 'x', 'GET 恢复 parked 原值');
  assert.equal(gotNode.data.operation, 'video.image_to_video');

  // 重试 exact 后清理: 第二次 PATCH 移除 bogusParam → 其 parked 行被 reconcile 清掉。
  const node2 = mkVideoNode();
  delete node2.data.parameters.bogusParam;
  const patch2 = await doPatch(p, {
    clientMutationId: 'm-v2', baseRevision: 2,
    upsertNodes: [node2], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  });
  assert.equal(patch2.status, 200);
  assert.equal(db.parkedState('canvas-1', 'v1').length, 0, 'bogusParam 变 routable/移除后 parked 行清理');
  const stored2 = db.nodesOf('canvas-1').find((n) => n.node_id === 'v1');
  assert.deepEqual(Object.keys(stored2.data_json.parkedState), [], 'parkedState 摘要同步清空');
});
