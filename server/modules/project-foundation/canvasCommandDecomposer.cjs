'use strict';
/**
 * G22 CAS 拆解① — canvas.patch → 按 kind 归桶的纯函数拆解器（叶 2）。
 * =====================================================================
 * 依据 docs/product-v2/26-canvas-cas-per-kind-design.md §1.4/§2.3/§5 叶2 与
 * server/modules/studio-contracts/collabContract.cjs 的 CONFLICT_POLICY_BY_KIND
 * （词表对齐单一真源：本模块不复制策略表，运行时经 conflictPolicyFor() 反查；
 * 模块加载时以不变量校验 KIND_BUCKET_BY_COMMAND 与契约无漂移）。
 *
 * 输入域：legacy PATCH 载荷（docs/product-v2/18-collaboration-g22-audit.md L30 的
 * 实际线报文 `{ upsertNodes, deleteNodeIds, upsertEdges, deleteEdgeIds, viewport }`）
 * 或其 `{ ops:{ ... } }` 包装（叶1/叶3 命令日志 payload 形状）。
 *
 * 输出：{ ok, errors?, buckets:{ reject409, lww, merge, append }, summary, warnings }
 *   每个 op 恰好归入一个桶，附 kind（35 词表内值）+ 理由码 REASONS，供叶1 逐 kind
 *   子命令写日志（type=kind 可直接查 CONFLICT_POLICY_BY_KIND）与叶3 同事务分组执行。
 *
 * ── 归桶规则（对齐 26 §2.3 执行矩阵 + collabContract L141-180）────────────
 *   reject409  structural 拓扑建删/整图替换 —— 保留整画布 CAS 门：
 *     · upsertNodes 中 nodeId 不存在于 ctx 基线 → kind 'node.create'
 *     · deleteNodeIds                            → kind 'node.delete'
 *     · loadGraph 整图替换(快照级结构变更, 词表无 canvas.replace 类, kind=null)
 *   lww        last-write-wins 参数/几何 patch —— 无 CAS，按实体 key LWW：
 *     · upsertNodes 中 nodeId 已存在于 ctx 基线 → 按变更域细分 kind
 *       'node.move'(仅 position 变) / 'node.resize'(仅 size 变) /
 *       'node.update'(data/其它/多域变 —— 整行覆写语义, 携带 fields=变更域清单)
 *     · viewport                                → kind 'canvas.viewport.update'
 *   merge      列表/边元素级操作 —— 无 CAS，按元素独立主键并集/覆写：
 *     · upsertEdges                             → kind 'edge.create'
 *       （词表无 edge.update：边行 upsert = 元素键上的 create-or-replace，
 *         merge 投影按 edge_id 独立主键应用，新边 EDGE_CREATE_NEW_ID、
 *         已知边覆写 EDGE_UPSERT_OVERWRITE 均为同一执行语义）
 *     · deleteEdgeIds                           → kind 'edge.delete'
 *   append     本拆解器永不产出（canvas PATCH 词表无 presence./comment./annotation.
 *              —— append 前缀种类经 isAppendKind 属 G22 预留，非本输入域）。
 *
 * ── 新节点 vs 更新节点的判据 ─────────────────────────────────────────────
 *   legacy 载荷本身无 isNew 标记（src/features/studio-v2/persistence.ts
 *   serializeStudioNode 对新建/移动/改参一律全量 upsert），故 create-vs-update
 *   必须对照「baseRevision 时刻的画布投影」判定 —— 纯函数不碰 DB，由调用方(叶3
 *   handlePatch 改造)把投影节点/边作为 ctx 传入。三态语义：
 *     · ctx 提供 existingNodes/existingNodeIds（可为空数组 = 画布确实为空）
 *       → nodeId 不在其中 ⇒ node.create（reject409，拓扑门）；
 *         nodeId 在其中    ⇒ 按变更域细分 node.move/resize/update（lww）。
 *     · ctx 完全不提供基线（undefined）→ 无法证明无拓扑变更，保守归
 *       'node.update'(lww) 并在 warnings 声明「无法区分新建」——叶3 接线必须传
 *       ctx，禁止依赖该默认分支做最终归类。
 *
 * 输出 per-op 字段：{ op, kind, nodeId|edgeId?, fields?, reason, policy }
 *   op = 'upsertNode'|'deleteNode'|'upsertEdge'|'deleteEdge'|'viewport'|'loadGraph'
 *   （追踪源数组），kind ∈ COMMAND_TYPES ∪ {null}，policy = 契约策略名。
 */

const { conflictPolicyFor } = require('../studio-contracts/collabContract.cjs');

/* ── 桶/策略命名对齐（契约 policy 名 ↔ 桶名） ─────────────────────── */
const BUCKET_BY_POLICY = Object.freeze({
  'reject-409': 'reject409',
  'last-write-wins': 'lww',
  'merge': 'merge',
  'append': 'append',
});
const BUCKET_KEYS = Object.freeze(['reject409', 'lww', 'merge', 'append']);

/** 理由码（每 op 归桶的审计依据；英文常量便于日志/测试断言）。 */
const REASONS = Object.freeze({
  NODE_CREATE_NEW_ID: 'NODE_CREATE_NEW_ID',       // 新节点 → 拓扑建，reject-409
  NODE_DELETE_STRUCTURAL: 'NODE_DELETE_STRUCTURAL', // 删节点 → 拓扑删，reject-409
  NODE_MOVE_POSITION_ONLY: 'NODE_MOVE_POSITION_ONLY', // 仅 position 变 → node.move
  NODE_RESIZE_SIZE_ONLY: 'NODE_RESIZE_SIZE_ONLY',   // 仅 size 变 → node.resize
  NODE_UPDATE_DATA_ONLY: 'NODE_UPDATE_DATA_ONLY',   // 仅 data 变 → node.update
  NODE_UPDATE_MULTI_DOMAIN: 'NODE_UPDATE_MULTI_DOMAIN', // 多域/整行覆写 → node.update
  NODE_UPDATE_NO_BASELINE: 'NODE_UPDATE_NO_BASELINE', // 无 ctx 基线默认分支（warn）
  EDGE_CREATE_NEW_ID: 'EDGE_CREATE_NEW_ID',         // 新边 → merge
  EDGE_UPSERT_OVERWRITE: 'EDGE_UPSERT_OVERWRITE',   // 已知边覆写（词表无 edge.update）
  EDGE_UPSERT_NO_BASELINE: 'EDGE_UPSERT_NO_BASELINE', // 无边基线时的 upsert
  EDGE_DELETE_ELEMENT: 'EDGE_DELETE_ELEMENT',       // 删边 → merge 元素删除
  VIEWPORT_PARAM_UPDATE: 'VIEWPORT_PARAM_UPDATE',   // viewport → canvas.viewport.update
  LOAD_GRAPH_STRUCTURAL_REPLACE: 'LOAD_GRAPH_STRUCTURAL_REPLACE', // 整图替换 → reject-409
});

/* ── 输入键 schema（canonical + legacy 别名；未知键拒） ───────────── */
const CANONICAL_OP_KEYS = Object.freeze([
  'upsertNodes', 'deleteNodeIds', 'upsertEdges', 'deleteEdgeIds', 'viewport', 'loadGraph',
]);
/** 别名：任务域俗称 deleteNodes/deleteEdges ↔ 线报文 canonical deleteNodeIds/deleteEdgeIds。 */
const OP_KEY_ALIASES = Object.freeze({
  deleteNodes: 'deleteNodeIds',
  deleteEdges: 'deleteEdgeIds',
});
const WRAPPER_TOP_KEYS = Object.freeze(['ops', 'baseRevision', 'clientMutationId']);
const FLAT_TOP_KEYS = Object.freeze([...CANONICAL_OP_KEYS, ...Object.keys(OP_KEY_ALIASES), 'baseRevision', 'clientMutationId']);
const CTX_KEYS = Object.freeze(['existingNodes', 'existingEdges', 'existingNodeIds', 'existingEdgeIds']);

/* ── 工具 ─────────────────────────────────────────────────────────── */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** 递归按键排序的稳定序列化 —— 对象键序无关的深比较。 */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
const jsonEqual = (a, b) => stableStringify(a) === stableStringify(b);
const normNumOrNull = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
const normZ = (v) => (v === undefined || v === null ? null : Number(v));
/** size 读取：支持 {size:{width,height}} 与顶层 width/height（server normalizeNode 兼容）。 */
function sizePair(row) {
  if (!row || typeof row !== 'object') return [null, null];
  const s = row.size && typeof row.size === 'object' ? row.size : {};
  return [normNumOrNull(s.width === undefined ? row.width : s.width),
    normNumOrNull(s.height === undefined ? row.height : s.height)];
}
function positionPair(row) {
  const p = row && row.position && typeof row.position === 'object' ? row.position : {};
  const x = normNumOrNull(p.x); const y = normNumOrNull(p.y);
  return [x, y];
}

/** 归一 ctx → { nodeRows:Map, nodeIds:Set|null, edgeRows:Map, edgeIds:Set|null }
 *  `existingNodeIds`/`existingNodeIds=[]` 显式提供 ⇒ 基线存在（可为空画布）；
 *  完全不提供任何 existing* ⇒ baseline=false（无法判别新建）。 */
function normalizeCtx(ctx) {
  const out = { nodeRows: new Map(), nodeIds: null, edgeRows: new Map(), edgeIds: null };
  if (ctx === undefined || ctx === null) return out;
  if (!isPlainObject(ctx)) throw new TypeError('ctx must be a plain object');
  for (const k of Object.keys(ctx)) {
    if (!CTX_KEYS.includes(k)) throw new TypeError(`ctx has unknown key: ${k}`);
  }
  if (ctx.existingNodes !== undefined || ctx.existingNodeIds !== undefined) {
    out.nodeIds = new Set();
    if (ctx.existingNodes !== undefined) {
      if (Array.isArray(ctx.existingNodes)) {
        for (const n of ctx.existingNodes) {
          const id = isPlainObject(n) && n.nodeId !== undefined ? String(n.nodeId) : n;
          if (id === undefined || id === null) throw new TypeError('existingNodes item must carry nodeId');
          out.nodeRows.set(id, isPlainObject(n) ? n : null);
          out.nodeIds.add(id);
        }
      } else if (ctx.existingNodes instanceof Map || isPlainObject(ctx.existingNodes)) {
        for (const [id, row] of (ctx.existingNodes instanceof Map ? ctx.existingNodes : Object.entries(ctx.existingNodes))) {
          out.nodeRows.set(String(id), isPlainObject(row) ? row : null);
          out.nodeIds.add(String(id));
        }
      } else {
        throw new TypeError('existingNodes must be an array, Map, or plain object keyed by nodeId');
      }
    }
    if (ctx.existingNodeIds !== undefined) {
      if (!Array.isArray(ctx.existingNodeIds) && !(ctx.existingNodeIds instanceof Set)) {
        throw new TypeError('existingNodeIds must be an array or Set');
      }
      for (const id of ctx.existingNodeIds) out.nodeIds.add(String(id));
    }
  }
  if (ctx.existingEdges !== undefined || ctx.existingEdgeIds !== undefined) {
    out.edgeIds = new Set();
    if (ctx.existingEdges !== undefined) {
      const src = Array.isArray(ctx.existingEdges)
        ? ctx.existingEdges
        : (ctx.existingEdges instanceof Map ? [...ctx.existingEdges.values()] : Object.values(ctx.existingEdges));
      for (const e of src) {
        const id = isPlainObject(e) && e.edgeId !== undefined ? String(e.edgeId) : e;
        if (id === undefined || id === null) throw new TypeError('existingEdges item must carry edgeId');
        out.edgeRows.set(String(id), isPlainObject(e) ? e : null);
        out.edgeIds.add(String(id));
      }
    }
    if (ctx.existingEdgeIds !== undefined) {
      if (!Array.isArray(ctx.existingEdgeIds) && !(ctx.existingEdgeIds instanceof Set)) {
        throw new TypeError('existingEdgeIds must be an array or Set');
      }
      for (const id of ctx.existingEdgeIds) out.edgeIds.add(String(id));
    }
  }
  return out;
}

/* ── 35 词表子集 → 桶映射（导出物；doc 注释见下） ─────────────────────
 * canvas.patch 拆解器可产出的 kind 全集（COMMAND_TYPES 35 种子集）。
 * 桶名对齐 decomposeCanvasPatch 输出；policy 与 CONFLICT_POLICY_BY_KIND 同源。
 *   node.create / node.delete          → reject409  拓扑建删，整画布 CAS 门
 *   canvas.viewport.update / node.move / node.resize / node.update → lww 参数/几何
 *   edge.create / edge.delete          → merge      边元素独立主键并集
 * 词表与契约映射在模块加载时经 conflictPolicyFor() 反查校验，漂移即抛错。
 */
const HANDLED_KINDS = Object.freeze([
  'canvas.viewport.update',
  'node.create', 'node.move', 'node.resize', 'node.update', 'node.delete',
  'edge.create', 'edge.delete',
]);
const KIND_BUCKET_BY_COMMAND = Object.freeze(
  HANDLED_KINDS.reduce((acc, k) => {
    const policy = conflictPolicyFor(k);
    const bucket = BUCKET_BY_POLICY[policy];
    if (!bucket) {
      throw new Error(`[canvasCommandDecomposer] kind ${k}: contract policy ${policy} has no bucket alias`);
    }
    if (policy === 'reject-409' && !['node.create', 'node.delete'].includes(k)) {
      throw new Error(`[canvasCommandDecomposer] contract drift: ${k} resolved reject-409, only node.create/node.delete expected`);
    }
    acc[k] = bucket;
    return acc;
  }, {})
);

const EMPTY_BUCKETS = () => ({ reject409: [], lww: [], merge: [], append: [] });

function errResult(errors) { return { ok: false, errors, buckets: EMPTY_BUCKETS(), summary: { total: 0, byBucket: { reject409: 0, lww: 0, merge: 0, append: 0 }, structural: false }, warnings: [] }; }

/* ── 变更域细分（前提：nodeId 已存在于基线） ──────────────────────── */
function changedDomains(prev, next) {
  const d = [];
  if (!jsonEqual(positionPair(prev), positionPair(next))) d.push('position');
  if (!jsonEqual(sizePair(prev), sizePair(next))) d.push('size');
  if (normZ(prev && prev.zIndex) !== normZ(next && next.zIndex)) d.push('zIndex');
  if (!jsonEqual(prev && prev.data, next && next.data)) d.push('data');
  if ((prev && prev.nodeType || '') !== (next && next.nodeType || '')) d.push('nodeType');
  if ((prev && prev.nodeSchemaVersion != null ? Number(prev.nodeSchemaVersion) : 1)
    !== (next && next.nodeSchemaVersion != null ? Number(next.nodeSchemaVersion) : 1)) d.push('nodeSchemaVersion');
  return d;
}

/**
 * 主入口。拆解一个 legacy PATCH 或 { ops } 包装 → 按 kind 归桶。
 * @param {object} input  `{ ops:{ upsertNodes[], deleteNodeIds[], upsertEdges[],
 *   deleteEdgeIds[], viewport?, loadGraph? } }` 或平铺 legacy PATCH body
 *   （键名同 ops 内，另可带 baseRevision/clientMutationId）。未知键 → ok:false。
 * @param {object} [ctx]  画布投影基线（判别新建 vs 更新/覆写）。键白名单：
 *   existingNodes / existingNodeIds / existingEdges / existingEdgeIds
 *   （数组|Set|Map|以 id 为键的普通对象）。显式提供（含空数组）= 画布在该
 *   baseRevision 的完整实体集；完全不提供 = 无基线（见模块头三态语义）。
 * @returns {{ok:boolean, errors?:string[], buckets:object, summary:object, warnings:string[]}}
 */
function decomposeCanvasPatch(input, ctx) {
  if (!isPlainObject(input)) return errResult(['patch must be a plain object']);
  const errors = [];
  const warnings = [];

  /* 1. 顶层解包：{ops} 包装 or 平铺 legacy body。 */
  const hasWrapper = hasOwn(input, 'ops');
  const ops = hasWrapper ? input.ops : input;
  if (hasWrapper && !isPlainObject(ops)) return errResult(['ops must be a plain object']);
  if (hasWrapper) {
    for (const k of Object.keys(input)) {
      if (!WRAPPER_TOP_KEYS.includes(k)) errors.push(`unknown top-level key: ${k} (wrapper allows ${WRAPPER_TOP_KEYS.join(', ')})`);
    }
  } else {
    for (const k of Object.keys(input)) {
      if (!FLAT_TOP_KEYS.includes(k)) errors.push(`unknown top-level key: ${k} (flat body allows ${FLAT_TOP_KEYS.join(', ')})`);
    }
  }

  /* 2. ops 层键校验 + 别名归一（deleteNodes→deleteNodeIds 等），未知键拒。 */
  const seen = new Set();
  for (const k of Object.keys(ops)) {
    if (!hasWrapper && (k === 'baseRevision' || k === 'clientMutationId')) continue; // 平铺模式的顶层元字段
    const canonical = OP_KEY_ALIASES[k] || k;
    if (!CANONICAL_OP_KEYS.includes(canonical)) {
      errors.push(`unknown ops key: ${k}`);
      continue;
    }
    if (seen.has(canonical)) { errors.push(`ambiguous ops keys: ${k} duplicates ${canonical}`); continue; }
    seen.add(canonical);
  }
  const normOps = { ...ops };
  for (const [alias, canonical] of Object.entries(OP_KEY_ALIASES)) {
    if (hasOwn(normOps, alias)) { normOps[canonical] = normOps[alias]; delete normOps[alias]; }
  }

  const upsertNodes = normOps.upsertNodes !== undefined ? normOps.upsertNodes : [];
  const deleteNodeIds = normOps.deleteNodeIds !== undefined ? normOps.deleteNodeIds : [];
  const upsertEdges = normOps.upsertEdges !== undefined ? normOps.upsertEdges : [];
  const deleteEdgeIds = normOps.deleteEdgeIds !== undefined ? normOps.deleteEdgeIds : [];
  const viewport = normOps.viewport;
  const loadGraph = normOps.loadGraph;

  for (const [k, v] of [['upsertNodes', upsertNodes], ['deleteNodeIds', deleteNodeIds], ['upsertEdges', upsertEdges], ['deleteEdgeIds', deleteEdgeIds]]) {
    if (hasOwn(normOps, k) && !Array.isArray(v)) errors.push(`${k} must be an array`);
  }
  if (hasOwn(normOps, 'viewport') && viewport !== undefined && viewport !== null && !isPlainObject(viewport)) {
    errors.push('viewport must be a plain object');
  }
  if (hasOwn(normOps, 'loadGraph') && loadGraph !== true && !isPlainObject(loadGraph)) {
    errors.push('loadGraph must be true or a plain object {nodes?,edges?,viewport?} (whole-graph replace)');
  }
  const viewportGiven = hasOwn(normOps, 'viewport') && isPlainObject(viewport);
  const loadGraphGiven = hasOwn(normOps, 'loadGraph') && (loadGraph === true || isPlainObject(loadGraph));

  /* 3. 空 patch 检测：所有数组空 / 无 viewport / 无 loadGraph。 */
  const anyOp = upsertNodes.length || deleteNodeIds.length || upsertEdges.length || deleteEdgeIds.length || viewportGiven || loadGraphGiven;
  if (!anyOp) errors.push('EMPTY_PATCH: no upsert/delete ops, viewport, or loadGraph present');

  /* 4. 条目级形状：nodeId/edgeId 必须为非空字符串；删除 id 同理。 */
  const seenNodeIds = new Set(); const seenEdgeIds = new Set();
  for (const n of upsertNodes) {
    if (!isPlainObject(n)) { errors.push('upsertNodes item must be an object'); continue; }
    if (!isNonEmptyString(n.nodeId)) errors.push(`upsertNodes item missing nodeId: ${JSON.stringify(n)}`);
    else if (seenNodeIds.has(n.nodeId)) errors.push(`duplicate nodeId in upsertNodes: ${n.nodeId}`);
    else seenNodeIds.add(n.nodeId);
  }
  for (const e of upsertEdges) {
    if (!isPlainObject(e)) { errors.push('upsertEdges item must be an object'); continue; }
    if (!isNonEmptyString(e.edgeId)) errors.push(`upsertEdges item missing edgeId: ${JSON.stringify(e)}`);
    else if (seenEdgeIds.has(e.edgeId)) errors.push(`duplicate edgeId in upsertEdges: ${e.edgeId}`);
    else seenEdgeIds.add(e.edgeId);
  }
  for (const id of deleteNodeIds) if (!isNonEmptyString(id)) errors.push(`deleteNodeIds item must be a non-empty string: ${JSON.stringify(id)}`);
  for (const id of deleteEdgeIds) if (!isNonEmptyString(id)) errors.push(`deleteEdgeIds item must be a non-empty string: ${JSON.stringify(id)}`);
  if (deleteNodeIds.some((id, i) => isNonEmptyString(id) && deleteNodeIds.indexOf(id) !== i)) errors.push('duplicate id in deleteNodeIds');
  if (deleteEdgeIds.some((id, i) => isNonEmptyString(id) && deleteEdgeIds.indexOf(id) !== i)) errors.push('duplicate id in deleteEdgeIds');

  if (errors.length) return errResult(errors);

  /* 5. 基线归一。ctx 抛错（未知键/坏类型）→ 视同校验失败。 */
  let known;
  try { known = normalizeCtx(ctx); }
  catch (e) { return errResult([`invalid ctx: ${e.message}`]); }
  const nodeBaseline = known.nodeIds !== null; // 显式给过 existing* ⇒ 能判别新建
  const edgeBaseline = known.edgeIds !== null;

  /* 6. 逐 op 归桶。 */
  const buckets = EMPTY_BUCKETS();
  const push = (policy, entry) => {
    buckets[BUCKET_BY_POLICY[policy]].push({ ...entry, policy });
  };

  for (const n of upsertNodes) {
    if (!nodeBaseline) {
      push('last-write-wins', { op: 'upsertNode', kind: 'node.update', nodeId: n.nodeId, fields: null, reason: REASONS.NODE_UPDATE_NO_BASELINE });
      warnings.push(`node ${n.nodeId}: no ctx baseline — classified node.update (cannot prove create vs update; wire ctx for leaf-3 grouping)`);
      continue;
    }
    if (!known.nodeIds.has(n.nodeId)) {
      push('reject-409', { op: 'upsertNode', kind: 'node.create', nodeId: n.nodeId, fields: null, reason: REASONS.NODE_CREATE_NEW_ID });
      continue;
    }
    const prev = known.nodeRows.get(n.nodeId) || null;
    const domains = prev ? changedDomains(prev, n) : null;
    if (domains && domains.length === 1 && domains[0] === 'position') {
      push('last-write-wins', { op: 'upsertNode', kind: 'node.move', nodeId: n.nodeId, fields: domains, reason: REASONS.NODE_MOVE_POSITION_ONLY });
    } else if (domains && domains.length === 1 && domains[0] === 'size') {
      push('last-write-wins', { op: 'upsertNode', kind: 'node.resize', nodeId: n.nodeId, fields: domains, reason: REASONS.NODE_RESIZE_SIZE_ONLY });
    } else if (domains && domains.length === 1 && domains[0] === 'data') {
      push('last-write-wins', { op: 'upsertNode', kind: 'node.update', nodeId: n.nodeId, fields: domains, reason: REASONS.NODE_UPDATE_DATA_ONLY });
    } else {
      push('last-write-wins', { op: 'upsertNode', kind: 'node.update', nodeId: n.nodeId, fields: domains || null, reason: domains ? REASONS.NODE_UPDATE_MULTI_DOMAIN : REASONS.NODE_UPDATE_NO_BASELINE });
    }
  }
  for (const id of deleteNodeIds) {
    push('reject-409', { op: 'deleteNode', kind: 'node.delete', nodeId: id, fields: null, reason: REASONS.NODE_DELETE_STRUCTURAL });
  }
  for (const e of upsertEdges) {
    const exists = edgeBaseline && known.edgeIds.has(e.edgeId);
    push('merge', {
      op: 'upsertEdge', kind: 'edge.create', edgeId: e.edgeId, fields: null,
      reason: !edgeBaseline ? REASONS.EDGE_UPSERT_NO_BASELINE : (exists ? REASONS.EDGE_UPSERT_OVERWRITE : REASONS.EDGE_CREATE_NEW_ID),
    });
  }
  for (const id of deleteEdgeIds) {
    push('merge', { op: 'deleteEdge', kind: 'edge.delete', edgeId: id, fields: null, reason: REASONS.EDGE_DELETE_ELEMENT });
  }
  if (viewportGiven) {
    push('last-write-wins', { op: 'viewport', kind: 'canvas.viewport.update', fields: ['x', 'y', 'zoom'].filter((f) => hasOwn(viewport, f)), reason: REASONS.VIEWPORT_PARAM_UPDATE });
  }
  if (loadGraphGiven) {
    push('reject-409', { op: 'loadGraph', kind: null, fields: null, reason: REASONS.LOAD_GRAPH_STRUCTURAL_REPLACE });
  }

  const byBucket = { reject409: buckets.reject409.length, lww: buckets.lww.length, merge: buckets.merge.length, append: buckets.append.length };
  return {
    ok: true,
    buckets,
    warnings,
    summary: { total: byBucket.reject409 + byBucket.lww + byBucket.merge + byBucket.append, byBucket, structural: byBucket.reject409 > 0 },
  };
}

module.exports = {
  decomposeCanvasPatch,
  KIND_BUCKET_BY_COMMAND,
  REASONS,
  BUCKET_BY_POLICY,
  BUCKET_KEYS,
  CANONICAL_OP_KEYS,
  OP_KEY_ALIASES,
};
