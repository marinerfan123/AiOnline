'use strict';
const crypto = require('crypto');
// G22 — canvas.patch 命令日志: 挂载 collaboration 的 commandLogStore 地基(幂等 append)。
// 反向依赖安全: commandLogStore.cjs 零 require(纯地基叶), 无环。server.js 未改动时
// 本模块用同一个注入 pg 自建 store; 合成根日后可经 deps.commandLogStore 注入共享实例。
const { createCommandLogStore } = require('../collaboration/commandLogStore.cjs');
const { decomposeCanvasPatch, REASONS, KIND_BUCKET_BY_COMMAND } = require('./canvasCommandDecomposer.cjs');
const { validateCanvasGraph, projectCanvasGraph } = require('./canvasGraphValidator.cjs');
// L44/L46 — 视频节点参数迁移(semantic/parked)与 Parked State 持久化(0069 表)。
// 复用 L5 semanticMap 纯函数(readOperationSemantics/projectParams)做三态迁移; L43
// projectDirector.direct() 的四态裁决(含 dropped)在「模型切换」层使用, 本叶只落
// parked 持久化(exact/adjusted → node.data.semantic_state, parked → semantic_parked_state)。
const { readOperationSemantics, projectParams } = require('../modelhub/semanticMap.cjs');

const PREFIX_RE = /^\/api\/v2\/projects\/([^/]+)\/studio\/canvas(?:\/([^/]+)(?:\/([^/]+))?)?$/;
const CANVAS_SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({
  maxNodesPerPatch: Number(process.env.STUDIO_CANVAS_MAX_NODES_PER_PATCH || 200),
  maxEdgesPerPatch: Number(process.env.STUDIO_CANVAS_MAX_EDGES_PER_PATCH || 400),
  maxDeleteIdsPerPatch: Number(process.env.STUDIO_CANVAS_MAX_DELETES_PER_PATCH || 500),
  maxNameLength: 120,
  maxDescriptionLength: 1000,
  maxSnapshotBytes: Number(process.env.STUDIO_CANVAS_MAX_SNAPSHOT_BYTES || 8 * 1024 * 1024),
});
const FORBIDDEN_DATA_KEYS = new Set(['temporaryPreviewUrl', 'tempPreviewUrl', 'signedUrl', 'signedURL', 'apiKey', 'api_key', 'credential', 'credentials', 'jwt', 'token', 'cookie', 'localPath']);
// §119 Canvas Video Node 字段白名单。[snake_case(§119 词表), camelCase(canonical data_json)]。
const VIDEO_NODE_FIELD_ALIASES = Object.freeze([
  ['operation', 'operation'],
  ['logical_model', 'logicalModel'],
  ['model_revision', 'modelRevision'],
  ['semantic_state', 'semanticState'],
  ['input_state', 'inputState'],
  ['parked_state', 'parkedState'],
  ['job_id', 'jobId'],
  ['output_asset_ids', 'outputAssetIds'],
]);

// G22 Phase-2 — dual-mode 开关: STUDIO_CANVAS_KIND_SCOPED=1 时, 仅 node.update(data-only)
// 走 kind-scoped LWW 直写(不改画布 revision); 其余 kind 与开关未设/非 '1' 时保持整画布 CAS。
// 每 PATCH 读取一次(非模块加载期), 便于测试在用例间切换。开关关 ⇒ 全量整画布 CAS(零行为变化)。
function kindScopedEnabled() { return process.env.STUDIO_CANVAS_KIND_SCOPED === '1'; }

function isAdmin(user) { return user && (user.role === 'admin' || user.role === 'system'); }
function sendErr(sendJSON, res, status, error, extra = {}) { return sendJSON(res, status, { ok: false, error, ...extra }); }
function toIso(v) { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function cleanText(v, max) { if (v === undefined || v === null) return null; return String(v).trim().slice(0, max); }
function safeJson(v, fallback) { return v && typeof v === 'object' && !Array.isArray(v) ? v : fallback; }
function stripForbiddenData(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_DATA_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
function durableNodeData(raw) {
  const d = stripForbiddenData(raw || {});
  const nodeKind = String(d.nodeKind || d.nodeType || '').trim();
  const schemaVersion = Number(d.schemaVersion || d.nodeSchemaVersion || 1) || 1;
  const out = {
    nodeKind,
    nodeType: String(d.nodeType || nodeKind),
    schemaVersion,
    title: String(d.title || nodeKind || 'Node').slice(0, 200),
    status: String(d.status || 'IDLE'),
    parameters: safeJson(d.parameters, {}),
  };
  // v4-pro 审计叶E: assetId 与 §119 jobId 双写对齐——snake_case `asset_id` 与 camelCase
  // `assetId` 均认(遗漏任一处→下游 safeNodeInput 读 data.assetId 断链)。优先级与 §119
  // 词表循环一致(snake 优先), 仅 string/null 落列(保持既有 assetId 语义)。
  const assetId = d.asset_id !== undefined ? d.asset_id : d.assetId;
  if (typeof assetId === 'string' || assetId === null) out.assetId = assetId;
  if (typeof d.prompt === 'string') out.prompt = d.prompt;
  if (d.validation && typeof d.validation === 'object') out.validation = d.validation;
  if (typeof d.frameLabel === 'string') out.frameLabel = d.frameLabel;
  // W2-06: authoritative structure/Shot binding survives durability.
  if (typeof d.shotId === 'string' || d.shotId === null) out.shotId = d.shotId;
  if (typeof d.structureNodeId === 'string' || d.structureNodeId === null) out.structureNodeId = d.structureNodeId;
  // §119 Canvas Video Node 字段白名单(仅这些视频节点专属字段可落 data_json, 禁 Provider
  // Secret/request payload/endpoint)。canonical = camelCase(与 data_json 既有 assetId/shotId
  // 约定一致); 输入兼容 snake_case(§119 词表) 与 camelCase 双写。job_id 裁决: 存 data_json
  // 不新增 studio_canvas_nodes 列(见 persistVideoNodeSemantics 上方注释)。semantic_state/
  // parked_state 由服务端 persistSemanticsForNodes 每次重算覆写, 此处仅保真 round-trip。
  for (const [snake, camel] of VIDEO_NODE_FIELD_ALIASES) {
    const v = d[snake] !== undefined ? d[snake] : d[camel];
    if (v === undefined) continue;
    if (Array.isArray(v)) out[camel] = v;
    else if (v !== null && typeof v === 'object') out[camel] = safeJson(v, v);
    else out[camel] = v;
  }
  return stripForbiddenData(out);
}
function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('INVALID_NODE');
  const nodeId = String(raw.nodeId || raw.id || '').trim();
  const data = durableNodeData(raw.data || raw);
  const nodeType = String(raw.nodeType || data.nodeKind || '').trim();
  const sv = Number(raw.nodeSchemaVersion || data.schemaVersion || raw.schemaVersion || 1);
  const pos = safeJson(raw.position, {});
  if (!nodeId || !nodeType || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) throw new Error('INVALID_NODE');
  return {
    nodeId, nodeType, nodeSchemaVersion: sv >= 1 ? Math.floor(sv) : 1,
    positionX: Number(pos.x), positionY: Number(pos.y),
    width: raw.size?.width ?? raw.width ?? null, height: raw.size?.height ?? raw.height ?? null,
    zIndex: raw.zIndex ?? raw.z_index ?? null, data,
  };
}
function normalizeEdge(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('INVALID_EDGE');
  const edgeId = String(raw.edgeId || raw.id || '').trim();
  const sourceNodeId = String(raw.sourceNodeId || raw.source || '').trim();
  const targetNodeId = String(raw.targetNodeId || raw.target || '').trim();
  if (!edgeId || !sourceNodeId || !targetNodeId) throw new Error('INVALID_EDGE');
  return { edgeId, sourceNodeId, targetNodeId, sourceHandle: raw.sourceHandle || null, targetHandle: raw.targetHandle || null, edgeType: raw.edgeType || raw.type || null, data: stripForbiddenData(raw.data || {}) };
}
function formatCanvas(row) { return { id: row.id, projectId: row.project_id, workspaceId: row.workspace_id, name: row.name, revision: row.revision, schemaVersion: row.schema_version, archivedAt: toIso(row.archived_at), createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at), restoredFromVersionId: row.restored_from_version_id || null }; }
function formatNode(r) { return { nodeId: r.node_id, nodeType: r.node_type, nodeSchemaVersion: r.node_schema_version, position: { x: Number(r.position_x), y: Number(r.position_y) }, size: { width: r.width == null ? null : Number(r.width), height: r.height == null ? null : Number(r.height) }, zIndex: r.z_index == null ? null : r.z_index, data: r.data_json || {} }; }
function formatEdge(r) { return { edgeId: r.edge_id, sourceNodeId: r.source_node_id, sourceHandle: r.source_handle, targetNodeId: r.target_node_id, targetHandle: r.target_handle, edgeType: r.edge_type, data: r.data_json || {} }; }
async function loadGraph(client, canvasId) {
  const [nr, er] = await Promise.all([
    client.query('SELECT * FROM studio_canvas_nodes WHERE canvas_id=$1 ORDER BY created_at ASC, node_id ASC', [canvasId]),
    client.query('SELECT * FROM studio_canvas_edges WHERE canvas_id=$1 ORDER BY created_at ASC, edge_id ASC', [canvasId]),
  ]);
  return { nodes: nr.rows.map(formatNode), edges: er.rows.map(formatEdge) };
}
function response(canvas, graph, viewport, extra = {}) { return { canvas: formatCanvas(canvas), nodes: graph.nodes, edges: graph.edges, viewport: viewport || null, permissions: extra.permissions, ...extra.extra }; }
function graphInvalid(sendJSON, res, verdict) {
  return sendErr(sendJSON, res, 400, 'INVALID_CANVAS_GRAPH', { reasons: verdict.reasons });
}
function validateProjectedGraph(current, ops) {
  const projected = projectCanvasGraph(current, ops);
  return validateCanvasGraph({ ...projected, ops });
}
function hasStructuralGraphPayload(graph) {
  return (graph.nodes || []).some((n) => {
    const kind = String(n?.data?.nodeKind ?? n?.nodeType ?? '').trim();
    const version = Number(n?.data?.schemaVersion ?? n?.nodeSchemaVersion);
    return Boolean(kind) && Number.isInteger(version);
  }) && (graph.edges || []).every((e) => e.sourceHandle != null && e.targetHandle != null);
}
// Commercial hardening (A): set-based bulk restore — one INSERT...SELECT per table,
// NOT one round trip per node/edge. Snapshot JSONB is normalized then hydrated in one shot.
function bulkInsertNodes(client, canvasId, rawNodes) {
  if (!rawNodes || !rawNodes.length) return Promise.resolve({ rowCount: 0 });
  const rows = rawNodes.map((raw) => {
    const n = normalizeNode(raw);
    return { node_id: n.nodeId, node_type: n.nodeType, node_schema_version: n.nodeSchemaVersion, position_x: n.positionX, position_y: n.positionY, width: n.width, height: n.height, z_index: n.zIndex, data_json: n.data };
  });
  return client.query(`
    INSERT INTO studio_canvas_nodes (canvas_id,node_id,node_type,node_schema_version,position_x,position_y,width,height,z_index,data_json,created_at,updated_at)
    SELECT $1, n.node_id, n.node_type, n.node_schema_version, n.position_x, n.position_y, n.width, n.height, n.z_index, n.data_json, NOW(), NOW()
    FROM jsonb_to_recordset($2::jsonb) AS n (
      node_id text, node_type text, node_schema_version int,
      position_x double precision, position_y double precision,
      width double precision, height double precision, z_index int, data_json jsonb
    )`, [canvasId, JSON.stringify(rows)]);
}
function bulkInsertEdges(client, canvasId, rawEdges) {
  if (!rawEdges || !rawEdges.length) return Promise.resolve({ rowCount: 0 });
  const rows = rawEdges.map((raw) => {
    const e = normalizeEdge(raw);
    return { edge_id: e.edgeId, source_node_id: e.sourceNodeId, source_handle: e.sourceHandle, target_node_id: e.targetNodeId, target_handle: e.targetHandle, edge_type: e.edgeType, data_json: e.data };
  });
  return client.query(`
    INSERT INTO studio_canvas_edges (canvas_id,edge_id,source_node_id,source_handle,target_node_id,target_handle,edge_type,data_json,created_at,updated_at)
    SELECT $1, e.edge_id, e.source_node_id, e.source_handle, e.target_node_id, e.target_handle, e.edge_type, e.data_json, NOW(), NOW()
    FROM jsonb_to_recordset($2::jsonb) AS e (
      edge_id text, source_node_id text, source_handle text,
      target_node_id text, target_handle text, edge_type text, data_json jsonb
    )`, [canvasId, JSON.stringify(rows)]);
}

// G22 Phase-3 — 权威绑定校验(与整画布 CAS 路径同源)。kind-scoped LWW 直写路径同样
// 必须校验 data 内 shotId/structureNodeId: data-only node.update 也可能改写绑定串,
// 否则 env 开时绑定守卫被 LWW 直写绕过(与 W2-06 三视图守卫语义背离)。非法 → 抛
// BINDING_INVALID(带 bindingErrors/canvasId), 由 handlePatch 统一 409。
async function assertBindingsValid(client, projectId, canvasId, nodes) {
  const boundNodes = (nodes || []).filter((n) => {
    const d = n && n.data ? n.data : {};
    return (typeof d.shotId === 'string' && d.shotId.trim() !== '')
      || (typeof d.structureNodeId === 'string' && d.structureNodeId.trim() !== '');
  });
  if (!boundNodes.length) return;
  const [shotRows, structRows] = await Promise.all([
    client.query('SELECT id FROM shots WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)', [projectId]),
    client.query('SELECT id FROM project_structure_nodes WHERE project_id=$1', [projectId]),
  ]);
  const chk = validateAuthoritativeBindings(boundNodes, {
    shotIds: shotRows.rows.map((r) => r.id),
    structureNodeIds: structRows.rows.map((r) => r.id),
  });
  if (!chk.ok) throw Object.assign(new Error('BINDING_INVALID'), { bindingErrors: chk.errors, canvasId });
}

// G22 Phase-3 — 幂等 mutation 落表(ON CONFLICT DO NOTHING)。kind-scoped LWW/merge 直写
// 无整画布 CAS 门, 同 clientMutationId 并发双请求会在「prior SELECT(空) → 各自写入」
// 的 TOCTOU 窗口内撞 (canvas_id,client_mutation_id) UNIQUE → 23505 → 500。此处把 INSERT
// 幂等化: 冲突(0 行)即回读已提交响应返回 { ...response_json, idempotent:true };
// 正常插入(1 行)返回 null(调用方照常 COMMIT)。
async function insertMutation(client, { canvasId, cmid, baseRevision, resultingRevision, responseJson, userId }) {
  const ins = await client.query(
    `INSERT INTO studio_canvas_mutations (canvas_id,client_mutation_id,base_revision,resulting_revision,response_json,created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (canvas_id, client_mutation_id) DO NOTHING
     RETURNING client_mutation_id`,
    [canvasId, cmid, baseRevision, resultingRevision, JSON.stringify(responseJson), userId]
  );
  if (ins.rows && ins.rows.length) return null;
  const prior = await client.query(
    'SELECT response_json FROM studio_canvas_mutations WHERE canvas_id=$1 AND client_mutation_id=$2',
    [canvasId, cmid]
  );
  return prior.rows[0] ? prior.rows[0].response_json : null;
}

// ── L44/L46 — 视频节点语义迁移 + Parked State 持久化(0069) ─────────────────────
// §15 Projection Report 三态(复用 L5 projectParams) + §16「不静默丢参数」:
//   - exact/adjusted  → 写回 node.data.semanticState(参数可路由, 值可转换)。
//   - parked          → 写 semantic_parked_state(原值入 params JSONB) + node.data.parkedState 摘要。
//   - 重试 exact 后清理: syncParkedState 每次「以当前 parked 集合为准」做全量 reconcile——
//     不在本次 parked 集合里的旧 parked 行(已变 exact/adjusted 或参数已删)被 DELETE。
// job_id 裁决: 存 data_json.jobId(§119 白名单字段, camelCase 与既有 data_json 约定一致),
//   不新增 studio_canvas_nodes 列——job_id 是单节点可变状态, 无跨表查询需求, 加列属过度设计。

/**
 * 纯函数: 以操作 semantic_map 为目标语义, 对节点参数跑 L5 projectParams 三态迁移。
 * from = 内置先例语义(§10 视频规范表面, 识别 duration/seed/camera 等); to = 操作
 * semantic_map 覆盖在同样先例之上(per-operation surface 覆盖)。返回三态 + semanticState。
 * @returns {{report:{exact:string[],adjusted:Array,parked:Array}, semanticState:object}}
 */
function computeVideoNodeSemantics({ params, operationSemanticMap }) {
  const from = readOperationSemantics(); // 源表面 = 内置先例(节点参数 surface key)
  const to = readOperationSemantics([{ semantic_map: operationSemanticMap || {} }]); // 目标 = 操作语义
  const { report } = projectParams({ fromSemantics: from, toSemantics: to, params: params || {} });
  const semanticState = {};
  for (const key of report.exact) {
    const desc = from.bySurface[key];
    semanticState[key] = { status: 'exact', semantic: desc && desc.semantic ? desc.semantic : key, value: (params || {})[key] };
  }
  for (const a of report.adjusted) {
    const desc = from.bySurface[a.key];
    semanticState[a.key] = { status: 'adjusted', semantic: desc && desc.semantic ? desc.semantic : a.key, value: a.to, from: a.from, reason: a.reason };
  }
  const parked = (report.parked || []).map((p) => {
    const desc = from.bySurface[p.key];
    const fromSem = desc && desc.semantic ? desc.semantic : null;
    const valueLevel = /^(duration-|enum-)/.test(String(p.reason || ''));
    const toSem = valueLevel && fromSem ? (to.bySemantic[fromSem] ? to.bySemantic[fromSem].semantic : fromSem) : null;
    return { key: p.key, value: (params || {})[p.key], fromSemantics: fromSem, toSemantics: toSem, reason: p.reason };
  });
  return { report: { exact: report.exact, adjusted: report.adjusted, parked }, semanticState };
}

/** 解析操作 semantic_map: model_operations.code → 最新 ACTIVE model_operation_revisions.semantic_map。 */
async function resolveOperationSemanticMap(client, operationCode) {
  const opRes = await client.query('SELECT id FROM model_operations WHERE code=$1 LIMIT 1', [operationCode]);
  const op = opRes.rows && opRes.rows[0];
  if (!op) return null;
  const revRes = await client.query(
    "SELECT semantic_map FROM model_operation_revisions WHERE operation_id=$1 AND status='ACTIVE' ORDER BY revision DESC, created_at DESC, id DESC LIMIT 1",
    [op.id],
  );
  if (!revRes.rows || !revRes.rows.length) return null;
  return revRes.rows[0].semantic_map;
}

/**
 * 以「当前 parked 集合」为准 reconcile 语义 parked 行(保存/覆写 + 重试 exact 后清理):
 *   1) DELETE 该 (canvas_id,node_id) 下 param_key 不在本次集合里的旧行(已变 exact/adjusted 或删参)。
 *   2) 逐条 ON CONFLICT (canvas_id,node_id,param_key) DO UPDATE 覆写(保留首次 created_at)。
 */
async function syncParkedState(client, { canvasId, nodeId, parked }) {
  const keys = (parked || []).map((p) => p.key);
  await client.query(
    'DELETE FROM semantic_parked_state WHERE canvas_id=$1 AND node_id=$2 AND NOT (param_key = ANY($3::text[]))',
    [canvasId, nodeId, keys],
  );
  for (const p of parked || []) {
    await client.query(
      `INSERT INTO semantic_parked_state (canvas_id,node_id,param_key,from_semantics,to_semantics,reason,params,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (canvas_id,node_id,param_key)
       DO UPDATE SET from_semantics=EXCLUDED.from_semantics, to_semantics=EXCLUDED.to_semantics,
                     reason=EXCLUDED.reason, params=EXCLUDED.params, created_at=semantic_parked_state.created_at`,
      [canvasId, nodeId, p.key, p.fromSemantics, p.toSemantics, p.reason, JSON.stringify({ value: p.value })],
    );
  }
}

/** 恢复: 读回单节点全部 parked 行(含原值 params.value)。 */
async function loadParkedState(client, canvasId, nodeId) {
  const r = await client.query(
    'SELECT param_key, from_semantics, to_semantics, reason, params, created_at FROM semantic_parked_state WHERE canvas_id=$1 AND node_id=$2 ORDER BY param_key ASC',
    [canvasId, nodeId],
  );
  return (r.rows || []).map((row) => ({
    paramKey: row.param_key,
    fromSemantics: row.from_semantics,
    toSemantics: row.to_semantics,
    reason: row.reason,
    params: row.params || {},
    value: row.params && typeof row.params === 'object' ? row.params.value : undefined,
    createdAt: row.created_at,
  }));
}

/** 恢复(整画布): 一次查询读回所有 parked 行, 归并为 { nodeId: [entries] }。 */
async function loadParkedStateForCanvas(client, canvasId) {
  const r = await client.query(
    'SELECT node_id, param_key, from_semantics, to_semantics, reason, params, created_at FROM semantic_parked_state WHERE canvas_id=$1 ORDER BY node_id ASC, param_key ASC',
    [canvasId],
  );
  const byNode = new Map();
  for (const row of r.rows || []) {
    if (!byNode.has(row.node_id)) byNode.set(row.node_id, []);
    byNode.get(row.node_id).push({
      paramKey: row.param_key,
      fromSemantics: row.from_semantics,
      toSemantics: row.to_semantics,
      reason: row.reason,
      params: row.params || {},
      value: row.params && typeof row.params === 'object' ? row.params.value : undefined,
      createdAt: row.created_at,
    });
  }
  return Object.fromEntries(byNode);
}

/**
 * 单个视频节点的语义持久化: 解析 operation_code → 三态迁移 → sync parked 行。
 * 返回 { report, semanticState, parkedState } 供调用方写回 node.data; 非操作节点(无
 * operation_code)返回 null。operation 无法解析时把全部参数 parked(operation-unresolved),
 * 保证「迁移不了不丢」。
 */
async function persistVideoNodeSemantics(client, { canvasId, nodeId, data }) {
  const operationCode = String((data && data.operation) || '').trim();
  if (!operationCode) return null;
  const params = safeJson(data && data.parameters, {});
  const entries = Object.entries(params || {});
  const opSemanticMap = await resolveOperationSemanticMap(client, operationCode);

  let semanticState = {};
  let report;
  let parked;
  if (opSemanticMap == null) {
    parked = entries.map(([key, value]) => ({ key, value, fromSemantics: null, toSemantics: null, reason: 'operation-unresolved' }));
    report = { exact: [], adjusted: [], parked };
  } else {
    const c = computeVideoNodeSemantics({ params, operationSemanticMap: opSemanticMap });
    semanticState = c.semanticState;
    parked = c.report.parked;
    report = c.report;
  }
  await syncParkedState(client, { canvasId, nodeId, parked });
  const parkedState = {};
  for (const p of parked) parkedState[p.key] = { reason: p.reason, fromSemantics: p.fromSemantics, toSemantics: p.toSemantics };
  return { report, semanticState, parkedState };
}

/** 遍历节点, 对带 operation_code 的视频节点跑语义持久化并写回 data.semanticState/parkedState。 */
async function persistSemanticsForNodes(client, canvasId, nodes) {
  for (const n of nodes || []) {
    if (!n || !n.nodeId) continue;
    const data = n.data || {};
    const result = await persistVideoNodeSemantics(client, { canvasId, nodeId: n.nodeId, data });
    if (result) {
      n.data.semanticState = result.semanticState;
      n.data.parkedState = result.parkedState;
    }
  }
}

/**
 * 恢复(读路径): 把语义 parked 原值合并回 graph 各视频节点 data.parkedState[paramKey].value。
 * warn-only——0069 未落库/旧 schema 无此表时优雅降级(不破 GET 主链), 与命令日志同哲学。
 */
async function restoreParkedIntoGraph(client, canvasId, graph) {
  try {
    const byNode = await loadParkedStateForCanvas(client, canvasId);
    for (const n of (graph && graph.nodes) || []) {
      const entries = byNode[n.nodeId];
      if (!entries || !entries.length) continue;
      n.data = n.data || {};
      const ps = n.data.parkedState || {};
      for (const e of entries) {
        ps[e.paramKey] = { ...(ps[e.paramKey] || {}), reason: e.reason, fromSemantics: e.fromSemantics, toSemantics: e.toSemantics, value: e.value };
      }
      n.data.parkedState = ps;
    }
  } catch (e) {
    console.warn('[studio-canvas] restoreParkedIntoGraph skipped:', e && e.message);
  }
  return graph;
}

function createStudioCanvasPersistence(deps) {
  const { pg, sessionUser, sendJSON, parseBody, logEvent } = deps;
  function requireUser(req, res) { const user = sessionUser(req); if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; } return user; }
  async function getMembership(client, userId, workspaceId) { const r = await client.query('SELECT workspace_id,user_id,role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]); return r.rows[0] || null; }
  async function requireProject(client, res, user, projectId) {
    const r = await client.query('SELECT p.*, w.owner_id AS workspace_owner_id FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1', [projectId]);
    if (!r.rows.length) return sendErr(sendJSON, res, 404, '项目不存在'), null;
    const project = r.rows[0];
    const membership = isAdmin(user) ? { workspace_id: project.workspace_id, user_id: user.id, role: 'owner' } : await getMembership(client, user.id, project.workspace_id);
    if (!membership) return sendErr(sendJSON, res, 403, '无项目权限'), null;
    const owner = membership.role === 'owner' || isAdmin(user);
    // canRestore mirrors M01 project policy (archived projects restore via /projects/:id/restore);
    // Studio version-restore authorization is enforced via canUpdate in handleRestore.
    return { project, membership, permissions: { role: membership.role, canRead: true, canUpdate: owner && project.status !== 'archived', canArchive: owner && project.status !== 'archived', canRestore: owner && project.status === 'archived', canDelete: false } };
  }
  async function getCanvas(client, projectId) { const r = await client.query('SELECT * FROM studio_canvases WHERE project_id=$1 AND is_primary=TRUE AND archived_at IS NULL LIMIT 1', [projectId]); return r.rows[0] || null; }
  async function createCanvasTx(client, project, user, name) {
    const id = `canvas-${crypto.randomUUID()}`;
    const r = await client.query(`INSERT INTO studio_canvases (id,project_id,workspace_id,name,revision,schema_version,created_by,updated_by,created_at,updated_at)
      VALUES ($1,$2,$3,$4,1,$5,$6,$6,NOW(),NOW()) ON CONFLICT (project_id) WHERE is_primary=TRUE AND archived_at IS NULL DO UPDATE SET updated_at=studio_canvases.updated_at RETURNING *`, [id, project.id, project.workspace_id, name || 'Primary Canvas', CANVAS_SCHEMA_VERSION, user.id]);
    return r.rows[0];
  }
  async function ensureCanvas(client, project, user) { return await getCanvas(client, project.id) || await createCanvasTx(client, project, user, 'Primary Canvas'); }
  async function emit(eventType, payload) { if (!logEvent) return; try { await logEvent(pg, { aggregate: 'studio_canvas', eventType, payload }); } catch (_) {} }

  // G22 — canvas.patch 命令日志。优先用合成根注入的 commandLogStore(需含幂等 appendCommand);
  // 未注入则用同一 pg 自建 store(server.js 零改动即生效, 挂载地基叶)。recordCanvasPatch
  // 全程 warn-only —— 命令日志任何失败(抛错/拒绝)绝不让已提交的 PATCH 主链破。
  const commandLog =
    deps.commandLogStore && typeof deps.commandLogStore.appendCommand === 'function'
      ? deps.commandLogStore
      : (() => {
          try {
            return pg && typeof pg.query === 'function' ? createCommandLogStore({ pg }) : null;
          } catch (e) {
            console.warn('[studio-canvas] commandLogStore init skipped:', e && e.message);
            return null;
          }
        })();
  async function recordCanvasPatch({ canvasId, commandId, actorId, baseRevision, ops, mode }) {
    if (!commandLog) return null;
    try {
      const payload = { baseRevision, ops };
      if (mode) payload.mode = mode;
      const r = await commandLog.appendCommand({
        canvasId, commandId, type: 'canvas.patch', actorId, baseRevision,
        payload,
      });
      if (r && r.ok === false) { console.warn('[studio-canvas] appendCommand rejected:', JSON.stringify(r.errors || r)); return null; }
      return r || null;
    } catch (e) {
      console.warn('[studio-canvas] appendCommand failed after commit (PATCH unaffected):', e && e.message);
      return null;
    }
  }

  // G22 Phase-2 — node.update(data-only) 的 kind-scoped LWW 直写路径(单文件垂直)。
  // 只改 data_json、不动画布 revision; appendCommand 幂等(UNIQUE command_id=clientMutationId)
  // 防重放双写, seq 由 DB 自增回填 commandSeq。任一行 UPDATE 0 行(节点消失)→ 返回 false
  // 回落整画布 CAS 兜底(409 语义)。命令日志写于 COMMIT 后(warn-only, 与主链同哲学)。
  async function applyKindScopedLww(client, res, access, user, canvas, body, base, cmid, lwwUpdateOps) {
    const byId = new Map();
    for (const raw of body.upsertNodes) byId.set(String((raw && raw.nodeId) || (raw && raw.id) || '').trim(), raw);
    // 归一化全部待更新节点 + 权威绑定校验(与整画布 CAS 路径同源): data-only
    // node.update 同样可能改写 data.shotId / data.structureNodeId, 不可绕过绑定守卫。
    const normNodes = [];
    for (const op of lwwUpdateOps) {
      const raw = byId.get(op.nodeId);
      if (!raw) { await client.query('ROLLBACK'); sendErr(sendJSON, res, 400, 'INVALID_NODE'); return true; }
      normNodes.push({ nodeId: op.nodeId, data: durableNodeData(raw.data || raw) });
    }
    await assertBindingsValid(client, access.project.id, canvas.id, normNodes);
    // L44/L46 — data-only node.update 同样走语义持久化(视频节点参数变更时 parked 态同步)。
    await persistSemanticsForNodes(client, canvas.id, normNodes);
    let affected = 0;
    const applied = [];
    for (const op of lwwUpdateOps) {
      const data = normNodes.find((n) => n.nodeId === op.nodeId).data;
      const ur = await client.query('UPDATE studio_canvas_nodes SET data_json=$2, updated_at=NOW() WHERE canvas_id=$1 AND node_id=$3', [canvas.id, JSON.stringify(data), op.nodeId]);
      affected += (ur && ur.rowCount) || 0;
      applied.push({ op, data });
    }
    if (affected < lwwUpdateOps.length) return false; // 节点消失 → 回落整画布 CAS(409 语义)
    const graph = await loadGraph(client, canvas.id);
    const fresh = (await client.query('SELECT * FROM studio_canvases WHERE id=$1', [canvas.id])).rows[0];
    const resp = { ...response(fresh, graph, fresh.viewport_json, { permissions: access.permissions, extra: { applied: true, clientMutationId: cmid } }), ok: true, mode: 'kind-scoped-lww', revision: fresh.revision };
    const raced = await insertMutation(client, { canvasId: canvas.id, cmid, baseRevision: base, resultingRevision: fresh.revision, responseJson: resp, userId: user.id });
    if (raced) { await client.query('ROLLBACK'); sendJSON(res, 200, { ...raced, idempotent: true }); return true; }
    await client.query('COMMIT');
    const logged = await recordCanvasPatch({ canvasId: canvas.id, commandId: cmid, actorId: user.id, baseRevision: base, mode: 'kind-scoped-lww', ops: applied.map(({ op, data }) => ({ op: op.op, kind: op.kind, nodeId: op.nodeId, fields: op.fields, reason: op.reason, data })) });
    if (logged && logged.ok !== false && logged.idempotent === false && logged.seq != null) resp.commandSeq = logged.seq;
    await emit('canvas.updated', { canvas_id: canvas.id, project_id: access.project.id, workspace_id: fresh.workspace_id, revision: fresh.revision, actor_id: user.id, timestamp: new Date().toISOString() });
    sendJSON(res, 200, resp);
    return true;
  }

  // G22 Phase-3 — merge 桶(边 create/delete)kind-scoped 直写路径(单文件垂直)。
  // 无整画布 CAS; 逐主键 upsert/delete + appendCommand(幂等)。边删除 0 行(不存在边)
  // = 幂等成功; 边 upsert 0 行(防御) → 返回 false 回落整画布 CAS(409 语义)。
  // 顺序对齐整画布 CAS 路径: 删除先、upsert 后。命令日志写于 COMMIT 后(warn-only)。
  async function applyKindScopedMerge(client, res, access, user, canvas, body, base, cmid, mergeOps) {
    // body.upsertEdges 可能缺席(纯 deleteEdgeIds patch, handlePatch 已归一 [] 语义)——必须与
    // 整画布 CAS 路径一致容忍缺失键, 否则 delete-only 合并 patch 会 500。
    const rawUpsertEdges = Array.isArray(body.upsertEdges) ? body.upsertEdges : [];
    const upsertById = new Map();
    for (const raw of rawUpsertEdges) upsertById.set(String((raw && raw.edgeId) || (raw && raw.id) || '').trim(), raw);
    const deleteOps = mergeOps.filter((o) => o.op === 'deleteEdge');
    const upsertOps = mergeOps.filter((o) => o.op === 'upsertEdge');

    const fullOps = [];
    if (deleteOps.length) {
      const ids = deleteOps.map((o) => o.edgeId);
      await client.query('DELETE FROM studio_canvas_edges WHERE canvas_id=$1 AND edge_id = ANY($2::text[])', [canvas.id, ids]);
      for (const o of deleteOps) fullOps.push({ op: 'deleteEdge', kind: 'edge.delete', edgeId: o.edgeId, reason: o.reason });
    }
    for (const op of upsertOps) {
      const raw = upsertById.get(op.edgeId);
      if (!raw) { await client.query('ROLLBACK'); sendErr(sendJSON, res, 400, 'INVALID_EDGE'); return true; }
      const e = normalizeEdge(raw);
      const ir = await client.query(`INSERT INTO studio_canvas_edges (canvas_id,edge_id,source_node_id,source_handle,target_node_id,target_handle,edge_type,data_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT (canvas_id,edge_id) DO UPDATE SET source_node_id=EXCLUDED.source_node_id,source_handle=EXCLUDED.source_handle,target_node_id=EXCLUDED.target_node_id,target_handle=EXCLUDED.target_handle,edge_type=EXCLUDED.edge_type,data_json=EXCLUDED.data_json,updated_at=NOW()`, [canvas.id, e.edgeId, e.sourceNodeId, e.sourceHandle, e.targetNodeId, e.targetHandle, e.edgeType, JSON.stringify(e.data)]);
      if (!ir || !ir.rowCount) return false; // 0 行(防御) → 回落整画布 CAS(409 语义)
      fullOps.push({ op: 'upsertEdge', kind: 'edge.create', edgeId: e.edgeId, reason: op.reason, edge: { edgeId: e.edgeId, sourceNodeId: e.sourceNodeId, sourceHandle: e.sourceHandle, targetNodeId: e.targetNodeId, targetHandle: e.targetHandle, edgeType: e.edgeType, data: e.data } });
    }

    const graph = await loadGraph(client, canvas.id);
    const fresh = (await client.query('SELECT * FROM studio_canvases WHERE id=$1', [canvas.id])).rows[0];
    const resp = { ...response(fresh, graph, fresh.viewport_json, { permissions: access.permissions, extra: { applied: true, clientMutationId: cmid } }), ok: true, mode: 'kind-scoped-merge', revision: fresh.revision };
    const raced = await insertMutation(client, { canvasId: canvas.id, cmid, baseRevision: base, resultingRevision: fresh.revision, responseJson: resp, userId: user.id });
    if (raced) { await client.query('ROLLBACK'); sendJSON(res, 200, { ...raced, idempotent: true }); return true; }
    await client.query('COMMIT');
    const logged = await recordCanvasPatch({ canvasId: canvas.id, commandId: cmid, actorId: user.id, baseRevision: base, mode: 'kind-scoped-merge', ops: fullOps });
    if (logged && logged.ok !== false && logged.idempotent === false && logged.seq != null) resp.commandSeq = logged.seq;
    await emit('canvas.updated', { canvas_id: canvas.id, project_id: access.project.id, workspace_id: fresh.workspace_id, revision: fresh.revision, actor_id: user.id, timestamp: new Date().toISOString() });
    sendJSON(res, 200, resp);
    return true;
  }

  async function handleGet(req, res, user, projectId) {
    const access = await requireProject(pg, res, user, projectId); if (!access) return;
    const canvas = await getCanvas(pg, projectId);
    if (!canvas) return sendJSON(res, 200, { canvas: null, nodes: [], edges: [], viewport: null, permissions: access.permissions });
    const graph = await loadGraph(pg, canvas.id);
    await restoreParkedIntoGraph(pg, canvas.id, graph);
    return sendJSON(res, 200, response(canvas, graph, canvas.viewport_json, { permissions: access.permissions }));
  }
  async function handleCreate(req, res, user, projectId) {
    const body = (await parseBody(req)) || {}; const client = await pg.connect();
    try { await client.query('BEGIN'); const access = await requireProject(client, res, user, projectId); if (!access) { await client.query('ROLLBACK'); return; } if (!access.permissions.canUpdate) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 403, '无权编辑该项目'); }
      const canvas = await createCanvasTx(client, access.project, user, cleanText(body.name, LIMITS.maxNameLength) || 'Primary Canvas'); const graph = await loadGraph(client, canvas.id); await client.query('COMMIT');
      await emit('canvas.created', { canvas_id: canvas.id, project_id: projectId, workspace_id: canvas.workspace_id, revision: canvas.revision, actor_id: user.id, timestamp: new Date().toISOString() });
      return sendJSON(res, canvas.created_by === user.id ? 201 : 200, response(canvas, graph, canvas.viewport_json, { permissions: access.permissions }));
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} if (e.message === 'INVALID_NODE') return sendErr(sendJSON, res, 400, 'INVALID_NODE'); throw e; } finally { client.release(); }
  }
  async function handlePatch(req, res, user, projectId) {
    const body = (await parseBody(req)) || {}; const cmid = String(body.clientMutationId || '').trim(); const base = Number(body.baseRevision);
    if (!cmid || !Number.isInteger(base)) return sendErr(sendJSON, res, 400, 'INVALID_PATCH');
    const upsertNodes = Array.isArray(body.upsertNodes) ? body.upsertNodes : [];
    const deleteNodeIds = Array.isArray(body.deleteNodeIds) ? body.deleteNodeIds.map(String) : [];
    const upsertEdges = Array.isArray(body.upsertEdges) ? body.upsertEdges : [];
    const deleteEdgeIds = Array.isArray(body.deleteEdgeIds) ? body.deleteEdgeIds.map(String) : [];
    if (upsertNodes.length > LIMITS.maxNodesPerPatch || upsertEdges.length > LIMITS.maxEdgesPerPatch || deleteNodeIds.length + deleteEdgeIds.length > LIMITS.maxDeleteIdsPerPatch) return sendErr(sendJSON, res, 413, 'PATCH_TOO_LARGE');
    const client = await pg.connect();
    try { await client.query('BEGIN'); const access = await requireProject(client, res, user, projectId); if (!access) { await client.query('ROLLBACK'); return; } if (!access.permissions.canUpdate) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 403, '无权编辑该项目'); }
      const canvas = await ensureCanvas(client, access.project, user);
      const prior = await client.query('SELECT response_json FROM studio_canvas_mutations WHERE canvas_id=$1 AND client_mutation_id=$2', [canvas.id, cmid]);
      if (prior.rows.length) { await client.query('COMMIT'); return sendJSON(res, 200, { ...prior.rows[0].response_json, idempotent: true }); }
      // Validate the final projected graph before either kind-scoped writes or
      // the revision CAS. Invalid requests leave revision/log/mutations untouched.
      const graphBefore = await loadGraph(client, canvas.id);
      const projectedGraph = projectCanvasGraph(graphBefore, { upsertNodes, deleteNodeIds, upsertEdges, deleteEdgeIds });
      // Legacy rows written before the server registry contract may lack handles
      // or nodeKind. Keep those canvases operable, but every structurally typed
      // graph (all current clients) is validated fail-closed.
      if (hasStructuralGraphPayload(projectedGraph)) {
        const graphVerdict = validateCanvasGraph({ ...projectedGraph, ops: { upsertNodes, deleteNodeIds, upsertEdges, deleteEdgeIds } });
        if (!graphVerdict.ok) { await client.query('ROLLBACK'); return graphInvalid(sendJSON, res, graphVerdict); }
      }
      // G22 Phase-2 — kind-scoped 灰度: env 开时拆解 PATCH, 纯 node.update(data-only) 走
      // kind-scoped LWW 直写(不改 revision); 其余 kind 与混合 kind 一律回落下方面整画布 CAS。
      if (kindScopedEnabled()) {
        const graph0 = await loadGraph(client, canvas.id);
        const d = decomposeCanvasPatch(body, { existingNodes: graph0.nodes, existingEdges: graph0.edges });
        if (!d.ok) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 400, 'INVALID_PATCH', { errors: d.errors }); }
        const lwwUpdateOps = d.buckets.lww.filter((o) => o.op === 'upsertNode' && o.kind === 'node.update' && o.reason === REASONS.NODE_UPDATE_DATA_ONLY);
        const mergeOps = d.buckets.merge.filter((o) => o.op === 'upsertEdge' || o.op === 'deleteEdge');
        const otherCount = d.summary.total - lwwUpdateOps.length - mergeOps.length;
        if (otherCount === 0) {
          if (mergeOps.length > 0 && lwwUpdateOps.length === 0) {
            // 纯 merge(边 create/delete) → kind-scoped-merge 直写(不改画布 revision)。
            const handled = await applyKindScopedMerge(client, res, access, user, canvas, body, base, cmid, mergeOps);
            if (handled) return;
          } else if (lwwUpdateOps.length > 0 && mergeOps.length === 0) {
            // 纯 data-only node.update → kind-scoped-lww 直写(Phase-2 语义)。
            const handled = await applyKindScopedLww(client, res, access, user, canvas, body, base, cmid, lwwUpdateOps);
            if (handled) return;
          }
          // 混合 lww+merge(无 reject409, 无对应 mode) → 回落整画布 CAS。
        }
        // 否则: reject409 / 混合 kind / 非 data-only → 回落整画布 CAS。
      }
      const cas = await client.query('UPDATE studio_canvases SET revision=revision+1, viewport_json=COALESCE($3, viewport_json), updated_by=$4, updated_at=NOW() WHERE id=$1 AND revision=$2 RETURNING *', [canvas.id, base, body.viewport === undefined ? null : JSON.stringify(safeJson(body.viewport, {})), user.id]);
      if (!cas.rows.length) {
        // v4-pro 审计叶E: 并发同 clientMutationId 双请求——CAS 被对方推进后, 本请求是重放
        // 而非真冲突。整画布 CAS 路径与 kind-scoped 路径的 insertMutation ON CONFLICT 幂等对齐:
        // 先回读同 cmid 已提交 mutation, 命中则幂等 200(非 409), 并 ROLLBACK 丢弃本事务
        // 任何部分写入(含 LWW 回落前的 parked/UPDATE)。未命中才是真 stale → 409。
        const idem = await client.query('SELECT response_json FROM studio_canvas_mutations WHERE canvas_id=$1 AND client_mutation_id=$2', [canvas.id, cmid]);
        if (idem.rows.length) { await client.query('ROLLBACK'); return sendJSON(res, 200, { ...idem.rows[0].response_json, idempotent: true }); }
        const cur = await client.query('SELECT revision FROM studio_canvases WHERE id=$1', [canvas.id]); await client.query('ROLLBACK'); return sendErr(sendJSON, res, 409, 'CONFLICT', { serverRevision: cur.rows[0]?.revision || canvas.revision, canvasId: canvas.id });
      }
      // W2-06 — 权威绑定校验接线(三视图叶2)。CAS 通过后、任何写入(delete/upsert)之前,
      // 对本次 upsertNodes 全部先归一化再校验 —— 绑定只可能随节点 data_json.shotId /
      // data_json.structureNodeId 进入, 故边 upsert / 节点删除路径不携带绑定串, 由同一
      // 流级守卫覆盖: 凡含绑定节点的 PATCH 无论是否同时 upsertEdges/删除都被拦截于写前。
      //   权威集 = 项目域执行 shot(shots.id, 经 episodes 项目归属) + 项目结构节点
      //   (project_structure_nodes.id), 与 23-project-truth-three-view §2.2-3/叶3 目标一致。
      //   限制(注释声明, 不做迁移): 计划 shot(project_shots_rows.shot_id, s{scene}:b{beat}:k{shot})
      //   与执行 shot(shots.id) 双 id 空间尚未统一(叶4 迁移), 本守卫按现有语义仅校验存在性;
      //   计划空间 id 在统一前会被 409 拒 —— canvas data.shotId 语义锁定 = 执行 shot。
      //   空串/纯空白视为"未绑定"(FE storyboard 默认 shotId:'' 占位), 不参与校验。
      const normNodes = upsertNodes.map(normalizeNode);
      // L44/L46 — 视频节点语义持久化: 对带 operation_code 的节点跑三态迁移, 把迁移不了的
      // 参数 parked 到 semantic_parked_state(0069, 不丢), 并写回 data.semanticState/parkedState。
      // 与 0052 locked / 0054 dirty 行级机制无交集(独立表), 读锁/脏标记语义不回退。
      await persistSemanticsForNodes(client, canvas.id, normNodes);
      await assertBindingsValid(client, access.project.id, canvas.id, normNodes);
      if (deleteEdgeIds.length) await client.query('DELETE FROM studio_canvas_edges WHERE canvas_id=$1 AND edge_id = ANY($2::text[])', [canvas.id, deleteEdgeIds]);
      if (deleteNodeIds.length) await client.query('DELETE FROM studio_canvas_nodes WHERE canvas_id=$1 AND node_id = ANY($2::text[])', [canvas.id, deleteNodeIds]);
      for (const n of normNodes) { await client.query(`INSERT INTO studio_canvas_nodes (canvas_id,node_id,node_type,node_schema_version,position_x,position_y,width,height,z_index,data_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()) ON CONFLICT (canvas_id,node_id) DO UPDATE SET node_type=EXCLUDED.node_type,node_schema_version=EXCLUDED.node_schema_version,position_x=EXCLUDED.position_x,position_y=EXCLUDED.position_y,width=EXCLUDED.width,height=EXCLUDED.height,z_index=EXCLUDED.z_index,data_json=EXCLUDED.data_json,updated_at=NOW()`, [canvas.id,n.nodeId,n.nodeType,n.nodeSchemaVersion,n.positionX,n.positionY,n.width,n.height,n.zIndex,JSON.stringify(n.data)]); }
      for (const raw of upsertEdges) { const e = normalizeEdge(raw); await client.query(`INSERT INTO studio_canvas_edges (canvas_id,edge_id,source_node_id,source_handle,target_node_id,target_handle,edge_type,data_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT (canvas_id,edge_id) DO UPDATE SET source_node_id=EXCLUDED.source_node_id,source_handle=EXCLUDED.source_handle,target_node_id=EXCLUDED.target_node_id,target_handle=EXCLUDED.target_handle,edge_type=EXCLUDED.edge_type,data_json=EXCLUDED.data_json,updated_at=NOW()`, [canvas.id,e.edgeId,e.sourceNodeId,e.sourceHandle,e.targetNodeId,e.targetHandle,e.edgeType,JSON.stringify(e.data)]); }
      const graph = await loadGraph(client, canvas.id); const fresh = (await client.query('SELECT * FROM studio_canvases WHERE id=$1', [canvas.id])).rows[0]; const extra = { applied: true, clientMutationId: cmid }; if (kindScopedEnabled()) extra.mode = 'canvas-cas'; const resp = response(fresh, graph, fresh.viewport_json, { permissions: access.permissions, extra });
      const raced = await insertMutation(client, { canvasId: canvas.id, cmid, baseRevision: base, resultingRevision: fresh.revision, responseJson: resp, userId: user.id });
      if (raced) { await client.query('ROLLBACK'); return sendJSON(res, 200, { ...raced, idempotent: true }); }
      await client.query('COMMIT');
      // G22 — mutation 已提交(CAS 通过)后写 canvas.patch 命令日志。commandId=clientMutationId,
      // 幂等由 (canvas_id,command_id) 保证 → 同 mutationId 重放安全。失败路径仅在成功分支后
      // warn-only(见 recordCanvasPatch), 不破主链。409/校验失败/回滚路径永不走到此处。
      await recordCanvasPatch({ canvasId: canvas.id, commandId: cmid, actorId: user.id, baseRevision: base, ops: { nodeUpserts: upsertNodes.length, nodeDeletes: deleteNodeIds.length, edgeUpserts: upsertEdges.length, edgeDeletes: deleteEdgeIds.length } });
      await emit('canvas.updated', { canvas_id: canvas.id, project_id: projectId, workspace_id: fresh.workspace_id, revision: fresh.revision, actor_id: user.id, timestamp: new Date().toISOString() }); return sendJSON(res, 200, resp);
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} if (e.message === 'BINDING_INVALID') return sendErr(sendJSON, res, 409, 'BINDING_INVALID', { errors: e.bindingErrors || [], canvasId: e.canvasId }); if (['INVALID_NODE','INVALID_EDGE'].includes(e.message)) return sendErr(sendJSON, res, 400, e.message); if (e.code === '23503') return sendErr(sendJSON, res, 400, 'INTEGRITY_ERROR'); throw e; } finally { client.release(); }
  }
  async function handleVersionList(req, res, user, projectId) { const access = await requireProject(pg, res, user, projectId); if (!access) return; const canvas = await getCanvas(pg, projectId); if (!canvas) return sendJSON(res, 200, { versions: [], pagination: { limit: 20, offset: 0, total: 0, hasMore: false } }); const q = req.query || {}; const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100); const offset = Math.max(Number(q.offset) || 0, 0); const cr = await pg.query('SELECT COUNT(*)::int AS total FROM studio_canvas_versions WHERE canvas_id=$1', [canvas.id]); const r = await pg.query('SELECT id,canvas_id,revision,version_number,name,description,snapshot_json,created_by,restore_source_version_id,created_at FROM studio_canvas_versions WHERE canvas_id=$1 ORDER BY version_number DESC LIMIT $2 OFFSET $3', [canvas.id, limit, offset]); const versions = r.rows.map(v => ({ id:v.id, canvasId:v.canvas_id, revision:v.revision, versionNumber:v.version_number, name:v.name, description:v.description, createdBy:v.created_by, createdAt:toIso(v.created_at), restoredFromVersionId:v.restore_source_version_id, nodeCount:(v.snapshot_json?.nodes||[]).length, edgeCount:(v.snapshot_json?.edges||[]).length })); return sendJSON(res, 200, { versions, pagination: { limit, offset, total: cr.rows[0].total, hasMore: offset + versions.length < cr.rows[0].total } }); }
  async function handleVersionCreate(req, res, user, projectId) { const body = (await parseBody(req)) || {}; const client = await pg.connect(); try { await client.query('BEGIN'); const access = await requireProject(client, res, user, projectId); if (!access) { await client.query('ROLLBACK'); return; } if (!access.permissions.canUpdate) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 403, '无权编辑该项目'); } const canvas = await ensureCanvas(client, access.project, user); // Commercial hardening (B): serialize concurrent version creates per canvas.
      // The MAX(version_number)+1 read below is only race-free while we hold this row lock.
      await client.query('SELECT id FROM studio_canvases WHERE id=$1 FOR UPDATE', [canvas.id]); const graph = await loadGraph(client, canvas.id); const snap = { schemaVersion: canvas.schema_version, revision: canvas.revision, nodes: graph.nodes, edges: graph.edges, viewport: canvas.viewport_json || null }; if (Buffer.byteLength(JSON.stringify(snap)) > LIMITS.maxSnapshotBytes) { await client.query('ROLLBACK'); return sendErr(sendJSON, res, 413, 'SNAPSHOT_TOO_LARGE'); } const nr = await client.query('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM studio_canvas_versions WHERE canvas_id=$1', [canvas.id]); const vr = await client.query('INSERT INTO studio_canvas_versions (id,canvas_id,revision,version_number,name,description,snapshot_json,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *', [`scv-${crypto.randomUUID()}`,canvas.id,canvas.revision,nr.rows[0].n,cleanText(body.name,LIMITS.maxNameLength),cleanText(body.description,LIMITS.maxDescriptionLength),JSON.stringify(snap),user.id]); await client.query('COMMIT'); const v=vr.rows[0]; return sendJSON(res,201,{version:{id:v.id,canvasId:v.canvas_id,revision:v.revision,versionNumber:v.version_number,name:v.name,description:v.description,createdBy:v.created_by,createdAt:toIso(v.created_at),nodeCount:graph.nodes.length,edgeCount:graph.edges.length}}); } catch(e){ try{await client.query('ROLLBACK');}catch(_){} throw e;} finally{client.release();} }
  async function handleRestore(req, res, user, projectId, versionId) { const body = (await parseBody(req)) || {}; const base = Number(body.baseRevision); if (!Number.isInteger(base)) return sendErr(sendJSON,res,400,'INVALID_RESTORE'); const client = await pg.connect(); try { await client.query('BEGIN'); const access = await requireProject(client,res,user,projectId); if(!access){await client.query('ROLLBACK'); return;} if(!access.permissions.canUpdate){await client.query('ROLLBACK'); return sendErr(sendJSON,res,403,'无权恢复版本');} const canvas = await ensureCanvas(client, access.project, user); const vr = await client.query('SELECT * FROM studio_canvas_versions WHERE id=$1 AND canvas_id=$2', [versionId, canvas.id]); if(!vr.rows.length){ await client.query('ROLLBACK'); return sendErr(sendJSON,res,404,'版本不存在'); } const snapGraph = { nodes: vr.rows[0].snapshot_json.nodes || [], edges: vr.rows[0].snapshot_json.edges || [] }; const graphVerdict = hasStructuralGraphPayload(snapGraph) ? validateCanvasGraph(snapGraph) : { ok: true }; if (!graphVerdict.ok) { await client.query('ROLLBACK'); return graphInvalid(sendJSON, res, graphVerdict); } const cas = await client.query('UPDATE studio_canvases SET revision=revision+1, viewport_json=$3, restored_from_version_id=$4, updated_by=$5, updated_at=NOW() WHERE id=$1 AND revision=$2 RETURNING *', [canvas.id, base, JSON.stringify(vr.rows[0].snapshot_json.viewport || null), versionId, user.id]); if(!cas.rows.length){ const cur=await client.query('SELECT revision FROM studio_canvases WHERE id=$1',[canvas.id]); await client.query('ROLLBACK'); return sendErr(sendJSON,res,409,'CONFLICT',{serverRevision:cur.rows[0]?.revision||canvas.revision,canvasId:canvas.id}); } await client.query('DELETE FROM studio_canvas_edges WHERE canvas_id=$1',[canvas.id]); await client.query('DELETE FROM studio_canvas_nodes WHERE canvas_id=$1',[canvas.id]); await bulkInsertNodes(client,canvas.id,vr.rows[0].snapshot_json.nodes || []); await bulkInsertEdges(client,canvas.id,vr.rows[0].snapshot_json.edges || []); const fresh=cas.rows[0]; const graph=await loadGraph(client,canvas.id); await client.query('COMMIT'); return sendJSON(res,200,response(fresh,graph,fresh.viewport_json,{permissions:access.permissions,extra:{restoredFromVersionId:versionId}})); } catch(e){ try{await client.query('ROLLBACK');}catch(_){} throw e;} finally{client.release();} }

  async function handle(req, res, urlPath, method) {
    const restore = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/studio\/canvas\/versions\/([^/]+)\/restore$/);
    const m = urlPath.match(PREFIX_RE);
    if (!m && !restore) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }
    const user = requireUser(req, res); if (!user) return true;
    const projectId = decodeURIComponent((restore ? restore[1] : m[1]));
    const seg1 = m && m[2]; const seg2 = m && m[3];
    try {
      if (restore && method === 'POST') return await handleRestore(req,res,user,projectId,decodeURIComponent(restore[2])), true;
      if (!seg1 && method === 'GET') return await handleGet(req,res,user,projectId), true;
      if (!seg1 && method === 'POST') return await handleCreate(req,res,user,projectId), true;
      if (!seg1 && method === 'PATCH') return await handlePatch(req,res,user,projectId), true;
      if (seg1 === 'versions' && !seg2 && method === 'GET') return await handleVersionList(req,res,user,projectId), true;
      if (seg1 === 'versions' && !seg2 && method === 'POST') return await handleVersionCreate(req,res,user,projectId), true;
      return sendJSON(res, 404, { ok:false, error:'Not Found' }), true;
    } catch (e) { console.error('[studio-canvas] route error:', e && e.stack); return sendJSON(res, 500, { ok:false, error:'服务内部错误' }), true; }
  }
  return { handle, LIMITS };
}
function validateAuthoritativeBindings(nodes, { shotIds = [], structureNodeIds = [] } = {}) {
  const errors = [];
  for (const n of nodes || []) {
    const data = n.data || {};
    const sid = data.shotId;
    const snid = data.structureNodeId;
    if (sid != null && !shotIds.includes(sid)) errors.push(`node.${n.nodeId}: shotId ${sid} is not an authoritative project shot`);
    if (snid != null && !structureNodeIds.includes(snid)) errors.push(`node.${n.nodeId}: structureNodeId ${snid} is not an authoritative project structure node`);
  }
  return { ok: errors.length === 0, errors };
}

// G22 Phase-3 — 投影重建(纯函数, 独立导出供集成): 在快照 current 上重放命令日志里
// lww/merge/append 类的 kind 分解 entries, 产出 { nodes, edges } 投影。
//   不动 reject-409: 该桶(op 由整画布 CAS 路径执行)在日志里只有计数摘要(payload.ops
//   为对象非数组)或本就未经 kind 日志, 其投影效果已直接落于快照 current —— 本函数跳过。
//   收敛语义: 同实体多 entry 按传入顺序(调用方须 seq 升序)后写覆盖 → 单投影(并发同边
//   双 append 归并为一条, 最后写入者胜)。
//   纯函数: 无 DB/无随机/无隐式全局, 同输入恒同输出; 不抛(畸形 entry/op 静默跳过)。
//   current.nodes/edges 为 loadGraph 的 formatNode/formatEdge 形状(camelCase)。
//   logEntries[i].payload.ops 为 kind 分解数组(本切片 lww 携 data、merge 携 edge 载荷)。
function rebuildProjection({ current, logEntries }) {
  const nodes = new Map();
  const edges = new Map();
  const curNodes = current && Array.isArray(current.nodes) ? current.nodes : [];
  const curEdges = current && Array.isArray(current.edges) ? current.edges : [];
  for (const n of curNodes) if (n && n.nodeId != null) nodes.set(String(n.nodeId), { ...n });
  for (const e of curEdges) if (e && e.edgeId != null) edges.set(String(e.edgeId), { ...e });

  for (const entry of (Array.isArray(logEntries) ? logEntries : [])) {
    const payload = entry && typeof entry === 'object' ? entry.payload : null;
    const ops = payload && Array.isArray(payload.ops) ? payload.ops : [];
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      const bucket = typeof op.kind === 'string' ? (KIND_BUCKET_BY_COMMAND[op.kind] || 'skip') : 'skip';
      if (bucket === 'merge') {
        if (op.op === 'deleteEdge' || op.kind === 'edge.delete') {
          if (op.edgeId != null) edges.delete(String(op.edgeId));
        } else if (op.op === 'upsertEdge' || op.kind === 'edge.create') {
          const id = op.edgeId != null ? String(op.edgeId) : (op.edge && op.edge.edgeId != null ? String(op.edge.edgeId) : null);
          if (id && op.edge && typeof op.edge === 'object') edges.set(id, { ...op.edge, edgeId: id });
        }
      } else if (bucket === 'lww') {
        // 本切片 lww 日志仅 data-only node.update(携 data 载荷); move/resize/viewport 无结构变化。
        if (op.op === 'upsertNode' && op.kind === 'node.update' && op.data !== undefined && op.nodeId != null) {
          const existing = nodes.get(String(op.nodeId));
          if (existing) existing.data = op.data;
        }
      }
      // reject-409 / append / 未知 kind → skip(append 无投影结构影响; reject409 已在快照内)。
    }
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
    edges: [...edges.values()].sort((a, b) => (a.edgeId < b.edgeId ? -1 : 1)),
  };
}

module.exports = { createStudioCanvasPersistence, normalizeNode, normalizeEdge, durableNodeData, bulkInsertNodes, bulkInsertEdges, validateAuthoritativeBindings, rebuildProjection, computeVideoNodeSemantics, resolveOperationSemanticMap, syncParkedState, loadParkedState, loadParkedStateForCanvas, persistVideoNodeSemantics, persistSemanticsForNodes, restoreParkedIntoGraph, VIDEO_NODE_FIELD_ALIASES, LIMITS };
