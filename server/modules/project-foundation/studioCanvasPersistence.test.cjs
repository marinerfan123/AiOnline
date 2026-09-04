'use strict';
/**
 * G22 — studioCanvasPersistence.cjs PATCH 命令日志 harness test.
 * 验证: PATCH mutation 成功(CAS 通过 + COMMIT)后 → appendCommand 写 canvas.patch 命令日志;
 * 失败(409/回滚)不记; 同 mutationId 重放幂等不双插; 日志故障 warn-only 不破 PATCH 主链。
 *
 * 假 pg 忠实模拟 canvas 域在 PostgreSQL 上的行为(单 dispatcher 同时供 tx client 与
 * commandLogStore 的池级 query 使用):
 *   - studio_canvases: revision 整画布乐观锁, CAS UPDATE ... WHERE id=$1 AND revision=$2
 *     RETURNING * 命中才 revision+1(0 行 → 409 CONFLICT 路径)。
 *   - studio_canvas_mutations: (canvas_id, client_mutation_id) 幂等表 —— 重放命中 →
 *     { ...response_json, idempotent:true }, 不重复 bump revision、不重跑 upsert。
 *   - canvas_command_log: UNIQUE (canvas_id, command_id) + ON CONFLICT DO NOTHING,
 *     幂等冲突返回空 rows(与 commandLogStore.test.cjs 的 mock 语义一致)。
 *   - jsonb 列: INSERT 收 JSON 字符串, SELECT 返回解析后对象(node-pg 行为)。
 * 走真实模块路径: 未注入 commandLogStore 时 handlePatch 经模块内
 * createCommandLogStore({ pg }) 自建 store —— 同 dispatcher 落 canvas_command_log。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStudioCanvasPersistence } = require('./studioCanvasPersistence.cjs');

const URL_CANVAS = '/api/v2/projects/prj-1/studio/canvas';
const USER = { id: 'u-42', role: 'user' };

function mkNode(id, x = 10, y = 20) {
  return { nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, position: { x, y }, width: 260, height: 120,
    data: { nodeKind: 'prompt', schemaVersion: 1, title: `T-${id}`, status: 'IDLE', parameters: {} } };
}
function mkEdge(id, source, target) {
  return { edgeId: id, sourceNodeId: source, sourceHandle: null, targetNodeId: target, targetHandle: null,
    edgeType: 'data', data: {} };
}
/** 绑定节点: data 顶层携带权威 shotId / structureNodeId(与 durableNodeData 持久化键一致)。 */
function mkBoundNode(id, { shotId = null, structureNodeId = null, nodeType = 'storyboard' } = {}, x = 30, y = 40) {
  return { nodeId: id, nodeType, nodeSchemaVersion: 1, position: { x, y }, width: 260, height: 120,
    data: { nodeKind: nodeType, schemaVersion: 1, title: `T-${id}`, status: 'IDLE', parameters: {}, shotId, structureNodeId } };
}

/** 建画布域假数据库。 */
function createCanvasDb(seed = {}) {
  const projectId = seed.projectId || 'prj-1';
  const canvasId = seed.canvasId || 'canvas-1';
  let revision = seed.revision === undefined ? 1 : seed.revision;
  let canvases = [{ id: canvasId, project_id: projectId, workspace_id: 'ws-1', name: 'Primary Canvas',
    revision, schema_version: 1, viewport_json: null, created_by: 'u-42', updated_by: 'u-42',
    created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
    archived_at: null, restored_from_version_id: null }];
  const projects = [{ id: projectId, workspace_id: 'ws-1', status: 'active', owner_id: 'u-1' }];
  const memberships = [{ workspace_id: 'ws-1', user_id: USER.id, role: 'owner' }];
  const membershipsAll = seed.memberships || memberships;
  let nodesByCanvas = new Map();   // canvasId -> Map<node_id, row>
  let edgesByCanvas = new Map();   // canvasId -> Map<edge_id, row>
  let mutations = [];              // studio_canvas_mutations rows
  let logByCanvas = new Map();     // canvasId -> Map<command_id, row>
  let logSeq = 0;                    // canvas_command_log 全局序列(BIGSERIAL)
  let insertAttempts = 0;            // INSERT INTO canvas_command_log 尝试次数
  const shotIds = seed.shotIds || [];          // 权威执行 shot(shots.id, 项目域)
  const structureNodeIds = seed.structureNodeIds || []; // 权威结构节点(project_structure_nodes.id)
  const canvasRow = () => canvases[0];

  function canvasRef(c) { return canvases.find((x) => x.id === c); }
  function nodeMap(c) { if (!nodesByCanvas.has(c)) nodesByCanvas.set(c, new Map()); return nodesByCanvas.get(c); }
  function edgeMap(c) { if (!edgesByCanvas.has(c)) edgesByCanvas.set(c, new Map()); return edgesByCanvas.get(c); }
  function logMap(c) { if (!logByCanvas.has(c)) logByCanvas.set(c, new Map()); return logByCanvas.get(c); }

  // 事务语义: BEGIN 快照全部可变态, ROLLBACK 整幅还原(仿真实 PG —— CAS revision+1
  // 与同事务内写均随回滚撤销), COMMIT 弃快照。W2-06 校验失败回滚即依赖此还原。
  let txSnap = null;
  function snapState() {
    return {
      canvases: structuredClone(canvases),
      nodesByCanvas: structuredClone(nodesByCanvas),
      edgesByCanvas: structuredClone(edgesByCanvas),
      mutations: structuredClone(mutations),
      logByCanvas: structuredClone(logByCanvas),
      logSeq,
      insertAttempts,
    };
  }
  function restoreState(s) {
    canvases = s.canvases;
    nodesByCanvas = s.nodesByCanvas;
    edgesByCanvas = s.edgesByCanvas;
    mutations = s.mutations;
    logByCanvas = s.logByCanvas;
    logSeq = s.logSeq;
    insertAttempts = s.insertAttempts;
  }

  async function query(text, params = []) {
    const sql = String(text).trim();
    const p = params || [];

    if (sql === 'BEGIN') { txSnap = snapState(); return { rows: [], rowCount: 0 }; }
    if (sql === 'COMMIT') { txSnap = null; return { rows: [], rowCount: 0 }; }
    if (sql === 'ROLLBACK') { if (txSnap) restoreState(txSnap); txSnap = null; return { rows: [], rowCount: 0 }; }

    /* ── canvas_command_log(命令日志地基表) ─────────────────────── */
    if (sql.includes('INSERT INTO canvas_command_log')) {
      insertAttempts++;
      const [cid, commandId, type, actorId, baseRev, payloadJson] = p;
      const seq = String(++logSeq); // 先消费 nextval, 与 BIGSERIAL 一致(冲突也留洞)
      const canvas = logMap(cid);
      if (canvas.has(commandId)) return { rows: [], rowCount: 0 }; // UNIQUE 冲突 → DO NOTHING
      canvas.set(commandId, {
        canvas_id: cid, seq, command_id: commandId, type, actor_id: actorId,
        base_revision: baseRev, payload: payloadJson, // 原样存 JSON 字符串, SELECT 再解析
        received_at: new Date(p[6]),
      });
      return { rows: [{ seq }], rowCount: 1 };
    }
    if (sql.includes('FROM canvas_command_log')) { // listAfter 回放(listAfter 每行 camelCase 由 store.fromRow 归一)
      const [cid, afterSeq] = p;
      const rows = [...logMap(cid).values()]
        .filter((r) => Number(r.seq) > Number(afterSeq))
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((r) => ({
          canvas_id: r.canvas_id, seq: String(r.seq), // int8 → string (node-pg)
          command_id: r.command_id, type: r.type, actor_id: r.actor_id,
          base_revision: r.base_revision,
          payload: r.payload === null ? null : JSON.parse(r.payload),
          received_at: r.received_at,
        }));
      return { rows, rowCount: rows.length };
    }

    /* ── 项目/成员 ─────────────────────────────────────────────── */
    if (sql.includes('SELECT p.*, w.owner_id')) {
      const [id] = p;
      const row = projects.find((x) => x.id === id);
      return { rows: row ? [{ ...row, workspace_owner_id: row.owner_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM workspace_members WHERE workspace_id=$1 AND user_id=$2')) {
      const [wid, uid] = p;
      const row = membershipsAll.find((m) => m.workspace_id === wid && m.user_id === uid) || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    /* ── studio_canvases ───────────────────────────────────────── */
    if (sql.includes('FROM studio_canvases WHERE project_id=$1 AND is_primary=TRUE')) {
      const [pid] = p;
      const row = canvases.find((c) => c.project_id === pid && c.archived_at === null) || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT revision FROM studio_canvases WHERE id=$1')) {
      const [id] = p;
      const row = canvasRef(id);
      return { rows: row ? [{ revision: row.revision }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('UPDATE studio_canvases SET revision=revision+1')) {
      const [id, base, viewportJson] = p;
      const row = canvasRef(id);
      if (!row || row.revision !== Number(base)) return { rows: [], rowCount: 0 }; // CAS miss → 409
      row.revision += 1;
      if (viewportJson !== null && viewportJson !== undefined) row.viewport_json = JSON.parse(viewportJson);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM studio_canvases WHERE id=$1')) {
      const [id] = p;
      const row = canvasRef(id);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO studio_canvases')) {
      return { rows: [], rowCount: 0 }; // 测试恒预置 canvas, 不触发创建
    }

    /* ── studio_canvas_mutations(CAS 幂等表) ───────────────────── */
    if (sql.includes('FROM studio_canvas_mutations WHERE canvas_id=$1 AND client_mutation_id=$2')) {
      const [cid, cmid] = p;
      const row = mutations.find((m) => m.canvas_id === cid && m.client_mutation_id === cmid) || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO studio_canvas_mutations')) {
      const [cid, cmid, baseRev, resultingRev, responseJson, createdBy] = p;
      mutations.push({ canvas_id: cid, client_mutation_id: cmid, base_revision: baseRev,
        resulting_revision: resultingRev, response_json: JSON.parse(responseJson), created_by: createdBy });
      return { rows: [{ client_mutation_id: cmid }], rowCount: 1 };
    }

    /* ── 节点/边 ───────────────────────────────────────────────── */
    if (sql.includes('DELETE FROM studio_canvas_edges WHERE canvas_id=$1 AND edge_id')) {
      const [cid, ids] = p;
      const m = edgeMap(cid); let n = 0;
      for (const id of ids) if (m.delete(id)) n++;
      return { rows: [], rowCount: n };
    }
    if (sql.includes('DELETE FROM studio_canvas_nodes WHERE canvas_id=$1 AND node_id')) {
      const [cid, ids] = p;
      const m = nodeMap(cid); let n = 0;
      for (const id of ids) if (m.delete(id)) n++;
      return { rows: [], rowCount: n };
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

    /* ── W2-06 权威绑定集(叶2 接线后 handlePatch 装载) ─────────── */
    // shots.id = 执行 shot, 项目域 = episodes.project_id 归集。
    if (sql.includes('SELECT id FROM shots WHERE episode_id IN')) {
      const [pid] = p;
      return { rows: shotIds.map((id) => ({ id, project_id: pid })), rowCount: shotIds.length };
    }
    if (sql.includes('SELECT id FROM project_structure_nodes WHERE project_id=$1')) {
      return { rows: structureNodeIds.map((id) => ({ id })), rowCount: structureNodeIds.length };
    }

    throw new Error(`mock canvas pg: unhandled SQL: ${sql}`);
  }

  const pg = {
    query,
    connect: async () => ({ query, release() {} }),
  };

  return {
    pg,
    canvasRow,
    mutationRows: () => [...mutations],
    /** 已存节点行(canvasId → 按 node_id 升序; data_json 已解析)。 */
    nodesOf: (canvasId = 'canvas-1') =>
      [...(nodeMap(canvasId).values())].sort((a, b) => (a.node_id < b.node_id ? -1 : 1)),
    /** command_log 落行(canvasId → 按 seq 升序)。 */
    logRows: (canvasId = 'canvas-1') =>
      [...(logMap(canvasId).values())].sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((r) => ({ ...r, payload: r.payload === null ? null : JSON.parse(r.payload) })),
    logCount: (canvasId = 'canvas-1') => logMap(canvasId).size,
    logInsertAttempts: () => insertAttempts,
    /** 回放某画布命令日志(canvas_command_log 视角, camelCase)。 */
    replay: (canvasId = 'canvas-1') => {
      const { createCommandLogStore } = require('../collaboration/commandLogStore.cjs');
      return createCommandLogStore({ pg }).listAfter({ canvasId, seq: 0 });
    },
  };
}

/** 以注入的 deps 构建 persistence 实例。 */
function makePersistence(db, extraDeps = {}) {
  const sendJSON = (res, status, body) => { res.status = status; res.body = body; };
  return createStudioCanvasPersistence({
    pg: db.pg,
    sessionUser: (req) => (req && req.user) || null,
    sendJSON,
    parseBody: async (req) => (req && req.body) || {},
    ...extraDeps,
  });
}

/** 发 PATCH, 返回 { status, body }。 */
async function doPatch(p, body, user = USER) {
  const req = { user, body };
  const res = {};
  await p.handle(req, res, URL_CANVAS, 'PATCH');
  return { status: res.status, body: res.body };
}

function captureWarn() {
  const orig = console.warn;
  const msgs = [];
  console.warn = (...a) => msgs.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' '));
  return { msgs, restore: () => { console.warn = orig; } };
}

/* ─────────────────────────────────────────────────────────────── */

test('G22 PATCH成功(CAS通过+COMMIT)→ canvas_command_log 落一行 canvas.patch, 含 canvasId/commandId/actor/baseRevision/ops摘要', async () => {
  const db = createCanvasDb();
  const p = makePersistence(db);
  const r = await doPatch(p, {
    clientMutationId: 'm-abc', baseRevision: 1,
    upsertNodes: [mkNode('n1'), mkNode('n2')],
    deleteNodeIds: ['n-del'],
    upsertEdges: [mkEdge('e1', 'n1', 'n2')],
    deleteEdgeIds: [],
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.applied, true);
  assert.equal(r.body.canvas.revision, 2, 'CAS 通过 → revision +1');
  assert.equal(db.canvasRow().revision, 2);

  const rows = db.logRows();
  assert.equal(rows.length, 1, '恰落一行命令日志');
  const row = rows[0];
  assert.equal(row.canvas_id, 'canvas-1');
  assert.equal(row.command_id, 'm-abc', 'commandId = clientMutationId');
  assert.equal(row.type, 'canvas.patch');
  assert.equal(row.actor_id, USER.id);
  assert.equal(row.base_revision, 1);
  assert.deepEqual(row.payload, {
    baseRevision: 1,
    ops: { nodeUpserts: 2, nodeDeletes: 1, edgeUpserts: 1, edgeDeletes: 0 },
  }, 'payload = { baseRevision, ops 摘要(节点/边 upsert+delete 计数) }');
  assert.ok(Number(row.seq) >= 1);

  // 命令日志回放视角(camelCase)同源一致
  const { commands } = await db.replay();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].canvasId, 'canvas-1');
  assert.equal(commands[0].commandId, 'm-abc');
  assert.equal(commands[0].actorId, USER.id);
  assert.equal(commands[0].baseRevision, 1);
  assert.equal(commands[0].type, 'canvas.patch');
});

test('G22 重复 PATCH 同 mutationId → idempotent:true, 不 bump revision, 命令日志不双插', async () => {
  const db = createCanvasDb();
  const p = makePersistence(db);
  const body = {
    clientMutationId: 'm-retry', baseRevision: 1,
    upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  };

  const first = await doPatch(p, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, true);
  assert.equal(db.canvasRow().revision, 2);

  const dup = await doPatch(p, body);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.idempotent, true, '重放返回 idempotent:true');
  assert.equal(dup.body.applied, true, '重放回放首次响应');
  assert.equal(db.canvasRow().revision, 2, '重放不再 bump revision');
  assert.equal(db.mutationRows().length, 1, 'studio_canvas_mutations 只有一行');

  assert.equal(db.logInsertAttempts(), 1, '重放分支不触发第二次命令日志 INSERT');
  const rows = db.logRows();
  assert.equal(rows.length, 1, '命令日志不双插');
  assert.equal(rows[0].command_id, 'm-retry');
});

test('G22 PATCH CAS 失败 → 409 CONFLICT, 零命令日志, 零 mutation 行', async () => {
  const db = createCanvasDb({ revision: 3 }); // 服务端已推进到 3
  const p = makePersistence(db);
  const r = await doPatch(p, {
    clientMutationId: 'm-stale', baseRevision: 1, // 客户端陈旧 base
    upsertNodes: [mkNode('n9')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  });

  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'CONFLICT');
  assert.equal(r.body.serverRevision, 3);
  assert.equal(r.body.canvasId, 'canvas-1');
  assert.equal(db.canvasRow().revision, 3, '409 不推进 revision');
  assert.equal(db.logCount(), 0, '409 → 零命令日志落行');
  assert.equal(db.logInsertAttempts(), 0, '409 → 连 INSERT 尝试都没有');
  assert.equal(db.mutationRows().length, 0, '409 → 零 mutation 行');
});

test('G22 注入 appendCommand 抛错 → PATCH 仍 200 成功, 仅 console.warn(不破主链)', async () => {
  const db = createCanvasDb();
  const cap = captureWarn();
  try {
    const p = makePersistence(db, {
      commandLogStore: {
        appendCommand: async () => { throw new Error('log-store-on-fire'); },
      },
    });
    const r = await doPatch(p, {
      clientMutationId: 'm-fire', baseRevision: 1,
      upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
    });
    assert.equal(r.status, 200, 'appendCommand 抛错不改变 PATCH 结果');
    assert.equal(r.body.applied, true);
    assert.equal(db.canvasRow().revision, 2, 'mutation 照常提交');
    assert.equal(db.mutationRows().length, 1);
    assert.ok(cap.msgs.some((m) => m.includes('appendCommand failed after commit')), 'warn 提示日志失败');
  } finally {
    cap.restore();
  }
});

test('G22 注入 appendCommand 返回 400 拒绝 → PATCH 仍 200, 仅 warn', async () => {
  const db = createCanvasDb();
  const cap = captureWarn();
  try {
    const p = makePersistence(db, {
      commandLogStore: {
        appendCommand: async () => ({ ok: false, status: 400, errors: ['type must be one of the known command types'] }),
      },
    });
    const r = await doPatch(p, {
      clientMutationId: 'm-reject', baseRevision: 1,
      upsertNodes: [], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.applied, true);
    assert.equal(db.canvasRow().revision, 2, 'mutation 照常提交');
    assert.ok(cap.msgs.some((m) => m.includes('appendCommand rejected')), 'warn 提示拒绝原因');
  } finally {
    cap.restore();
  }
});

/* ─────────────────────────────────────────────────────────────── */
/* W2-06 — 权威绑定校验接线(三视图叶2): handlePatch 在 CAS 通过后、写入前                */
/* 装载权威 shotIds(shots.id 执行 shot, 项目域) + structureNodeIds                       */
/* (project_structure_nodes.id), 对携带绑定的 upsert 节点校验;                          */
/* 非法 → 409 BINDING_INVALID + 明细; 全写路径(节点/边/删除)共用同一流级守卫。          */
/* ─────────────────────────────────────────────────────────────── */

test('W2-06 合法绑定(shotId/structureNodeId 均在权威集)照常落库', async () => {
  const db = createCanvasDb({ shotIds: ['shot-1', 'shot-2'], structureNodeIds: ['sn-a'] });
  const p = makePersistence(db);
  const r = await doPatch(p, {
    clientMutationId: 'm-bound-ok', baseRevision: 1,
    upsertNodes: [mkBoundNode('n1', { shotId: 'shot-1', structureNodeId: 'sn-a' }), mkBoundNode('n2', { shotId: 'shot-2' })],
    upsertEdges: [mkEdge('e1', 'n1', 'n2')], deleteNodeIds: [], deleteEdgeIds: [],
  });

  assert.equal(r.status, 200, '合法绑定不拦');
  assert.equal(r.body.applied, true);
  assert.equal(r.body.canvas.revision, 2);
  const nodes = db.nodesOf();
  assert.equal(nodes.length, 2);
  const n1 = nodes.find((x) => x.node_id === 'n1');
  assert.equal(n1.data_json.shotId, 'shot-1', 'shotId 持久化');
  assert.equal(n1.data_json.structureNodeId, 'sn-a', 'structureNodeId 持久化');
  assert.equal(nodes.find((x) => x.node_id === 'n2').data_json.shotId, 'shot-2');
});

test('W2-06 非法 shotId → 409 BINDING_INVALID + 明细, 零写入; 修正后同 mutationId 重试 200(CAS 未被烧)', async () => {
  const db = createCanvasDb({ shotIds: ['shot-1'] });
  const p = makePersistence(db);
  const bad = await doPatch(p, {
    clientMutationId: 'm-bad', baseRevision: 1,
    upsertNodes: [mkBoundNode('n1', { shotId: 'shot-bogus' })], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  });

  assert.equal(bad.status, 409);
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error, 'BINDING_INVALID');
  assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length >= 1, '带明细');
  assert.ok(bad.body.errors[0].includes('node.n1') && bad.body.errors[0].includes('shot-bogus'), `明细=${bad.body.errors[0]}`);
  assert.equal(bad.body.canvasId, 'canvas-1');
  assert.equal(db.canvasRow().revision, 1, '409 不推进 revision(整事务回滚)');
  assert.equal(db.nodesOf().length, 0, '非法节点未落库');
  assert.equal(db.mutationRows().length, 0, '零 mutation 行(重试不命中幂等毒丸)');
  assert.equal(db.logCount(), 0, '零命令日志');

  // 同 mutationId + 同 baseRevision 修正 shotId 重试 → 正常 200(revision 未被 409 烧掉)
  const fixed = await doPatch(p, {
    clientMutationId: 'm-bad', baseRevision: 1,
    upsertNodes: [mkBoundNode('n1', { shotId: 'shot-1' })], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  });
  assert.equal(fixed.status, 200, '修正后重试成功');
  assert.equal(fixed.body.applied, true);
  assert.equal(db.canvasRow().revision, 2);
  assert.equal(db.nodesOf()[0].data_json.shotId, 'shot-1');
});

test('W2-06 删除节点后重绑正常(delete+re-upsert 同 id 换新 shotId)', async () => {
  const db = createCanvasDb({ shotIds: ['shot-1', 'shot-2'] });
  const p = makePersistence(db);
  const first = await doPatch(p, {
    clientMutationId: 'm-rebind-1', baseRevision: 1,
    upsertNodes: [mkBoundNode('n1', { shotId: 'shot-1' })], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  });
  assert.equal(first.status, 200);
  assert.equal(db.nodesOf().length, 1);

  // 删除 n1(删除路径不校验绑定)并在同一 PATCH 重绑到 shot-2
  const second = await doPatch(p, {
    clientMutationId: 'm-rebind-2', baseRevision: 2,
    upsertNodes: [mkBoundNode('n1', { shotId: 'shot-2' })], deleteNodeIds: ['n1'], upsertEdges: [], deleteEdgeIds: [],
  });
  assert.equal(second.status, 200, '删除后重绑放行');
  const nodes = db.nodesOf();
  assert.equal(nodes.length, 1, '无残留重复行');
  assert.equal(nodes[0].node_id, 'n1');
  assert.equal(nodes[0].data_json.shotId, 'shot-2', '重绑到新合法 shotId');
  assert.equal(db.canvasRow().revision, 3);
});

test('W2-06 无绑定节点(普通 prompt)不拦; 空串/纯空白占位与 parameters 内自由串也不拦', async () => {
  const db = createCanvasDb({ shotIds: ['shot-1'] });
  const p = makePersistence(db);
  const r = await doPatch(p, {
    clientMutationId: 'm-unbound', baseRevision: 1,
    upsertNodes: [
      mkNode('n1'),                                            // 普通 prompt, 无绑定键
      mkBoundNode('n2', { shotId: '' }),                       // storyboard 占位: 空串=未绑定
      { ...mkBoundNode('n3', { shotId: '   ' }), nodeId: 'n3' }, // 纯空白=未绑定
      { ...mkNode('n4'), nodeId: 'n4',
        data: { nodeKind: 'prompt', schemaVersion: 1, title: 'T-n4', status: 'IDLE', parameters: { shotId: 'free-string-in-parameters' } } }, // parameters 内自由串(非顶层键)不拦
    ],
    upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  });

  assert.equal(r.status, 200, '无绑定/占位/parameters 内串均不拦');
  assert.equal(r.body.applied, true);
  const nodes = db.nodesOf();
  assert.equal(nodes.length, 4);
  const n2 = nodes.find((x) => x.node_id === 'n2');
  assert.equal(n2.data_json.shotId, '', '空串照常持久化(未绑定占位)');
  assert.equal(nodes.find((x) => x.node_id === 'n4').data_json.parameters.shotId, 'free-string-in-parameters');
});

test('W2-06 非法 structureNodeId 同样 409 BINDING_INVALID 并点名该字段', async () => {
  const db = createCanvasDb({ shotIds: ['shot-1'], structureNodeIds: ['sn-a'] });
  const p = makePersistence(db);
  const r = await doPatch(p, {
    clientMutationId: 'm-struct-bad', baseRevision: 1,
    upsertNodes: [mkBoundNode('n1', { shotId: 'shot-1', structureNodeId: 'sn-not-exist' })],
    upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [],
  });

  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'BINDING_INVALID');
  assert.ok(r.body.errors[0].includes('structureNodeId sn-not-exist'), `明细=${r.body.errors[0]}`);
  assert.equal(db.nodesOf().length, 0);
});
