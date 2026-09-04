'use strict';
/**
 * G22 CAS 投影重建① — applyLogToProjection 纯函数（叶 4，纯模块，无 I/O）。
 * =====================================================================
 * 依据 docs/product-v2/26-canvas-cas-per-kind-design.md §2.2-2.3（命令日志真源 +
 * 投影表 / 按 kind 差异化执行）与 §5 叶 4（投影 apply 执行器）。由 Phase-3
 * persistence 的 rebuildProjection 调用：`快照(current) + listAfter(entries) → 投影`。
 *
 * 纯性契约：
 *   - 不碰 DB/文件/时钟；入参（current 节点/边行、entries 及其 payload/ops 内嵌对象）
 *     一律只读。内部以深拷贝摄入（structuredClone 语义），输出 {nodes,edges} 是全新
 *     对象树 —— 与入参零别名。同入参调用 N 次 → 深度相等的输出。
 *   - 'use strict' + 只写内部副本 ⇒ 对深冻结入参调用不抛错、入参保持不变（测试覆盖）。
 *
 * 重放语义（对齐 26 §2.3 执行矩阵 + collabContract CONFLICT_POLICY_BY_KIND）：
 *   entries 为 canvas_command_log 行（listAfter 语义，seq 单调）；本函数先按 seq
 *   升序稳定排序再重放 —— 乱序输入同样收敛（LWW 按 seq 取后胜）。
 *
 *   ┌ command_type 分派 ─────────────────────────────────────────────────
 *   │ · 'canvas.patch'  → 解析 payload { ops, bucket? } 逐 op 重放（下详）。
 *   │ · append 前缀类（presence./comment./annotation./chat./log.，经
 *   │   collabContract.isAppendKind 同源判定）→ 本投影是「图视图 {nodes,edges}」，
 *   │   纯追加类不改图结构 ⇒ 整条忽略（view 忽略），payload 可缺省。
 *   │ · 其它任何类型（含 node.create/node.delete 等 reject-409 kind 行 / 未知类型）
 *   │   → 抛 ERR_REJECT_BUCKET_IN_LOG —— 该内容不可能出现在合法画布日志。
 *   └──────────────────────────────────────────────────────────────────────
 *   payload（canvas.patch 行）：
 *     { baseRevision?, mode?, bucket?: <桶标记>, ops?: [OpEntry, ...] }
 *     · bucket 标记（可选，Phase-3 前的向前兼容断言）：必须在
 *       BUCKET.{LWW,MERGE,APPEND}（设计约定 reject 桶永不入 log）；值为
 *       'reject409' 或未知字符串 → 抛 ERR_REJECT_BUCKET_IN_LOG；与 ops 派生桶
 *       不一致 → ERR_INVALID_LOG。
 *     · ops 缺省 → 无图 ops（元数据行，零投影效果）。ops 存在必须为数组，逐条
 *       按 kind 归桶执行：
 *         lww   node.update / node.move / node.resize —— 同实体「字段合并窗」：
 *               仅覆写 fields 列出的域（position/size/zIndex/data/nodeType/
 *               nodeSchemaVersion），未列域保留投影现值 ⇒ 并发不同域编辑都存活，
 *               同域以「后 seq 胜」（按序重放天然满足）。行值携带 OpEntry 顶层
 *               （formatNode wire 行：nodeId/nodeType/nodeSchemaVersion/position/
 *               size/zIndex/data），亦可嵌套于 op.node。fields 缺省/null/空数组
 *               ⇒ 整行覆写（node.update 词表语义）。
 *               canvas.viewport.update —— 投影为图视图，无 viewport 域 ⇒ 忽略。
 *         merge  edge.create（upsertEdge，按 edge_id 键并集覆写，后 seq 胜）/
 *                edge.delete（deleteEdge，幂等删除：键不存在=无操作）。
 *         append kind 前缀（isAppendKind）→ view 忽略。
 *     · 任 op 的 kind 解析到 reject-409（node.create/node.delete）→
 *       抛 ERR_REJECT_BUCKET_IN_LOG（design 约定：reject 桶不入 log —— 日志中出现
 *       即违背投影不变量，重建必须失败而不是静默错图）。
 *
 * 入参校验（所有失败抛带 .code 的 Error）：
 *   ERR_INVALID_ARGUMENT —— 顶层形状：arg/current/entries 非对象、nodes/edges 非
 *     数组、entry 非对象、多 entry 缺 seq 或 seq 重复等（调用方接线错误）。
 *   ERR_INVALID_LOG        —— 日志内容畸形：type 歧义/缺失、payload 非对象、ops
 *     非数组、OpEntry 缺 op/kind、op↔kind 不匹配、未知 op、未知节点域、upsert 行
 *     缺键、bucket 标记与派生桶不一致、command_id 双键不一致等。
 *   ERR_REJECT_BUCKET_IN_LOG —— reject 类内容出现在日志：node.create/node.delete
 *     op、bucket='reject409'、未知桶标记、非 canvas.patch 且非 append 的 command_type
 *     （未知类型契约默认 reject-409 ⇒ 不可能是合法日志内容）。
 *
 * 行/值形状（与 studioCanvasPersistence.formatNode/formatEdge + loadGraph 输出一致）：
 *   节点 row: { nodeId, nodeType, nodeSchemaVersion, position:{x,y},
 *              size:{width,height}|null, zIndex|null, data:{...} }
 *   边   row: { edgeId, sourceNodeId, sourceHandle, targetNodeId, targetHandle,
 *              edgeType, data:{...} }
 * ⚠️ Phase-1/2 的 canvas.patch 历史行（payload.ops 为计数对象 或 decomposer 无行值
 *   ops）不可重放 —— 投影重建的游标策略必须只回放 Phase-3 起（快照 seq 之后）的
 *   完整行载荷；把不可重放行喂给本函数会得到 ERR_INVALID_LOG（拒绝而非错图）。
 */

const { conflictPolicyFor, isAppendKind } = require('../studio-contracts/collabContract.cjs');
const { BUCKET_KEYS, KIND_BUCKET_BY_COMMAND } = require('./canvasCommandDecomposer.cjs');

/* ── 错误码（导出物） ─────────────────────────────────────────────── */
const ERROR_CODES = Object.freeze({
  REJECT_BUCKET_IN_LOG: 'ERR_REJECT_BUCKET_IN_LOG',
  INVALID_LOG: 'ERR_INVALID_LOG',
  INVALID_ARGUMENT: 'ERR_INVALID_ARGUMENT',
});

/* ── BUCKET 常量（同源：与 canvasCommandDecomposer 桶名逐一核对，漂移即崩） ── */
const BUCKET = Object.freeze({
  REJECT409: 'reject409',
  LWW: 'lww',
  MERGE: 'merge',
  APPEND: 'append',
});
/** 合法可入 log 的桶（design 约定：reject 桶永不入 log）。 */
const LOGGED_BUCKETS = Object.freeze([BUCKET.LWW, BUCKET.MERGE, BUCKET.APPEND]);
(() => {
  const here = Object.values(BUCKET).slice().sort();
  const there = [...BUCKET_KEYS].sort();
  if (here.join(',') !== there.join(',')) {
    throw new Error('[canvasProjection] bucket drift vs canvasCommandDecomposer: '
      + `${here.join(',')} != ${there.join(',')}`);
  }
})();

/* ── 词表 / 域 ─────────────────────────────────────────────────────── */
const NODE_DOMAINS = Object.freeze(['position', 'size', 'zIndex', 'data', 'nodeType', 'nodeSchemaVersion']);
/** op ↔ kind 白名单（与 canvasCommandDecomposer 产出对齐；其它组合=畸形日志）。 */
const OP_KIND_ALLOW = Object.freeze({
  upsertNode: ['node.update', 'node.move', 'node.resize'],
  deleteNode: ['node.delete'],
  upsertEdge: ['edge.create'],
  deleteEdge: ['edge.delete'],
  viewport: ['canvas.viewport.update'],
});
/** kind → 桶（与 CONFLICT_POLICY_BY_KIND 同源：经 conflictPolicyFor + 静态核对）。 */
const KIND_BUCKET = Object.freeze({
  'node.update': BUCKET.LWW,
  'node.move': BUCKET.LWW,
  'node.resize': BUCKET.LWW,
  'canvas.viewport.update': BUCKET.LWW,
  'edge.create': BUCKET.MERGE,
  'edge.delete': BUCKET.MERGE,
});
(() => {
  // 不变量：KIND_BUCKET 中每个 kind 的契约策略必须与本桶一致（漂移即崩）。
  for (const [kind, bucket] of Object.entries(KIND_BUCKET)) {
    const mapBucket = KIND_BUCKET_BY_COMMAND[kind];
    const policyBucket = mapBucket !== undefined
      ? mapBucket // 与 decomposer 静态表对照（同源锚点）
      : null;
    if (policyBucket !== bucket || (mapBucket === undefined && conflictPolicyFor(kind) === 'reject-409')) {
      throw new Error(`[canvasProjection] kind ${kind}: bucket drift vs decomposer/contract`);
    }
  }
})();

/* ── 工具 ─────────────────────────────────────────────────────────── */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

function raise(code, msg) {
  const e = new Error(`${code}: ${msg}`);
  e.code = code;
  throw e;
}
const raiseReject = (msg) => raise(ERROR_CODES.REJECT_BUCKET_IN_LOG, msg);
const raiseInvalidLog = (msg) => raise(ERROR_CODES.INVALID_LOG, msg);
const raiseInvalidArgument = (msg) => raise(ERROR_CODES.INVALID_ARGUMENT, msg);

/** JSON 安全深拷贝（投影行均为可 JSON 化数据）。 */
function cloneDeep(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

/* ── 行提取（白名单域；输入行可带额外键，只取投影域） ─────────────── */
const NODE_ROW_KEYS = Object.freeze(['nodeId', 'nodeType', 'nodeSchemaVersion', 'position', 'size', 'zIndex', 'data']);
const EDGE_ROW_KEYS = Object.freeze(['edgeId', 'sourceNodeId', 'sourceHandle', 'targetNodeId', 'targetHandle', 'edgeType', 'data']);

function pickRow(src, keys) {
  const out = {};
  for (const k of keys) if (src !== undefined && src !== null && hasOwn(src, k) && src[k] !== undefined) out[k] = src[k];
  return out;
}

/** OpEntry → 节点行值。支持嵌套 op.node（优先）或扁平 spread（row 键在 entry 顶层）。 */
function extractNodeRow(op) {
  const nested = isPlainObject(op.node) ? pickRow(op.node, NODE_ROW_KEYS) : {};
  const flat = pickRow(op, NODE_ROW_KEYS);
  const row = { ...flat, ...nested };
  if (!isNonEmptyString(row.nodeId)) {
    raiseInvalidLog(`upsertNode op missing nodeId row value: ${JSON.stringify(op)}`);
  }
  return row;
}
function extractEdgeRow(op) {
  const nested = isPlainObject(op.edge) ? pickRow(op.edge, EDGE_ROW_KEYS) : {};
  const flat = pickRow(op, EDGE_ROW_KEYS);
  const row = { ...flat, ...nested };
  if (!isNonEmptyString(row.edgeId)) {
    raiseInvalidLog(`upsertEdge op missing edgeId row value: ${JSON.stringify(op)}`);
  }
  return row;
}

/* ── 快照摄入（深拷贝，输出与入参零别名） ─────────────────────────── */
function ingestGraph(current) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  if (current !== undefined && current !== null) {
    if (!isPlainObject(current)) raiseInvalidArgument('current must be a plain object {nodes, edges}');
    if (current.nodes !== undefined && !Array.isArray(current.nodes)) raiseInvalidArgument('current.nodes must be an array');
    if (current.edges !== undefined && !Array.isArray(current.edges)) raiseInvalidArgument('current.edges must be an array');
    for (const [i, n] of (current.nodes || []).entries()) {
      if (!isPlainObject(n) || !isNonEmptyString(n.nodeId)) {
        raiseInvalidArgument(`current.nodes[${i}] must be a node row with non-empty nodeId`);
      }
      nodeMap.set(n.nodeId, cloneDeep(n));
    }
    for (const [i, e] of (current.edges || []).entries()) {
      if (!isPlainObject(e) || !isNonEmptyString(e.edgeId)) {
        raiseInvalidArgument(`current.edges[${i}] must be an edge row with non-empty edgeId`);
      }
      edgeMap.set(e.edgeId, cloneDeep(e));
    }
  }
  return { nodeMap, edgeMap };
}

/* ── 入口行归一（容忍 DB 原行 snake_case 与 commandLogStore.fromRow camelCase） ── */
const TYPE_ALIASES = ['command_type', 'type', 'commandType'];
const CMD_ID_ALIASES = ['command_id', 'commandId'];

function resolveAliased(entry, aliases, label, required) {
  const present = aliases.filter((k) => hasOwn(entry, k));
  if (present.length === 0) {
    if (required) raiseInvalidLog(`entry missing ${label} (${aliases.join('/')})`);
    return undefined;
  }
  const values = new Set(present.map((k) => entry[k]));
  if (values.size > 1) raiseInvalidLog(`entry has conflicting ${label} values across ${present.join('/')}`);
  return entry[present[0]];
}

/** 排序校验：entries.length>1 ⇒ 每条需整数 seq 且画布内唯一（(canvas_id,seq) PK 语义）。 */
function sortEntries(entries) {
  if (entries.length > 1) {
    const seen = new Set();
    for (const [i, e] of entries.entries()) {
      if (!isNonNegInt(e.seq)) raiseInvalidArgument(`entries[${i}].seq required (int >= 0) for multi-entry replay; got ${JSON.stringify(e.seq)}`);
      if (seen.has(e.seq)) raiseInvalidArgument(`duplicate entries[].seq=${e.seq} (canvas seq is unique per (canvas_id,seq))`);
      seen.add(e.seq);
    }
  }
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.seq === undefined ? 0 : a.e.seq) - (b.e.seq === undefined ? 0 : b.e.seq) || a.i - b.i)
    .map((x) => x.e);
}

/* ── 桶校验 / 派生 ─────────────────────────────────────────────────── */
function checkBucketMarker(marker, opKindLabel) {
  if (marker === undefined || marker === null) return undefined;
  if (marker === BUCKET.REJECT409) {
    raiseReject(`payload.bucket='${marker}' — reject bucket never enters the log (design 26 §2.3)`);
  }
  if (!LOGGED_BUCKETS.includes(marker)) {
    raiseReject(`unknown payload.bucket '${String(marker)}' in ${opKindLabel} — only lww/merge/append may be logged`);
  }
  return marker;
}

/* ── LWW 节点应用（字段合并窗） ────────────────────────────────────── */
function effectiveDomains(kind, fields) {
  if (Array.isArray(fields) && fields.length > 0) {
    for (const f of fields) {
      if (!NODE_DOMAINS.includes(f)) raiseInvalidLog(`unknown node domain in fields: ${f}`);
    }
    return fields;
  }
  if (kind === 'node.move') return ['position'];
  if (kind === 'node.resize') return ['size'];
  return NODE_DOMAINS; // node.update 全行覆写语义（fields 缺省/null/空数组）
}

function applyNodeLww(nodeMap, kind, fields, op) {
  const row = extractNodeRow(op);
  const nodeId = row.nodeId;
  const domains = effectiveDomains(kind, fields);
  const base = nodeMap.get(nodeId);

  if (!base) {
    // 快照缺该节点（正常日志不会发生 —— node.create 属 reject 桶）→ 整行照录兜底。
    const fresh = {};
    for (const k of NODE_ROW_KEYS) if (hasOwn(row, k)) fresh[k] = cloneDeep(row[k]);
    nodeMap.set(nodeId, fresh);
    return;
  }

  const next = { ...base };
  for (const d of domains) {
    if (!hasOwn(row, d)) continue; // 行未携带该域 → 无操作（保留现值）
    next[d] = cloneDeep(row[d]);
  }
  nodeMap.set(nodeId, next);
}

/* ── merge 边应用（键并集 / 幂等删除） ─────────────────────────────── */
function applyEdgeUpsert(edgeMap, op) {
  const row = extractEdgeRow(op);
  edgeMap.set(row.edgeId, cloneDeep(row));
}
function applyEdgeDelete(edgeMap, edgeId) {
  if (edgeMap.delete(edgeId) === false) return; // 幂等：键不存在 = 无操作
}

/* ── 单 op 执行 ────────────────────────────────────────────────────── */
function applyOp(op, bucketMarker, nodeMap, edgeMap, where) {
  if (!isPlainObject(op)) raiseInvalidLog(`${where}: ops item must be a plain object`);
  const opName = op.op;
  const kind = op.kind;
  if (!isNonEmptyString(opName)) raiseInvalidLog(`${where}: op entry missing op name`);
  if (!isNonEmptyString(kind)) raiseInvalidLog(`${where}: op entry missing kind`);

  // append 前缀类：视图忽略（不改图结构）。
  if (isAppendKind(kind)) return;

  // reject-409 拓扑 kind 永不入 log —— 日志出现即违背投影不变量。
  if (kind === 'node.create' || kind === 'node.delete') {
    raiseReject(`${where}: kind '${kind}' is reject-409 — reject bucket never enters the log`);
  }

  const allowed = OP_KIND_ALLOW[opName];
  if (!allowed) raiseInvalidLog(`${where}: unknown op '${opName}'`);
  if (!allowed.includes(kind)) {
    raiseInvalidLog(`${where}: op '${opName}' does not allow kind '${kind}' (allowed: ${allowed.join(', ')})`);
  }
  const bucket = KIND_BUCKET[kind];
  if (!bucket) raiseInvalidLog(`${where}: kind '${kind}' has no projection bucket`);
  if (bucketMarker !== undefined && bucketMarker !== bucket) {
    raiseInvalidLog(`${where}: payload.bucket '${bucketMarker}' mismatches op kind '${kind}' bucket '${bucket}'`);
  }

  if (bucket === BUCKET.LWW) {
    if (kind === 'canvas.viewport.update') return; // 图视图无 viewport 域 → 忽略
    applyNodeLww(nodeMap, kind, op.fields, op);
    return;
  }
  if (bucket === BUCKET.MERGE) {
    if (kind === 'edge.create') { applyEdgeUpsert(edgeMap, op); return; }
    if (kind === 'edge.delete') {
      const edgeId = isNonEmptyString(op.edgeId) ? op.edgeId : (isPlainObject(op.edge) && isNonEmptyString(op.edge.edgeId) ? op.edge.edgeId : null);
      if (!edgeId) raiseInvalidLog(`${where}: deleteEdge op missing edgeId`);
      applyEdgeDelete(edgeMap, edgeId);
      return;
    }
  }
  // kind==='edge.delete' 以外的 merge kind 不可达（OP_KIND_ALLOW 已限），防御兜底。
  raiseInvalidLog(`${where}: unhandled projection op kind '${kind}'`);
}

/* ── 单 entry 执行 ─────────────────────────────────────────────────── */
function applyEntry(entry, nodeMap, edgeMap, where) {
  const type = resolveAliased(entry, TYPE_ALIASES, 'command_type', true);
  if (!isNonEmptyString(type)) raiseInvalidLog(`${where}: command_type must be a non-empty string`);

  // append 前缀类型（presence./comment./...）→ 图视图忽略（payload 可缺省/任意）。
  if (isAppendKind(type)) return;

  // 本日志域只允许 canvas.patch 行；任何其它类型（未知 ⇒ 契约保守 reject-409）
  // 都不可能来自合法 canvas 写入链。
  if (type !== 'canvas.patch') {
    raiseReject(`${where}: command_type '${type}' cannot be replayed — only 'canvas.patch' (lww/merge/append) is logged; reject/unknown types never enter the log`);
  }

  const payload = entry.payload;
  if (payload === undefined || payload === null) return; // 无 ops 元数据行 → 零投影效果
  if (!isPlainObject(payload)) raiseInvalidLog(`${where}: payload must be a plain object (got ${typeof payload})`);

  // command_id 双键歧义守卫（值本身投影不消费；幂等由 (canvas_id,command_id) 在存储层保证）。
  const cmdIdKeys = CMD_ID_ALIASES.filter((k) => hasOwn(entry, k));
  if (cmdIdKeys.length > 1) {
    const vals = new Set(cmdIdKeys.map((k) => entry[k]));
    if (vals.size > 1) raiseInvalidLog(`${where}: conflicting command_id across ${cmdIdKeys.join('/')}`);
  }

  const bucketMarker = checkBucketMarker(payload.bucket, `${where} (command_type ${type})`);
  if (payload.ops === undefined) return;
  if (!Array.isArray(payload.ops)) {
    raiseInvalidLog(`${where}: payload.ops must be an array of op entries (got ${Array.isArray(payload.ops) ? 'array' : typeof payload.ops})`
      + ' — legacy count-only rows are not replayable; rebuild cursor must start after Phase-3 snapshot');
  }
  for (const [j, op] of payload.ops.entries()) {
    applyOp(op, bucketMarker, nodeMap, edgeMap, `${where}.ops[${j}]`);
  }
}

/* ── 主入口 ────────────────────────────────────────────────────────── */
/**
 * 按命令日志重放重建画布图投影（纯函数）。
 * @param {{current?:{nodes:Array,edges:Array}, entries:Array}} input
 *   current —— 重建基线投影（Phase-3 快照的 {nodes,edges}；缺省=空画布）。
 *   entries —— canvas_command_log 行数组，每行 {command_id?, command_type|type|commandType,
 *              seq?, payload?}（支持 listAfter fromRow 的 camelCase 与 DB 原行 snake_case）。
 *              seq 多行时必填且唯一；无序输入先按 seq 升序稳定排序再重放。
 * @returns {{nodes:Array, edges:Array}} 全新对象树，入参零别名、零突变。
 * @throws Error（.code = ERROR_CODES.*）—— 入参形状 / 日志内容 / reject 入 log。
 */
function applyLogToProjection({ current, entries } = {}) {
  if (entries === undefined || entries === null) raiseInvalidArgument('entries (array) is required');
  if (!Array.isArray(entries)) raiseInvalidArgument('entries must be an array');

  const { nodeMap, edgeMap } = ingestGraph(current === undefined ? {} : current);

  const ordered = sortEntries(entries);
  for (const [i, entry] of ordered.entries()) {
    if (!isPlainObject(entry)) raiseInvalidArgument(`entries[${i}] must be a plain object`);
    applyEntry(entry, nodeMap, edgeMap, `entries[${i}]`);
  }

  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

module.exports = {
  applyLogToProjection,
  BUCKET,
  LOGGED_BUCKETS,
  ERROR_CODES,
};
