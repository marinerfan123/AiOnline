'use strict';
/**
 * G19 — pendingActionStore：ai-control 人工审批待批队列的存储底座（叶，不接路由）。
 *
 * 消费 approvalGate 裁决（requiresApproval && !shouldAutoApprove → 402 的写路径
 * 应改「入队等待真人批准」，见 aiControlRoutes.cjs TODO(pending_actions)）。四态
 * 状态机（与 0056 迁移 CHECK 一致）：
 *   PENDING -> APPROVED / DENIED   （decide CAS：WHERE status='PENDING'）
 *   PENDING -> EXPIRED             （expireOverdue 过期扫描）
 *   APPROVED / DENIED / EXPIRED 为终态，不可再被 decide 迁出（终态锁）。
 *
 * API（factory-injected pg ({ query })，结果形状统一
 * { ok:true, ... } | { ok:false, error: { code, message } }）：
 *   create({ kind, actorId?, actorRole?, payload, ttlMs?=approvalGate.DEFAULT_TTL_MS })
 *     -> { ok:true, pendingAction }，id = rid('pa') = `pa-<uuid>`；expires_at =
 *     入队时刻 + ttlMs。kind/actorRole 词表直接复用 approvalGate
 *     （APPROVAL_REQUIRED_KINDS / ACTOR_ROLES），非法值 fail-closed 抛错返回。
 *   listPending({ actorRole? }) -> { ok:true, pendingActions } 仅 PENDING，FIFO
 *     (created_at ASC, id ASC)。
 *   decide({ id, decidedBy, approve, note? }) -> { ok:true, pendingAction }
 *     CAS PENDING→APPROVED/DENIED 并落 decided_at/decided_by/decision_note；
 *     不存在 / 已是终态 → { ok:false }（NOT_FOUND / TERMINAL_STATE）。
 *   expireOverdue(now?) -> { ok:true, expired:N }，PENDING 且 expires_at < now
 *     原子置 EXPIRED（幂等：已 EXPIRED 不计）。
 *   get(id) -> { ok:true, pendingAction | null }（任意状态可读）。
 *
 * 可见性（跨角色）：与迁移 0056 注一致 —— listPending 是全量（任何 PENDING 行都
 * 返回，不做行级鉴权裁剪）；「admin 全见 / actor 只见自己」是调用方职责：admin
 * 直接消费全量，agent/其它角色调用方按返回行的 actorId/actorRole 自行过滤。
 * actorRole 可选参数仅是纯过滤条件（如「列出 agent 待批」），不是 ACL。
 *
 * 约定（与 batchTaskStore / worksStore / runEventStore 同款）：
 *   - DDL 与本叶迁移 0056 完全一致（测试/临时库自举 ensureSchema；生产以迁移为准）。
 *   - 时间语义：created_at 走 DB NOW() 默认；expires_at 由 create 在应用侧
 *     （Date.now()+ttlMs）显式计算落参；decided_at 走 SQL NOW()。
 */

const crypto = require('crypto');
const approvalGate = require('./approvalGate.cjs');
const rid = (p) => `${p}-${crypto.randomUUID()}`;

/** 四态状态机词汇表（与迁移 0056 的 CHECK 一致）。 */
const VALID_STATUSES = Object.freeze(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED']);
/** 终态集合：decide 不得再迁出（终态锁）。 */
const TERMINAL_STATUSES = new Set(['APPROVED', 'DENIED', 'EXPIRED']);
/** 审批角色词表单源 = approvalGate.ACTOR_ROLES。 */
const ACTOR_ROLES = approvalGate.ACTOR_ROLES;
/** kind 合法词表单源 = approvalGate.APPROVAL_REQUIRED_KINDS（写操作封闭集合）。 */
const APPROVAL_REQUIRED_KINDS = approvalGate.APPROVAL_REQUIRED_KINDS;
/** 默认存活时间（1h），create 未给 ttlMs 时用。 */
const DEFAULT_TTL_MS = approvalGate.DEFAULT_TTL_MS;

/** 与 0056 迁移完全一致的建表 DDL（测试/临时库自举；生产以迁移为准）。 */
const DDL = `
CREATE TABLE IF NOT EXISTS pending_actions (
  id            TEXT        PRIMARY KEY,
  kind          TEXT        NOT NULL,
  actor_id      TEXT,
  actor_role    TEXT,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT,
  decision_note TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  CONSTRAINT pending_actions_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED'))
);`;

const COLS = `id, kind, actor_id, actor_role, payload, status,
       created_at, decided_at, decided_by, decision_note, expires_at`;

const INSERT_SQL = `
INSERT INTO pending_actions
  (id, kind, actor_id, actor_role, payload, expires_at)
VALUES ($1, $2, $3, $4, $5::jsonb, $6)
RETURNING ${COLS}`;

/** listPending：仅 PENDING，FIFO。可选 actor_role 纯过滤（非 ACL）。 */
const LIST_BASE_SQL = `
SELECT ${COLS}
  FROM pending_actions
 WHERE status = 'PENDING'`;

const LIST_ORDER_SQL = `
 ORDER BY created_at ASC, id ASC`;

/** decide CAS（终态锁）：仅 PENDING 可被批准/驳回；终态行被 WHERE 排除 → rowCount 0。 */
const DECIDE_SQL = `
UPDATE pending_actions
   SET status = $2,
       decided_at = NOW(),
       decided_by = $3,
       decision_note = $4
 WHERE id = $1 AND status = 'PENDING'
RETURNING ${COLS}`;

/** decide 失败时回查现状，以区分 PENDING_ACTION_NOT_FOUND 与 TERMINAL_STATE。 */
const READ_STATUS_SQL = `
SELECT status FROM pending_actions WHERE id = $1`;

/** expireOverdue：PENDING 且已过期的行原子置 EXPIRED（RETURNING 计数用 id）。 */
const EXPIRE_SQL = `
UPDATE pending_actions
   SET status = 'EXPIRED'
 WHERE status = 'PENDING' AND expires_at < $1
RETURNING id`;

const READ_SQL = `SELECT ${COLS} FROM pending_actions WHERE id = $1`;

/** jsonb 读取：node-pg 已 parse；mock 可能回传字符串。 */
function parseJson(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
  return v === undefined || v === null ? {} : v;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function err(code, message) {
  return { ok: false, error: { code, message } };
}

function normalizeRow(r) {
  return {
    id: r.id,
    kind: r.kind,
    actorId: r.actor_id,
    actorRole: r.actor_role,
    payload: parseJson(r.payload),
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    expiresAt: r.expires_at,
  };
}

function coerceNow(now) {
  if (now === undefined || now === null) return new Date();
  if (now instanceof Date) return now;
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError('expireOverdue: now 必须是 Date / 可解析时间戳');
  }
  return d;
}

function createPendingActionStore({ pg }) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createPendingActionStore requires { pg } with .query()');
  }

  // Memoized once per store instance so concurrent first writes share one CREATE.
  let schemaReady = null;
  function ensureSchema() {
    if (!schemaReady) schemaReady = pg.query(DDL).then(() => true);
    return schemaReady;
  }

  /**
   * create({ kind, actorId?, actorRole?, payload, ttlMs? }) -> { ok:true, pendingAction }
   * 入队一条 PENDING 待批记录。kind 须在 approvalGate.APPROVAL_REQUIRED_KINDS，
   * actorRole 须在 ACTOR_ROLES；payload 须为对象（JSONB）；ttlMs 默认 1h。
   * id = rid('pa')；expires_at = Date.now() + ttlMs（应用侧显式落参）。
   */
  async function create({ kind, actorId, actorRole, payload, ttlMs } = {}) {
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(APPROVAL_REQUIRED_KINDS, kind)) {
      return err('INVALID_KIND', `kind 必须是 APPROVAL_REQUIRED_KINDS 之一（${Object.keys(APPROVAL_REQUIRED_KINDS).join(', ')}）`);
    }
    if (!ACTOR_ROLES.includes(actorRole)) {
      return err('INVALID_ACTOR_ROLE', `actorRole 必须是 ${ACTOR_ROLES.join('|')} 之一`);
    }
    if (actorId !== undefined && actorId !== null && !isNonEmptyString(actorId)) {
      return err('INVALID_ACTOR_ID', 'actorId 必须是非空字符串（或省略为 null）');
    }
    if (!isPlainObject(payload)) {
      return err('INVALID_PAYLOAD', 'payload 必须是对象（JSONB 写快照）');
    }
    const ttl = ttlMs === undefined ? DEFAULT_TTL_MS : ttlMs;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      return err('INVALID_TTL', `ttlMs 必须是正整数毫秒（默认 ${DEFAULT_TTL_MS}）`);
    }
    const id = rid('pa');
    const expiresAt = new Date(Date.now() + ttl);
    await ensureSchema();
    const r = await pg.query(INSERT_SQL, [
      id, kind, actorId === undefined ? null : actorId, actorRole,
      JSON.stringify(payload), expiresAt,
    ]);
    const row = r && r.rows && r.rows[0];
    if (!row) return err('INSERT_FAILED', 'pending action insert returned no row');
    return { ok: true, pendingAction: normalizeRow(row) };
  }

  /**
   * listPending({ actorRole? }) -> { ok:true, pendingActions }
   * 仅 PENDING，FIFO (created_at ASC, id ASC)。全量语义：不做行级鉴权裁剪，
   * admin 全见 / actor 只见自己 由调用方按返回行过滤（见文件头注）。
   * actorRole 为可选纯过滤条件（如「列出某角色的待批」），非 ACL。
   */
  async function listPending({ actorRole } = {}) {
    if (actorRole !== undefined && actorRole !== null && !ACTOR_ROLES.includes(actorRole)) {
      return err('INVALID_ACTOR_ROLE', `actorRole 必须是 ${ACTOR_ROLES.join('|')} 之一`);
    }
    await ensureSchema();
    const hasRoleFilter = actorRole !== undefined && actorRole !== null;
    const sql = LIST_BASE_SQL
      + (hasRoleFilter ? ' AND actor_role = $1' : '')
      + LIST_ORDER_SQL;
    const r = await pg.query(sql, hasRoleFilter ? [actorRole] : []);
    const pendingActions = (r && r.rows ? r.rows : []).map(normalizeRow);
    return { ok: true, pendingActions };
  }

  /**
   * decide({ id, decidedBy, approve, note? }) -> { ok:true, pendingAction }
   * CAS PENDING→APPROVED(approve=true)/DENIED(approve=false) 并落 decided_at /
   * decided_by / decision_note。终态（APPROVED/DENIED/EXPIRED）不可再迁出
   * （WHERE status='PENDING' 即锁）；不存在或已终态 → { ok:false }。
   */
  async function decide({ id, decidedBy, approve, note } = {}) {
    if (!isNonEmptyString(id)) {
      return err('INVALID_ACTION_ID', 'id（待批记录 id，非空字符串）必填');
    }
    if (!isNonEmptyString(decidedBy)) {
      return err('INVALID_DECIDED_BY', 'decidedBy（审批人标识，非空字符串）必填');
    }
    if (typeof approve !== 'boolean') {
      return err('INVALID_APPROVE', 'approve 必须是布尔值（true=批准 / false=驳回）');
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return err('INVALID_DECISION_NOTE', 'note 必须是字符串（或省略）');
    }
    const target = approve ? 'APPROVED' : 'DENIED';
    await ensureSchema();
    const r = await pg.query(DECIDE_SQL, [id, target, decidedBy, note === undefined ? null : note]);
    if (r && r.rows && r.rows[0]) {
      return { ok: true, pendingAction: normalizeRow(r.rows[0]) };
    }
    // rowCount 0 → 区分不存在 vs 终态锁。
    const cur = await pg.query(READ_STATUS_SQL, [id]);
    const row = cur && cur.rows && cur.rows[0];
    if (!row) {
      return err('PENDING_ACTION_NOT_FOUND', `pending action ${id} 不存在`);
    }
    if (row.status === 'EXPIRED') {
      return err('TERMINAL_STATE', `pending action ${id} 已 EXPIRED（过期），不可再审批`);
    }
    return err('TERMINAL_STATE', `pending action ${id} 已是 ${row.status}（终态），不可重复审批`);
  }

  /**
   * expireOverdue(now?) -> { ok:true, expired:N }
   * PENDING 且 expires_at < now 的行原子置 EXPIRED。now 缺省 = 当前时刻；
   * 幂等：已 EXPIRED / 已审批的行不在 UPDATE 范围内，不会二次计数。
   */
  async function expireOverdue(now) {
    const bound = coerceNow(now);
    await ensureSchema();
    const r = await pg.query(EXPIRE_SQL, [bound]);
    return { ok: true, expired: Number(r && r.rowCount) || 0 };
  }

  /**
   * get(id) -> { ok:true, pendingAction | null }
   * 任意状态（含 APPROVED/DENIED/EXPIRED）按 id 读取；不存在 → null。
   */
  async function get(id) {
    if (!isNonEmptyString(id)) {
      return err('INVALID_ACTION_ID', 'id（待批记录 id，非空字符串）必填');
    }
    await ensureSchema();
    const r = await pg.query(READ_SQL, [id]);
    const row = r && r.rows && r.rows[0];
    return { ok: true, pendingAction: row ? normalizeRow(row) : null };
  }

  return { ensureSchema, create, listPending, decide, expireOverdue, get };
}

module.exports = {
  DDL,
  VALID_STATUSES,
  TERMINAL_STATUSES,
  ACTOR_ROLES,
  APPROVAL_REQUIRED_KINDS,
  DEFAULT_TTL_MS,
  createPendingActionStore,
  SQL: { INSERT_SQL, LIST_BASE_SQL, LIST_ORDER_SQL, DECIDE_SQL, READ_STATUS_SQL, EXPIRE_SQL, READ_SQL },
};
