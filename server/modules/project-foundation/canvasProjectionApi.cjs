'use strict';
/**
 * G22 Phase-4 — canvas 投影读重建面（projection read + baseline guard 叶，未挂载 server.js）。
 * =============================================================================
 * GET /api/v2/projects/:id/studio/canvas/projection?afterSeq=
 *   返回 { ok, nodes, edges, seq, revision, rebuiltFrom, passthrough }
 *
 * 语义（裁决，见任务）:
 *   - afterSeq 缺省 → 0（从头全重建: 快照 current + listAfter(0) 全量重放）。
 *   - afterSeq = 当前 log max → 快照透传（零重建优化: 无 delta 条目, 直接回快照,
 *     响应带 passthrough:true 注明）。
 *   - seq = 一致窗口内取到的 log max seq（供消费方作下次增量游标）；revision =
 *     一致窗口内取到的画布 revision；rebuiltFrom = 本请求使用的 afterSeq。
 *
 * 基线守卫（快照 revision 与日志关系）:
 *   - 整画布 CAS 写（reject-409 桶）在命令日志里只有计数摘要(payload.ops 为对象非
 *     数组)，其投影效果仅落于物化表(studio_canvas_nodes/edges) —— 不可重放。若
 *     「快照读」与「log max 读」不在同一一致点，介于其间提交的 CAS 写会撕裂读：
 *     快照缺其节点改动、日志又只有不可重放的计数行 → 投影永久落后且 seq 游标已越过。
 *   - 故基线守卫必须把「log max seq」与「nodes/edges 快照」放进同一个 MVCC 快照。
 *     实现: 单事务 REPEATABLE READ —— BEGIN 后连读 canvas(revision) + log max seq +
 *     nodes + edges 四读（其中「log max seq」与「nodes/edges」即任务所谓「两读」），
 *     REPEATABLE READ 使整事务读到同一份快照 → 一致窗口。listAfter(delta) 在窗口外
 *     另行读取，再按 seq <= 窗口 logMax 过滤（丢弃窗口后新 append），保证响应 seq 与
 *     nodes/edges 严格对齐窗口。
 *   - ⚠️ 不做「logMaxSeq >= revision - 1」之类的数值断言: canvas_command_log 的 seq
 *     是跨画布共享的 BIGSERIAL + ON CONFLICT DO NOTHING 也消费 nextval(留洞), 且
 *     recordCanvasPatch 为 warn-only(失败不留行) —— seq 既非计数也非连续, 数值关系
 *     不可断言。守卫 = 一致窗口(读一致性), 而非数值不变量。
 *
 * 鉴权边界（本叶【不做鉴权】, 与 canvasCommandLogApi 同契约）:
 *   - 登录 + 项目成员判定由挂载点负责; 本叶只收注入的 projectId。
 *   - 双钩子注入 createCanvasProjectionApi({ pg, authProject?, sendJSON?,
 *     commandLogStore? })：
 *       · pg 必填 —— 带 .query() 的对象。若同时带 .connect()(真实 Pool)则基线守卫
 *         走 REPEATABLE READ 事务(一致窗口); 否则回落顺序读(README 注明: 无跨语句
 *         隔离, 建议挂载点注入真实 Pool 以获得完整守卫)。
 *       · authProject?(req, projectId) 可选, 语义与 canvasCommandLogApi 完全一致。
 *       · commandLogStore? 可选 —— 注入共享 store(需含 listAfter); 未注入则用同一
 *         pg 自建(与 studioCanvasPersistence 同哲学)。
 *   - 路由参数注入契约: handle(req, res, params), params.projectId 必填非空 string。
 *
 * 错误约定:
 *   - 入参非法 400(PROJECT_ID_REQUIRED / INVALID_AFTERSEQ)；非 GET 405；
 *     authProject 裁决失败按钩子 status；DB 错误原样上抛(基建故障, 由调用方 5xx)。
 *   - 项目无主画布 → 200 { ok:true, nodes:[], edges:[], seq:0, revision:null }(读路径
 *     不 404, 与 persistence.handleGet 空画布约定一致)。
 *
 * 投影执行器: 复用 studioCanvasPersistence.rebuildProjection(纯函数, 已导出)。它是
 *   「快照 + 日志」的宽容重放器: 跳过 reject-409 计数行(效果已在快照)、应用 lww
 *   (node.update data) 与 merge(edge create/delete)。真实写链日志同时含三类行(CAS
 *   计数 / lww op 数组 / merge op 数组), 故不可用 canvasProjection.applyLogToProjection
 *   (其对计数行抛 ERR_INVALID_LOG —— 那是对「Phase-3 边界后的纯可重放段」的严格版)。
 */
const { createCommandLogStore } = require('../collaboration/commandLogStore.cjs');
const { rebuildProjection } = require('./studioCanvasPersistence.cjs');

const CANVAS_SQL = `SELECT id, revision, schema_version FROM studio_canvases
  WHERE project_id = $1 AND is_primary = TRUE AND archived_at IS NULL
  ORDER BY created_at ASC LIMIT 1`;
const LOG_MAX_SQL = `SELECT COALESCE(MAX(seq), 0)::bigint AS seq
  FROM canvas_command_log WHERE canvas_id = $1`;
const NODES_SQL = `SELECT * FROM studio_canvas_nodes
  WHERE canvas_id = $1 ORDER BY created_at ASC, node_id ASC`;
const EDGES_SQL = `SELECT * FROM studio_canvas_edges
  WHERE canvas_id = $1 ORDER BY created_at ASC, edge_id ASC`;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/* ── jsonb / bigint 归一 ─────────────────────────────────────────── */
function parseJsonb(v) {
  if (v === null || v === undefined) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return {}; } }
  return typeof v === 'object' ? v : {};
}
/** 对齐 studioCanvasPersistence.formatNode 的 wire 行形状。 */
function formatNodeRow(r) {
  return {
    nodeId: r.node_id,
    nodeType: r.node_type,
    nodeSchemaVersion: r.node_schema_version,
    position: { x: Number(r.position_x), y: Number(r.position_y) },
    size: { width: r.width == null ? null : Number(r.width), height: r.height == null ? null : Number(r.height) },
    zIndex: r.z_index == null ? null : r.z_index,
    data: parseJsonb(r.data_json),
  };
}
function formatEdgeRow(r) {
  return {
    edgeId: r.edge_id,
    sourceNodeId: r.source_node_id,
    sourceHandle: r.source_handle,
    targetNodeId: r.target_node_id,
    targetHandle: r.target_handle,
    edgeType: r.edge_type,
    data: parseJsonb(r.data_json),
  };
}
/** node-pg 把 BIGINT(int8) 读回为字符串 —— Number() 归一。 */
function toSeqNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/* ── query 参数解析 ──────────────────────────────────────────────── */
function firstScalar(v) {
  if (Array.isArray(v)) return v.length > 0 ? v[0] : undefined;
  return v;
}
/** afterSeq：缺省/空 → 0；仅接受十进制无符号整数（string|number），精度不超 MAX_SAFE。 */
function parseAfterSeq(raw) {
  const v = firstScalar(raw);
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    return { ok: true, value: 0 };
  }
  const s = typeof v === 'string' ? v.trim() : v;
  if (typeof s === 'number') {
    if (!Number.isInteger(s) || s < 0 || s > MAX_SAFE) return { ok: false, error: 'INVALID_AFTERSEQ' };
    return { ok: true, value: s };
  }
  if (typeof s !== 'string' || !/^(0|[1-9]\d*)$/.test(s)) return { ok: false, error: 'INVALID_AFTERSEQ' };
  const n = Number(s);
  if (n > MAX_SAFE) return { ok: false, error: 'INVALID_AFTERSEQ' };
  return { ok: true, value: n };
}

function getQuery(req) {
  if (req && req.query && isPlainObject(req.query)) return req.query;
  const url = req && req.url;
  if (typeof url === 'string' && url.includes('?')) {
    try { return Object.fromEntries(new URL(url, 'http://local').searchParams); } catch (_) { /* fallthrough */ }
  }
  return {};
}

/* ── 读原语（对 db 抽象 = Pool 或 Client 或假 pg 的 query） ─────── */
async function resolveCanvas(db, projectId) {
  const r = await db.query(CANVAS_SQL, [projectId]);
  const row = r && r.rows && r.rows[0];
  return row && isNonEmptyString(row.id) ? row : null;
}
async function readLogMax(db, canvasId) {
  const r = await db.query(LOG_MAX_SQL, [canvasId]);
  const row = r && r.rows && r.rows[0];
  return toSeqNum(row && row.seq);
}
async function readNodes(db, canvasId) {
  const r = await db.query(NODES_SQL, [canvasId]);
  return ((r && r.rows) || []).map(formatNodeRow);
}
async function readEdges(db, canvasId) {
  const r = await db.query(EDGES_SQL, [canvasId]);
  return ((r && r.rows) || []).map(formatEdgeRow);
}

/**
 * 创建 canvas 投影读 API。
 * @param {{ pg:{query:Function, connect?:Function}, authProject?:null|Function,
 *           sendJSON?:Function, commandLogStore?:{listAfter:Function} }} deps
 */
function createCanvasProjectionApi(deps = {}) {
  const { pg } = deps;
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createCanvasProjectionApi: { pg } with query() required');
  }
  const authProject = typeof deps.authProject === 'function' ? deps.authProject : null;
  const sendJSON = typeof deps.sendJSON === 'function'
    ? deps.sendJSON
    : (res, status, body) => {
        if (res && typeof res.writeHead === 'function' && typeof res.end === 'function') {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        } else if (res) {
          res.status = status;
          res.body = body;
        }
      };
  const commandLog =
    deps.commandLogStore && typeof deps.commandLogStore.listAfter === 'function'
      ? deps.commandLogStore
      : createCommandLogStore({ pg });

  /** 基线守卫：单事务 REPEATABLE READ 一致窗口（log max seq + nodes/edges + revision）。 */
  async function withConsistentWindow(fn) {
    if (pg && typeof pg.connect === 'function') {
      const client = await pg.connect();
      let done = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          const out = await fn(client);
          await client.query('COMMIT');
          done = true;
          return out;
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw e;
        }
      } finally {
        if (!done) { try { await client.query('ROLLBACK'); } catch (_) {} }
        if (typeof client.release === 'function') client.release();
      }
    }
    // 回落：无事务（无跨语句隔离）。顺序读仍保证「快照先、log max 后」+ delta 按
    // seq<=logMax 过滤, 使重放自洽; 但介于其间的 CAS 写不可被一致窗口完全防住 ——
    // 挂载点应注入带 .connect() 的真实 Pool 以获得完整守卫。
    return fn(pg);
  }

  async function handle(req, res, params) {
    const projectId =
      params && typeof params.projectId === 'string' ? params.projectId.trim() : '';
    if (!projectId) {
      return sendJSON(res, 400, { ok: false, error: 'PROJECT_ID_REQUIRED', message: 'projectId 必须由调用方注入 params' });
    }
    if (!req || req.method !== 'GET') {
      return sendJSON(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    }
    if (authProject) {
      let verdict;
      try {
        verdict = await authProject(req, projectId);
      } catch (_) {
        return sendJSON(res, 500, { ok: false, error: '服务内部错误' });
      }
      const denied = verdict === false || (isPlainObject(verdict) && verdict.ok === false);
      if (denied) {
        const detail = isPlainObject(verdict) ? verdict : {};
        return sendJSON(res, Number.isInteger(detail.status) ? detail.status : 403, {
          ok: false,
          error: typeof detail.error === 'string' && detail.error.length > 0 ? detail.error : 'FORBIDDEN',
        });
      }
    }

    const q = getQuery(req);
    const after = parseAfterSeq(q.afterSeq);
    if (!after.ok) return sendJSON(res, 400, { ok: false, error: after.error });

    // 基线守卫：一致窗口四读（canvas revision + log max seq + nodes + edges）。
    const window = await withConsistentWindow(async (db) => {
      const canvas = await resolveCanvas(db, projectId);
      if (!canvas) return { canvas: null };
      const logMaxSeq = await readLogMax(db, canvas.id);
      const nodes = await readNodes(db, canvas.id);
      const edges = await readEdges(db, canvas.id);
      return { canvas, logMaxSeq, nodes, edges };
    });

    if (!window.canvas) {
      return sendJSON(res, 200, { ok: true, nodes: [], edges: [], seq: 0, revision: null, rebuiltFrom: after.value, passthrough: true });
    }

    // delta 读（窗口外, 按 seq<=logMaxSeq 过滤, 丢弃窗口后新 append）。
    const { commands } = await commandLog.listAfter({ canvasId: window.canvas.id, seq: after.value });
    const delta = (Array.isArray(commands) ? commands : []).filter((c) => c.seq <= window.logMaxSeq);

    const passthrough = delta.length === 0;
    const projection = passthrough
      ? { nodes: window.nodes, edges: window.edges }
      : rebuildProjection({ current: { nodes: window.nodes, edges: window.edges }, logEntries: delta });

    return sendJSON(res, 200, {
      ok: true,
      nodes: projection.nodes,
      edges: projection.edges,
      seq: window.logMaxSeq,
      revision: Number(window.canvas.revision),
      rebuiltFrom: after.value,
      passthrough,
    });
  }

  return {
    handle,
    parseAfterSeq,
    SQL: { CANVAS_SQL, LOG_MAX_SQL, NODES_SQL, EDGES_SQL },
  };
}

module.exports = { createCanvasProjectionApi };
