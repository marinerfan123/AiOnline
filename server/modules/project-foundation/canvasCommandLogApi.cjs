'use strict';
/**
 * G22-flash — canvas_command_log 只读查询面（命令日志查询 API 叶, 未挂载 server.js）。
 * =============================================================================
 * GET /api/v2/projects/:id/studio/canvas/commands?afterSeq=&limit=&bucket=
 *   返回 { commands: [{ seq, commandId, commandType, createdAtMs, bucket?, summary }],
 *          hasMore }
 *
 * 鉴权边界（本叶【不做鉴权】）:
 *   - 登录 + 项目成员判定由调用方（server.js 挂载点，参照 G24 export 的 membership
 *     门 404-no-leak 写法）负责 —— 本叶只收「已注入的 projectId」。
 *   - 双钩子注入 createCanvasCommandLogApi({ pg, authProject? })：
 *       · pg               必填 —— { query(sql, params) -> Promise<{rows}> }（node-pg
 *                           Pool/Client 或测试假 pg）。
 *       · authProject?(req, projectId)  可选。缺省 null → 【默认放行】（调用方已鉴权时
 *                           不必传）；传入则每次 handle 先 await 该钩子：
 *                           返回 { ok:false, status?, error? } 或 false → 按钩子裁决
 *                           拒绝（status 缺省 403 / error 缺省 'FORBIDDEN'），不再触碰
 *                           DB；返回 { ok:true }/undefined/null/true → 放行；抛错 → 500。
 *   - 路由参数注入契约：handle(req, res, params)，params.projectId 必须为非空 string
 *     （由挂载点从路径 :id 注入 —— 本叶不解析 URL、不回退默认 project）。
 *
 * 查询语义:
 *   - afterSeq（游标，开区间）: 返回 seq > afterSeq 的命令，按 seq 升序（单调）。
 *     缺省/空 → 0（从头）。BIGINT 精度：仅接受十进制无符号整数（string|number），
 *     超 Number.MAX_SAFE_INTEGER → 400（游标不做精度丢失的浮点归一）。
 *   - limit: 1..200（含），缺省 50；越界/非整数/非法 → 400（INVALID_LIMIT）。
 *     hasMore = 本页之后仍有命令（多取 1 行判定）。
 *   - bucket: 可选，值域 BUCKET_KEYS = reject409|lww|merge|append（与
 *     canvasCommandDecomposer/canvasProjection 同源桶名）；非法 → 400（INVALID_BUCKET）。
 *
 * 桶推导（payload 派生，见 deriveBucket —— 画布日志行 type 均为 'canvas.patch'，
 * 桶信息不在列上、在 payload 里）:
 *   · payload.bucket 显式标记 ∈ BUCKET_KEYS        → 该桶（向前兼容，当前写链不写）
 *   · payload.mode === 'kind-scoped-lww'          → lww（Phase-2 直写, ops 数组）
 *   · payload.mode === 'kind-scoped-merge'        → merge（Phase-3 直写, ops 数组）
 *   · ops 为数组 → 逐 op 按 kind 反查桶（KIND_BUCKET_BY_COMMAND 优先，
 *     conflictPolicyFor 兜底）：
 *       - 出现 reject-409 kind（node.create/node.delete…）→ 整行 reject409
 *       - 恰好一种非 reject 桶 → 该桶；混 lww+merge 或全未知 → null（无单一桶）
 *   · ops 为计数对象（整画布 CAS 路径的计数摘要，payload.ops={nodeUpserts:…}）
 *     → reject409（整画布 CAS = 拓扑安全门，design 26 §2.2；Phase-1 遗留行同此归类
 *     —— 这类行只带计数、无逐 op 明细，无法更细拆桶，归类为设计注释过的诚实映射）
 *   · payload 缺省/null/无 ops                      → null（元数据行，不带 bucket 键）
 *   bucket= 过滤只命中「推导结果 === 该桶」的行；桶为 null 的行不落入任何过滤。
 *
 * summary（不含密钥/大 payload —— 只输出 ops 计数 + 实体 id 清单, 上限 50）:
 *   { ops: 总数, counts: { <opName>: n, … }, nodeIds: [], edgeIds: [],
 *     idsTruncated?: true }
 *   · counts 键统一为 op 名空间（upsertNode/deleteNode/upsertEdge/deleteEdge/
 *     viewport/loadGraph）；计数对象行经 COUNT_KEY_TO_OP 映射到同一空间。
 *   · nodeIds/edgeIds 来自逐 op 的 nodeId/edgeId（含 op.node.nodeId / op.edge.edgeId
 *     嵌套），保序去重、两表合计上限 50，截断置 idsTruncated:true。
 *   · 绝不回带 payload/baseRevision/actorId/整行 ops 等原始内容。
 *
 * 读实现:
 *   - 无 bucket 过滤：SQL LIMIT 下推（取 limit+1 行判 hasMore），单查询。
 *   - 有 bucket 过滤：桶推导在 JS（SQL 无法表达 payload.ops 的逐元素 kind 归桶），
 *     按 seq 游标分块（CHUNK=500）拉取直到凑满 limit+1 条命中或日志耗尽 ——
 *     有界内存、无全量尾部扫描；桶过滤必然多扫非命中行，属该语义固有成本。
 *   - canvas_id 解析：projects 的主画布（studio_canvases project_id+is_primary+
 *     archived_at IS NULL）；无主画布 → 空结果 200（画布未建不算错误）。
 *   - 错误约定：入参非法 400（INVALID_AFTERSEQ/INVALID_LIMIT/INVALID_BUCKET/
 *     PROJECT_ID_REQUIRED）；非 GET 405；authProject 裁决失败按钩子 status；
 *     DB 错误原样上抛（基建故障，由调用方决定 5xx 映射）—— 本叶只吞「画布不存在」。
 */
const { KIND_BUCKET_BY_COMMAND, BUCKET_BY_POLICY } = require('./canvasCommandDecomposer.cjs');
const { conflictPolicyFor } = require('../studio-contracts/collabContract.cjs');

const LIMITS = Object.freeze({
  defaultLimit: 50,
  maxLimit: 200,
  maxSummaryIds: 50,
  chunkSize: 500, // 桶过滤分块拉取的行数（有界内存）
});
const BUCKET_KEYS = Object.freeze(['reject409', 'lww', 'merge', 'append']);
const MODE_TO_BUCKET = Object.freeze({
  'kind-scoped-lww': 'lww',
  'kind-scoped-merge': 'merge',
});
/** 计数摘要键 → op 名（整画布 CAS 计数行与逐 op 数组行共用同一 counts 命名空间）。 */
const COUNT_KEY_TO_OP = Object.freeze({
  nodeUpserts: 'upsertNode',
  nodeDeletes: 'deleteNode',
  edgeUpserts: 'upsertEdge',
  edgeDeletes: 'deleteEdge',
});
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const CANVAS_SQL = `SELECT id FROM studio_canvases
 WHERE project_id = $1 AND is_primary = TRUE AND archived_at IS NULL
 ORDER BY created_at ASC LIMIT 1`;
const READ_SQL = `SELECT seq, command_id, type, payload, received_at
  FROM canvas_command_log
 WHERE canvas_id = $1 AND seq > $2
 ORDER BY seq ASC
 LIMIT $3`;

/* ── 工具 ─────────────────────────────────────────────────────────── */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** payload 行值 → JS 值：node-pg 已解析 jsonb；假 pg/字符串兜底反序列化。 */
function parsePayload(v) {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return v; }
  }
  return v === undefined ? null : v;
}

/** received_at (timestamptz) → epoch ms。node-pg 返回 Date；数值/字符串兜底。 */
function toEpochMs(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** node-pg 把 BIGINT(int8) 读回为字符串 —— 一律 Number() 归一。 */
function toSeqNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** kind → 桶（KIND_BUCKET_BY_COMMAND 优先；契约 conflictPolicyFor 兜底，未知保守 reject409）。 */
function bucketOfKind(kind) {
  if (typeof kind !== 'string' || kind.length === 0) return null;
  const direct = KIND_BUCKET_BY_COMMAND[kind];
  if (direct) return direct;
  return BUCKET_BY_POLICY[conflictPolicyFor(kind)] || null;
}

/**
 * 由 payload 推导命令桶（纯函数；null = 无单一/可推导桶，响应省略 bucket 键）。
 * 规则见文件头「桶推导」。
 */
function deriveBucket(payload) {
  if (!isPlainObject(payload)) return null;
  const marker = payload.bucket;
  if (typeof marker === 'string' && BUCKET_KEYS.includes(marker)) return marker;
  const modeBucket = MODE_TO_BUCKET[payload.mode] || null;
  const ops = payload.ops;
  if (Array.isArray(ops)) {
    if (ops.length === 0) return modeBucket;
    const seen = new Set();
    for (const op of ops) {
      const b = bucketOfKind(op && op.kind);
      if (b) seen.add(b);
    }
    if (seen.has('reject409')) return 'reject409';
    if (seen.size === 1) return [...seen][0];
    return null; // 混桶（如 lww+merge）或 op kind 全未知 → 无单一桶可标
  }
  if (isPlainObject(ops)) return 'reject409'; // 计数摘要 = 整画布 CAS（拓扑门）路径
  return null;
}

/** 从 op 条目取实体 id（支持扁平 nodeId/edgeId 与嵌套 op.node/op.edge）。 */
function extractOpId(op, kind) {
  if (!isPlainObject(op)) return null;
  if (kind === 'node') {
    const v = op.nodeId;
    if (isNonEmptyString(v)) return v;
    const nested = op.node;
    return nested && isNonEmptyString(nested.nodeId) ? nested.nodeId : null;
  }
  const v = op.edgeId;
  if (isNonEmptyString(v)) return v;
  const nested = op.edge;
  return nested && isNonEmptyString(nested.edgeId) ? nested.edgeId : null;
}

/**
 * 摘要构建（纯函数）—— 只输出 ops 计数 + 实体 id 清单（上限 LIMITS.maxSummaryIds），
 * 绝不含 payload/baseRevision/原始 ops（防密钥/大载荷泄漏）。
 * @returns {{ops:number, counts:Object, nodeIds:string[], edgeIds:string[],
 *            idsTruncated?:boolean}}
 */
function buildSummary(payload, maxIds = LIMITS.maxSummaryIds) {
  const ops = isPlainObject(payload) ? payload.ops : null;
  if (ops === null || ops === undefined) {
    return { ops: 0, counts: {}, nodeIds: [], edgeIds: [] };
  }
  const counts = {};
  const nodeIds = [];
  const edgeIds = [];
  const seen = new Set();
  let truncated = false;

  const pushId = (list, id) => {
    if (id === null || id === undefined || seen.has(id)) return;
    if (nodeIds.length + edgeIds.length >= maxIds) { truncated = true; return; }
    seen.add(id);
    list.push(id);
  };

  if (Array.isArray(ops)) {
    for (const op of ops) {
      if (!isPlainObject(op)) continue;
      const name = typeof op.op === 'string' && op.op.length > 0 ? op.op : null;
      if (!name) continue;
      counts[name] = (counts[name] || 0) + 1;
      pushId(nodeIds, extractOpId(op, 'node'));
      pushId(edgeIds, extractOpId(op, 'edge'));
    }
    const out = { ops: ops.length, counts, nodeIds, edgeIds };
    if (truncated) out.idsTruncated = true;
    return out;
  }

  // 计数对象（整画布 CAS 计数摘要）：键经 COUNT_KEY_TO_OP 归一到 op 名空间。
  let total = 0;
  for (const [k, v] of Object.entries(ops)) {
    if (!Number.isInteger(v) || v < 0) continue;
    const name = COUNT_KEY_TO_OP[k];
    if (!name) continue; // 未知计数键不猜测（不写入 counts）
    counts[name] = (counts[name] || 0) + v;
    total += v;
  }
  return { ops: total, counts, nodeIds, edgeIds };
}

/* ── query 参数解析（纯函数；返回 {ok:true,value} | {ok:false,error}） ─── */
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
/** limit：缺省 → DEFAULT_LIMIT；整数 1..MAX_LIMIT。 */
function parseLimit(raw) {
  const v = firstScalar(raw);
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    return { ok: true, value: LIMITS.defaultLimit };
  }
  const s = typeof v === 'string' ? v.trim() : v;
  if (typeof s === 'number') {
    if (!Number.isInteger(s)) return { ok: false, error: 'INVALID_LIMIT' };
    if (s < 1 || s > LIMITS.maxLimit) return { ok: false, error: 'INVALID_LIMIT' };
    return { ok: true, value: s };
  }
  if (typeof s !== 'string' || !/^(0|[1-9]\d*)$/.test(s)) return { ok: false, error: 'INVALID_LIMIT' };
  const n = Number(s);
  if (n < 1 || n > LIMITS.maxLimit) return { ok: false, error: 'INVALID_LIMIT' };
  return { ok: true, value: n };
}
/** bucket：缺省 → null（不过滤）；值域 BUCKET_KEYS。 */
function parseBucket(raw) {
  const v = firstScalar(raw);
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    return { ok: true, value: null };
  }
  const s = String(v).trim();
  if (!BUCKET_KEYS.includes(s)) return { ok: false, error: 'INVALID_BUCKET' };
  return { ok: true, value: s };
}

function getQuery(req) {
  if (req && req.query && isPlainObject(req.query)) return req.query;
  const url = req && req.url;
  if (typeof url === 'string' && url.includes('?')) {
    try { return Object.fromEntries(new URL(url, 'http://local').searchParams); } catch (_) { /* fallthrough */ }
  }
  return {};
}

/* ── 行归一（snake_case DB 行 → 内部 camelCase，payload/received_at/seq 解析） ── */
function fromDbRow(row) {
  return {
    seq: toSeqNum(row.seq),
    commandId: row.command_id,
    commandType: row.type,
    payload: parsePayload(row.payload),
    createdAtMs: toEpochMs(row.received_at),
  };
}

/** DB 行 → 响应 item：{seq,commandId,commandType,createdAtMs,bucket?,summary}。 */
function toCommandItem(row) {
  const bucket = deriveBucket(row.payload);
  const item = {
    seq: row.seq,
    commandId: row.commandId,
    commandType: row.commandType,
    createdAtMs: row.createdAtMs,
    summary: buildSummary(row.payload),
  };
  if (bucket !== null) item.bucket = bucket;
  return item;
}

/**
 * 游标分块读取：拉取 seq>cursor 的行直到收集满 want 条「通过 filter 的」行或日志耗尽。
 * 无 bucket 过滤时 filter 恒真 —— 首块即止（SQL LIMIT 下推）；有过滤时分块推进，
 * lastCursor 每块都推进到块内最后一行 seq（游标语义，不重复不跳过已读区间）。
 */
async function readMatchingRows({ pg, canvasId, cursor, want, bucketFilter }) {
  const matched = [];
  const chunk = bucketFilter ? Math.max(LIMITS.chunkSize, want) : want;
  let lastCursor = cursor;
  while (matched.length < want) {
    const r = await pg.query(READ_SQL, [canvasId, lastCursor, chunk]);
    const rows = (r && r.rows) || [];
    if (rows.length === 0) break;
    const last = rows[rows.length - 1];
    lastCursor = toSeqNum(last && last.seq);
    for (const row of rows) {
      const item = fromDbRow(row);
      if (bucketFilter === null || bucketFilter === undefined || deriveBucket(item.payload) === bucketFilter) {
        matched.push(item);
        if (matched.length >= want) break;
      }
    }
    if (rows.length < chunk) break; // 尾部已耗尽（最后一次不足一块）
  }
  return matched;
}

/**
 * 创建命令日志查询 API。
 * @param {{ pg:{query:Function}, authProject?:null|Function,
 *           sendJSON?:Function }} deps
 *   pg        必填。authProject?(req, projectId) 可选鉴权钩子 —— 缺省 null → 默认放行
 *             （调用方 server.js 已做登录+成员判定；本叶不做鉴权，见文件头）。
 *   sendJSON?(res, status, body) 可选（注入即用，未注入走内置 Node res 写或
 *             res.status/body 回退 —— 后者供测试桩）。
 */
function createCanvasCommandLogApi(deps = {}) {
  const { pg } = deps;
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createCanvasCommandLogApi: { pg } with query() required');
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

  async function handle(req, res, params) {
    const projectId =
      params && typeof params.projectId === 'string' ? params.projectId.trim() : '';
    if (!projectId) {
      return sendJSON(res, 400, { ok: false, error: 'PROJECT_ID_REQUIRED', message: 'projectId 必须由调用方注入 params' });
    }
    if (!req || req.method !== 'GET') {
      return sendJSON(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    // 鉴权钩子（可选；缺省 null → 默认放行）。裁决失败不触碰 DB。
    if (authProject) {
      let verdict;
      try {
        verdict = await authProject(req, projectId);
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: '服务内部错误' });
      }
      const denied =
        verdict === false || (isPlainObject(verdict) && verdict.ok === false);
      if (denied) {
        const detail = isPlainObject(verdict) ? verdict : {};
        return sendJSON(res, Number.isInteger(detail.status) ? detail.status : 403, {
          ok: false,
          error: typeof detail.error === 'string' && detail.error.length > 0 ? detail.error : 'FORBIDDEN',
        });
      }
    }

    // 入参解析 —— 任一非法即 400，不触碰 DB。
    const q = getQuery(req);
    const after = parseAfterSeq(q.afterSeq);
    if (!after.ok) return sendJSON(res, 400, { ok: false, error: after.error });
    const lim = parseLimit(q.limit);
    if (!lim.ok) return sendJSON(res, 400, { ok: false, error: lim.error });
    const bk = parseBucket(q.bucket);
    if (!bk.ok) return sendJSON(res, 400, { ok: false, error: bk.error });

    // 项目 → 主画布（无画布 = 尚未建，空结果 200 —— 读路径不报 404）。
    const cr = await pg.query(CANVAS_SQL, [projectId]);
    const canvas = cr && cr.rows && cr.rows[0];
    if (!canvas || !isNonEmptyString(canvas.id)) {
      return sendJSON(res, 200, { commands: [], hasMore: false });
    }

    const matched = await readMatchingRows({
      pg, canvasId: canvas.id, cursor: after.value,
      want: lim.value + 1, // 多取 1 行判定 hasMore
      bucketFilter: bk.value,
    });
    const hasMore = matched.length > lim.value;
    const commands = matched.slice(0, lim.value).map(toCommandItem);
    return sendJSON(res, 200, { commands, hasMore });
  }

  return {
    handle,
    LIMITS,
    BUCKET_KEYS,
    deriveBucket,
    buildSummary,
    parseAfterSeq,
    parseLimit,
    parseBucket,
    SQL: { CANVAS_SQL, READ_SQL },
  };
}

module.exports = { createCanvasCommandLogApi };
