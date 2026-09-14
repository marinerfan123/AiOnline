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
const { createStudioCanvasPersistence, rebuildProjection } = require('./studioCanvasPersistence.cjs');

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
  let mutations = [];              // studio_canvas_mutations rows(本事务写入, 随 BEGIN/ROLLBACK 快照)
  let externalMutations = [];      // 模拟「并发请求已提交」的 mutation 行(不随本事务回滚)
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
      const row = mutations.find((m) => m.canvas_id === cid && m.client_mutation_id === cmid)
        || externalMutations.find((m) => m.canvas_id === cid && m.client_mutation_id === cmid) || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO studio_canvas_mutations')) {
      const [cid, cmid, baseRev, resultingRev, responseJson, createdBy] = p;
      if (seed.raceMutationAtInsert) {
        const raced = seed.raceMutationAtInsert({ canvasId: cid, clientMutationId: cmid });
        if (raced) { externalMutations.push(raced); return { rows: [], rowCount: 0 }; } // 并发同 cmid 已提交 → UNIQUE 冲突 → DO NOTHING
      }
      if (mutations.some((m) => m.canvas_id === cid && m.client_mutation_id === cmid)
        || externalMutations.some((m) => m.canvas_id === cid && m.client_mutation_id === cmid)) {
        return { rows: [], rowCount: 0 }; // UNIQUE (canvas_id, client_mutation_id) 冲突 → DO NOTHING
      }
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
    if (sql.includes('UPDATE studio_canvas_nodes SET data_json')) {
      const [cid, dataJson, nodeId] = p;
      const m = nodeMap(cid);
      if (!m.has(nodeId)) return { rows: [], rowCount: 0 }; // 节点不存在 → 0 行(回落整画布 CAS)
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
      if (seed.edgeUpsertZeroRows) return { rows: [], rowCount: 0 }; // 模拟边 upsert 0 行(防御回落 CAS 测试)
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
    mutationRows: () => [...mutations, ...externalMutations],
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

test('server graph gate: typed invalid edge returns 400 before CAS/log/mutation', async () => {
  const db = createCanvasDb();
  const p = makePersistence(db);
  const prompt = mkNode('p');
  const imageBase = mkNode('i');
  const image = { ...imageBase, nodeType: 'image', data: { ...imageBase.data, nodeKind: 'image' } };
  const bad = { edgeId: 'bad', sourceNodeId: 'p', sourceHandle: 'text', targetNodeId: 'i', targetHandle: 'image', edgeType: 'data', data: {} };
  const r = await doPatch(p, { clientMutationId: 'm-invalid-graph', baseRevision: 1, upsertNodes: [prompt, image], upsertEdges: [bad], deleteNodeIds: [], deleteEdgeIds: [] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'INVALID_CANVAS_GRAPH');
  assert.ok(r.body.reasons.some((x) => x.code === 'TYPE_INCOMPATIBLE'));
  assert.equal(db.canvasRow().revision, 1);
  assert.equal(db.mutationRows().length, 0);
  assert.equal(db.logRows().length, 0);
});

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

/* ─────────────────────────────────────────────────────────────── */
/* G22 Phase-2 — kind-scoped 灰度(node.update data-only LWW 垂直): env 开关          */
/* STUDIO_CANVAS_KIND_SCOPED=1 时, 仅 node.update(data-only) 走 LWW 直写(不改        */
/* revision), 其余 kind / 混合 kind / 不存在 id 一律回落整画布 CAS; 幂等重放与      */
/* malformed 拒绝; 每用例自行设/清 env, 不污染其它用例。                           */
/* ─────────────────────────────────────────────────────────────── */

test('G22-Phase2 env ON: node.update(data-only) → kind-scoped LWW 直写, revision 不变, 命令日志有 node.update 行', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    // seed: 新节点 n1 → node.create → 整画布 CAS, revision 1→2
    const seed = await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(seed.status, 200);
    assert.equal(seed.body.mode, 'canvas-cas');
    assert.equal(db.canvasRow().revision, 2);

    // update: 仅 data 变更(title/parameters), position/size 不变
    const updated = { ...mkNode('n1'), data: { nodeKind: 'prompt', schemaVersion: 1, title: 'T-n1-updated', status: 'IDLE', parameters: { p: 1 } } };
    const r = await doPatch(p, { clientMutationId: 'm-upd', baseRevision: 2, upsertNodes: [updated], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.mode, 'kind-scoped-lww');
    assert.equal(r.body.revision, 2);
    assert.equal(db.canvasRow().revision, 2, 'kind-scoped LWW 不改画布 revision');
    assert.equal(r.body.canvas.revision, 2);
    const node = db.nodesOf()[0];
    assert.equal(node.node_id, 'n1');
    assert.equal(node.data_json.title, 'T-n1-updated', 'data_json 已更新');
    assert.deepEqual(node.data_json.parameters, { p: 1 });

    // 命令日志: seed 行(summary) + update 行(kind 分解 ops)
    const rows = db.logRows();
    assert.equal(rows.length, 2);
    const updRow = rows.find((x) => x.command_id === 'm-upd');
    assert.ok(updRow, '命令日志有 update 行');
    assert.equal(updRow.type, 'canvas.patch');
    assert.equal(updRow.base_revision, 2);
    assert.equal(updRow.payload.mode, 'kind-scoped-lww');
    assert.ok(Array.isArray(updRow.payload.ops), 'payload.ops 为 kind 分解数组');
    const op = updRow.payload.ops.find((o) => o.nodeId === 'n1');
    assert.equal(op.op, 'upsertNode');
    assert.equal(op.kind, 'node.update');
    assert.deepEqual(op.fields, ['data']);
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase2 env ON: node.create(新 id) 仍走整画布 CAS, revision+1', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    const r = await doPatch(p, { clientMutationId: 'm-create', baseRevision: 1, upsertNodes: [mkNode('n-new')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'canvas-cas');
    assert.equal(db.canvasRow().revision, 2, 'create 仍 CAS 推进 revision');
    assert.equal(db.nodesOf().length, 1);
    assert.equal(db.nodesOf()[0].node_id, 'n-new');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase2 env ON: node.delete 仍走整画布 CAS, revision+1', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);
    const r = await doPatch(p, { clientMutationId: 'm-del', baseRevision: 2, upsertNodes: [], upsertEdges: [], deleteNodeIds: ['n1'], deleteEdgeIds: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'canvas-cas');
    assert.equal(db.canvasRow().revision, 3, 'delete 仍 CAS 推进 revision');
    assert.equal(db.nodesOf().length, 0, '节点已删除');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase2 env ON: 不存在 id → 拆解为 node.create → 整画布 CAS 兜底(陈旧 base 409)', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    // 先推进画布到 revision 2(seed n1)
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);
    // 对不存在 id 发 upsert + 陈旧 baseRevision=1 → node.create → CAS → 409(而非 lww 静默)
    const r = await doPatch(p, { clientMutationId: 'm-ghost', baseRevision: 1, upsertNodes: [mkNode('n-ghost')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'CONFLICT');
    assert.equal(r.body.serverRevision, 2);
    assert.equal(db.nodesOf().length, 1, '不存在 id 未落库');
    assert.equal(db.canvasRow().revision, 2, '409 不推进 revision');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase2 env ON: 幂等重放同 clientMutationId → idempotent:true, 命令日志不双写, revision 不变', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    const updated = { ...mkNode('n1'), data: { nodeKind: 'prompt', schemaVersion: 1, title: 'T-n1-updated', status: 'IDLE', parameters: {} } };
    const body = { clientMutationId: 'm-upd', baseRevision: 2, upsertNodes: [updated], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] };

    const first = await doPatch(p, body);
    assert.equal(first.status, 200);
    assert.equal(first.body.mode, 'kind-scoped-lww');
    assert.equal(db.canvasRow().revision, 2);

    const dup = await doPatch(p, body);
    assert.equal(dup.status, 200);
    assert.equal(dup.body.idempotent, true, '重放返回 idempotent:true');
    assert.equal(db.canvasRow().revision, 2, '重放不 bump revision');
    assert.equal(db.mutationRows().length, 2, 'seed + update 各一行 mutation(重放不新增)');

    // 命令日志不双写: m-upd 只一行; INSERT 尝试仅 seed + update 两次
    assert.equal(db.logRows().filter((x) => x.command_id === 'm-upd').length, 1, '命令日志 m-upd 不双写');
    assert.equal(db.logInsertAttempts(), 2, '重放不触发第二次命令日志 INSERT');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase2 env ON: malformed PATCH(upsertNodes 缺 nodeId) → 400 拒, 零写入', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    const r = await doPatch(p, { clientMutationId: 'm-bad', baseRevision: 1, upsertNodes: [{ nodeType: 'prompt', position: { x: 1, y: 2 } }], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'INVALID_PATCH');
    assert.ok(Array.isArray(r.body.errors) && r.body.errors.length >= 1, '带明细 errors');
    assert.equal(db.canvasRow().revision, 1, 'malformed 不推进 revision');
    assert.equal(db.nodesOf().length, 0, '零节点写入');
    assert.equal(db.logCount(), 0, '零命令日志');
    assert.equal(db.mutationRows().length, 0, '零 mutation 行');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

/* ─────────────────────────────────────────────────────────────── */
/* G22 Phase-3 — merge 桶(边 create/delete) kind-scoped 直写 + 投影重建 + 幂等        */
/* 1) merge 桶接 env-on 直行: 无整画布 CAS, 逐主键 upsert/delete, appendCommand 幂等; */
/*    delete 0 行(不存在边)=幂等成功; upsert 0 行(防御)=回落整画布 CAS(409)。          */
/* 2) reject409 桶(loadGraph/建新节点/删节点)仍整画布 CAS, mode 标记共存(canvas-cas)。*/
/* 3) rebuildProjection 纯函数: 重放 lww/merge entries 产出投影, skip reject409。     */
/* 4) 响应 mode: kind-scoped-merge / kind-scoped-lww / canvas-cas。                   */
/* 5) env-off 零变化回归。每用例自行设/清 env。                                       */
/* ─────────────────────────────────────────────────────────────── */

test('G22-Phase3 env ON: merge 边 create+覆写 → kind-scoped-merge, revision 不变, 日志携全 edge 载荷且可重建', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1'), mkNode('n2')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);

    const r = await doPatch(p, { clientMutationId: 'm-edge', baseRevision: 2, upsertNodes: [], upsertEdges: [mkEdge('e1', 'n1', 'n2')], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'kind-scoped-merge');
    assert.equal(r.body.revision, 2);
    assert.equal(db.canvasRow().revision, 2, 'merge 不改画布 revision');
    assert.equal(r.body.edges.length, 1);
    assert.equal(r.body.edges[0].edgeId, 'e1');

    const over = await doPatch(p, { clientMutationId: 'm-over', baseRevision: 2, upsertNodes: [], upsertEdges: [{ ...mkEdge('e1', 'n1', 'n2'), edgeType: 'flow', data: { w: 1 } }], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(over.status, 200);
    assert.equal(over.body.mode, 'kind-scoped-merge');
    assert.equal(db.canvasRow().revision, 2, '覆写仍不改 revision');
    assert.equal(over.body.edges.length, 1, '单边不重复');
    assert.equal(over.body.edges[0].edgeType, 'flow');

    const rows = db.logRows();
    const edgeRow = rows.find((x) => x.command_id === 'm-edge');
    assert.ok(edgeRow, '有 merge create 日志行');
    assert.equal(edgeRow.payload.mode, 'kind-scoped-merge');
    assert.ok(Array.isArray(edgeRow.payload.ops));
    const op = edgeRow.payload.ops.find((o) => o.edgeId === 'e1');
    assert.equal(op.kind, 'edge.create');
    assert.equal(op.edge.edgeId, 'e1');
    assert.equal(op.edge.sourceNodeId, 'n1');
    assert.equal(op.edge.targetNodeId, 'n2');

    const proj = rebuildProjection({ current: { nodes: [], edges: [] }, logEntries: rows });
    assert.equal(proj.edges.length, 1, '日志可重建出该边(seed 摘要被 skip)');
    assert.equal(proj.edges[0].edgeId, 'e1');
    assert.equal(proj.edges[0].edgeType, 'flow', '重建取最后写入(覆写后)');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase3 env ON: merge 边 delete → kind-scoped-merge; 不存在边 delete 幂等成功(0 行语义)', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1'), mkNode('n2')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    await doPatch(p, { clientMutationId: 'm-edge', baseRevision: 2, upsertNodes: [], upsertEdges: [mkEdge('e1', 'n1', 'n2'), mkEdge('e2', 'n2', 'n1')], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);

    // delete e1(存在) + e-ghost(不存在) → 均成功, e1 删、e-ghost 幂等
    const r = await doPatch(p, { clientMutationId: 'm-del', baseRevision: 2, upsertNodes: [], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: ['e1', 'e-ghost'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'kind-scoped-merge');
    assert.equal(db.canvasRow().revision, 2, 'merge delete 不改 revision');
    assert.equal(r.body.edges.length, 1, '只剩 e2');
    assert.equal(r.body.edges[0].edgeId, 'e2');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase3 env ON: merge 边 upsert 0 行(防御) → 回落整画布 CAS(陈旧 base → 409)', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb({ edgeUpsertZeroRows: true });
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);
    // 陈旧 base=1 + 边 upsert 0 行 → 回落整画布 CAS → 409(而非 kind-scoped 静默)
    const r = await doPatch(p, { clientMutationId: 'm-ghost-edge', baseRevision: 1, upsertNodes: [], upsertEdges: [mkEdge('e1', 'n1', 'n1')], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'CONFLICT');
    assert.equal(r.body.serverRevision, 2);
    assert.equal(db.canvasRow().revision, 2, '409 不推进 revision');
    assert.equal(db.logRows().length, 1, '409 → 无新增命令日志');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase3 env ON: merge 幂等重放同 clientMutationId → idempotent:true, 命令日志不双写', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1'), mkNode('n2')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    const body = { clientMutationId: 'm-edge', baseRevision: 2, upsertNodes: [], upsertEdges: [mkEdge('e1', 'n1', 'n2')], deleteNodeIds: [], deleteEdgeIds: [] };
    const first = await doPatch(p, body);
    assert.equal(first.status, 200);
    assert.equal(first.body.mode, 'kind-scoped-merge');
    const dup = await doPatch(p, body);
    assert.equal(dup.status, 200);
    assert.equal(dup.body.idempotent, true, '重放返回 idempotent:true');
    assert.equal(db.canvasRow().revision, 2);
    assert.equal(db.logRows().filter((x) => x.command_id === 'm-edge').length, 1, 'm-edge 不双写');
    assert.equal(db.mutationRows().length, 2, 'seed + edge 各一行 mutation');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase3 env ON: deleteNodeIds → reject409 → 整画布 CAS(mode canvas-cas), 日志为计数摘要(非 kind 数组)', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    const r = await doPatch(p, { clientMutationId: 'm-del-node', baseRevision: 2, upsertNodes: [], upsertEdges: [], deleteNodeIds: ['n1'], deleteEdgeIds: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'canvas-cas', 'deleteNodeIds 走整画布 CAS, mode 标记共存');
    assert.equal(db.canvasRow().revision, 3, 'CAS 推进 revision');
    assert.equal(db.nodesOf().length, 0);

    const row = db.logRows().find((x) => x.command_id === 'm-del-node');
    assert.ok(row, '有日志行');
    assert.ok(!Array.isArray(row.payload.ops), 'reject409 走 CAS → 日志为计数摘要对象(非 kind 分解数组)');
    assert.equal(row.payload.ops.nodeDeletes, 1);
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase3 env ON: loadGraph → reject409 → 整画布 CAS(mode canvas-cas)', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    const r = await doPatch(p, { clientMutationId: 'm-lg', baseRevision: 1, upsertNodes: [], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [], loadGraph: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'canvas-cas', 'loadGraph 走整画布 CAS');
    assert.equal(db.canvasRow().revision, 2, 'CAS 推进 revision');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-Phase3 rebuildProjection 纯性: 同输入恒同输出, 不 mutate 输入, lww data 应用', async () => {
  const input = {
    current: {
      nodes: [{ nodeId: 'n1', nodeType: 'prompt', nodeSchemaVersion: 1, position: { x: 1, y: 2 }, size: { width: 10, height: 20 }, zIndex: null, data: { title: 'old' } }],
      edges: [],
    },
    logEntries: [
      { seq: 1, payload: { ops: [{ op: 'upsertNode', kind: 'node.update', nodeId: 'n1', fields: ['data'], reason: 'NODE_UPDATE_DATA_ONLY', data: { title: 'new' } }] } },
    ],
  };
  const before = JSON.stringify(input);
  const p1 = rebuildProjection(input);
  const p2 = rebuildProjection(input);
  assert.deepEqual(p1, p2, '同输入恒同输出');
  assert.equal(JSON.stringify(input), before, '不 mutate 输入');
  assert.equal(p1.nodes[0].data.title, 'new', 'lww data 已应用');
  assert.equal(p1.nodes[0].position.x, 1, '非 data 域保持');
});

test('G22-Phase3 rebuildProjection 并发同边双 append → 单投影(最后写入者胜)', async () => {
  const base = { edgeId: 'e1', sourceNodeId: 'n1', sourceHandle: null, targetNodeId: 'n2', targetHandle: null, edgeType: 'data', data: {} };
  const logEntries = [
    { seq: 1, payload: { ops: [{ op: 'upsertEdge', kind: 'edge.create', edgeId: 'e1', reason: 'EDGE_CREATE_NEW_ID', edge: { ...base, data: { v: 1 } } }] } },
    { seq: 2, payload: { ops: [{ op: 'upsertEdge', kind: 'edge.create', edgeId: 'e1', reason: 'EDGE_UPSERT_OVERWRITE', edge: { ...base, data: { v: 2 } } }] } },
  ];
  const proj = rebuildProjection({ current: { nodes: [], edges: [] }, logEntries });
  assert.equal(proj.edges.length, 1, '同边双 append → 单投影');
  assert.equal(proj.edges[0].edgeId, 'e1');
  assert.deepEqual(proj.edges[0].data, { v: 2 }, '最后写入者(高 seq)胜');
});

test('G22-Phase3 rebuildProjection 重放 merge 边 create/delete 并 skip reject409 摘要 entries', async () => {
  const logEntries = [
    { seq: 1, payload: { ops: [
      { op: 'upsertEdge', kind: 'edge.create', edgeId: 'e1', reason: 'EDGE_CREATE_NEW_ID', edge: { edgeId: 'e1', sourceNodeId: 'n1', sourceHandle: null, targetNodeId: 'n2', targetHandle: null, edgeType: 'data', data: {} } },
      { op: 'upsertEdge', kind: 'edge.create', edgeId: 'e2', reason: 'EDGE_CREATE_NEW_ID', edge: { edgeId: 'e2', sourceNodeId: 'n2', sourceHandle: null, targetNodeId: 'n1', targetHandle: null, edgeType: 'data', data: {} } },
    ] } },
    { seq: 2, payload: { ops: { nodeUpserts: 1, nodeDeletes: 0, edgeUpserts: 0, edgeDeletes: 0 } } }, // reject409/CAS 摘要 → skip
    { seq: 3, payload: { ops: [{ op: 'deleteEdge', kind: 'edge.delete', edgeId: 'e1', reason: 'EDGE_DELETE_ELEMENT' }] } },
  ];
  const proj = rebuildProjection({ current: { nodes: [], edges: [] }, logEntries });
  assert.equal(proj.edges.length, 1, 'e1 被删, e2 保留');
  assert.equal(proj.edges[0].edgeId, 'e2');
});

test('G22-Phase3 env OFF: merge/lww 全走整画布 CAS(零变化回归)', async () => {
  delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  try {
    const db = createCanvasDb();
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1'), mkNode('n2')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);

    const r = await doPatch(p, { clientMutationId: 'm-edge', baseRevision: 2, upsertNodes: [], upsertEdges: [mkEdge('e1', 'n1', 'n2')], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, undefined, 'env-off 响应无 mode 标记');
    assert.equal(db.canvasRow().revision, 3, 'env-off 全量 CAS 推进 revision');
    assert.equal(r.body.edges.length, 1);
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

/* ─────────────────────────────────────────────────────────────── */
/* G22 v4-pro 审计修复① — kind-scoped LWW 直写不可绕过权威绑定守卫(W2-06)。 */
/* 修复: applyKindScopedLww 在 UPDATE 前对全部待更新节点跑 assertBindingsValid。 */
/* 修复② — 并发同 clientMutationId 双写 → ON CONFLICT DO NOTHING 幂等(非 23505→500)。 */
/* ─────────────────────────────────────────────────────────────── */

test('G22-audit env ON: LWW data-only update 改写 shotId 为非法值 → 409 BINDING_INVALID(绑定守卫不被 LWW 直写绕过)', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb({ shotIds: ['shot-1'] });
    const p = makePersistence(db);
    // seed: 合法绑定节点 n1(shot-1)→ node.create → 整画布 CAS(revision 1→2)
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkBoundNode('n1', { shotId: 'shot-1' })], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);
    assert.equal(db.nodesOf()[0].data_json.shotId, 'shot-1');

    // data-only update: 仅改 data.shotId → shot-bogus(非法)。position/size 不变 → LWW 桶。
    const r = await doPatch(p, { clientMutationId: 'm-lww-bad', baseRevision: 2, upsertNodes: [mkBoundNode('n1', { shotId: 'shot-bogus' })], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 409, 'LWW 直写也拦截非法绑定');
    assert.equal(r.body.error, 'BINDING_INVALID');
    assert.ok(Array.isArray(r.body.errors) && r.body.errors.length >= 1);
    assert.ok(r.body.errors[0].includes('node.n1') && r.body.errors[0].includes('shot-bogus'), `明细=${r.body.errors[0]}`);
    assert.equal(r.body.canvasId, 'canvas-1');
    assert.equal(db.canvasRow().revision, 2, '409 不推进 revision');
    assert.equal(db.nodesOf()[0].data_json.shotId, 'shot-1', '非法绑定未落库(整事务回滚)');
    assert.equal(db.mutationRows().length, 1, '仅 seed 一行 mutation');
    assert.equal(db.logRows().filter((x) => x.command_id === 'm-lww-bad').length, 0, '非法 LWW 零命令日志');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-audit env ON: LWW data-only update 合法绑定照常直写(守卫不误伤)', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb({ shotIds: ['shot-1', 'shot-2'] });
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkBoundNode('n1', { shotId: 'shot-1' })], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);

    // 合法: 仅 data 变(shotId shot-1 → shot-2, 均在权威集)→ LWW 直写放行
    const r = await doPatch(p, { clientMutationId: 'm-lww-ok', baseRevision: 2, upsertNodes: [mkBoundNode('n1', { shotId: 'shot-2' })], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200, '合法绑定 LWW 直写放行');
    assert.equal(r.body.mode, 'kind-scoped-lww');
    assert.equal(db.canvasRow().revision, 2, 'LWW 不改 revision');
    assert.equal(db.nodesOf()[0].data_json.shotId, 'shot-2', '合法绑定已持久化');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-audit env ON: 并发同 clientMutationId LWW 双写 → idempotent 200(非 500), 数据不双写', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb({
      raceMutationAtInsert: ({ clientMutationId }) => {
        if (clientMutationId !== 'm-race') return null;
        // 模拟并发请求已提交同 cmid 的 mutation(在 prior-check 之后、本请求 INSERT 之前落地)
        return { canvas_id: 'canvas-1', client_mutation_id: 'm-race', base_revision: 2, resulting_revision: 2,
          response_json: { ok: true, applied: true, clientMutationId: 'm-race', mode: 'kind-scoped-lww', revision: 2,
            canvas: { id: 'canvas-1', revision: 2 }, nodes: [], edges: [] }, created_by: USER.id };
      },
    });
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);

    const updated = { ...mkNode('n1'), data: { nodeKind: 'prompt', schemaVersion: 1, title: 'T-n1-race', status: 'IDLE', parameters: {} } };
    const r = await doPatch(p, { clientMutationId: 'm-race', baseRevision: 2, upsertNodes: [updated], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200, '并发同 cmid 不 500');
    assert.equal(r.body.idempotent, true, '返回 idempotent:true');
    assert.equal(r.body.mode, 'kind-scoped-lww', '回放已提交响应');
    assert.equal(db.canvasRow().revision, 2, 'revision 不被双写推进');
    assert.equal(db.mutationRows().filter((m) => m.client_mutation_id === 'm-race').length, 1, 'm-race mutation 仅一行(并发提交的那行)');
    assert.equal(db.logRows().filter((x) => x.command_id === 'm-race').length, 0, '回放不写命令日志');
    assert.equal(db.nodesOf()[0].data_json.title, 'T-n1', '本请求 LWW 写入已回滚(对方已提交同 cmid)');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});

test('G22-audit env ON: 并发同 clientMutationId merge 双写 → idempotent 200(非 500)', async () => {
  process.env.STUDIO_CANVAS_KIND_SCOPED = '1';
  try {
    const db = createCanvasDb({
      raceMutationAtInsert: ({ clientMutationId }) => {
        if (clientMutationId !== 'm-race-edge') return null;
        return { canvas_id: 'canvas-1', client_mutation_id: 'm-race-edge', base_revision: 2, resulting_revision: 2,
          response_json: { ok: true, applied: true, clientMutationId: 'm-race-edge', mode: 'kind-scoped-merge', revision: 2,
            canvas: { id: 'canvas-1', revision: 2 }, nodes: [], edges: [] }, created_by: USER.id };
      },
    });
    const p = makePersistence(db);
    await doPatch(p, { clientMutationId: 'm-seed', baseRevision: 1, upsertNodes: [mkNode('n1'), mkNode('n2')], upsertEdges: [], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(db.canvasRow().revision, 2);

    const r = await doPatch(p, { clientMutationId: 'm-race-edge', baseRevision: 2, upsertNodes: [], upsertEdges: [mkEdge('e1', 'n1', 'n2')], deleteNodeIds: [], deleteEdgeIds: [] });
    assert.equal(r.status, 200, 'merge 并发同 cmid 不 500');
    assert.equal(r.body.idempotent, true);
    assert.equal(r.body.mode, 'kind-scoped-merge');
    assert.equal(db.canvasRow().revision, 2);
    assert.equal(db.mutationRows().filter((m) => m.client_mutation_id === 'm-race-edge').length, 1);
    assert.equal(db.logRows().filter((x) => x.command_id === 'm-race-edge').length, 0);
    // 本请求的边写入被回滚(不存在 e1)
    assert.equal((await db.replay()).commands.filter((c) => c.commandId === 'm-race-edge').length, 0, '命令日志未落 m-race-edge');
    assert.equal(r.body.edges.length, 0, '回放已提交响应(边未写入)');
  } finally {
    delete process.env.STUDIO_CANVAS_KIND_SCOPED;
  }
});
