'use strict';
/**
 * G13 V2.0 must#4 — storyboard_batch_tasks store（partial retry 底座）。
 *
 * 消费 storyboardBatchPlan.cjs 产出的 tasks[{taskId, shotId, kind:'image_gen', params}]
 * 落库为一批可独立重试的任务行。状态机（与 0051 迁移 CHECK 一致）：
 *   QUEUED -> RUNNING / SUCCEEDED / FAILED / SKIPPED
 *   RUNNING -> SUCCEEDED / FAILED / SKIPPED
 *   终态（SUCCEEDED / FAILED / SKIPPED）不可被 markTask 覆写（终态锁）。
 *   retryFailed 单独把 FAILED 且 attempt < max_attempts 的行复位为 QUEUED 并 attempt+1。
 *   claimTask 跨进程单赢者领单：仅 QUEUED→RUNNING 原子迁移（WHERE status='QUEUED'），
 *   消除双 runner 并发双跑（旧 markTask 的 WHERE status IN ('QUEUED','RUNNING') 曾允许
 *   RUNNING→RUNNING 二次成功）。
 *
 * 每批独立键 (batch_id, task_id)；UNIQUE(script_id, shot_id, kind, batch_id) 含批，故同一
 * (script, shot, kind) 可跨批次重复入队（重试批次再排同一镜头），同批内则不允许重复。
 *
 * Factory-injected pg ({ query }) — 与 mediaDerivedStore / runEventStore 同款约定。
 * 结果形状统一 { ok: true, ... } | { ok: false, error: { code, message } }。
 */

const crypto = require('crypto');
const rid = (p) => `${p}-${crypto.randomUUID()}`;

/** 五态状态机词汇表（与迁移 0051 的 CHECK 一致）。 */
const VALID_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED']);
/** 终态集合：markTask 不得再迁出。 */
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'SKIPPED']);

/** 与 0051 迁移完全一致的建表 DDL（测试/临时库自举；生产以迁移为准）。 */
const DDL = `
CREATE TABLE IF NOT EXISTS storyboard_batch_tasks (
  batch_id     TEXT        NOT NULL,
  task_id      TEXT        NOT NULL,
  script_id    TEXT        NOT NULL,
  shot_id      TEXT        NOT NULL,
  kind         TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'QUEUED',
  attempt      INT         NOT NULL DEFAULT 0,
  max_attempts INT         NOT NULL DEFAULT 3,
  params       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  result_ref   TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (batch_id, task_id),
  CONSTRAINT storyboard_batch_tasks_status_check
    CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  CONSTRAINT storyboard_batch_tasks_script_shot_kind_batch_key
    UNIQUE (script_id, shot_id, kind, batch_id)
);`;

/** 多行入队：单条 INSERT，status/attempt/max_attempts 用字面量，时间列走默认值。 */
const ENQUEUE_SQL = `
INSERT INTO storyboard_batch_tasks
  (batch_id, task_id, script_id, shot_id, kind, status, attempt, max_attempts, params)
VALUES
  %VALUES%
RETURNING task_id`;

const LIST_SQL = `
SELECT batch_id, task_id, script_id, shot_id, kind, status, attempt, max_attempts,
       params, result_ref, error, created_at, updated_at
  FROM storyboard_batch_tasks
 WHERE batch_id = $1
 ORDER BY task_id ASC`;

/**
 * markTask 转移矩阵 CAS：迁移按「源状态 × 目标状态」严格限定，非仅终态锁——
 *   - RUNNING 目标：仅 QUEUED 可迁（claim 语义；RUNNING→RUNNING 不再二次成功 → 双跑面消除）
 *   - SUCCEEDED/FAILED/SKIPPED 目标：仅 QUEUED/RUNNING 可迁（终态不可覆写）
 *   - QUEUED 目标：一律禁止（降级/空转；retryFailed 用专用 SQL 复位 FAILED→QUEUED）
 * 非法迁移 / 终态覆写 / 不存在 → rowCount 0，随后回查区分错误码。
 * attempt/result_ref/error 为可选（COALESCE 保留现值）。
 */
const MARK_TASK_SQL = `
UPDATE storyboard_batch_tasks
   SET status     = $3,
       attempt    = COALESCE($4, attempt),
       result_ref = COALESCE($5, result_ref),
       error      = COALESCE($6, error),
       updated_at = NOW()
 WHERE batch_id = $1
   AND task_id  = $2
   AND (
          ($3 = 'RUNNING'                           AND status = 'QUEUED')
       OR ($3 IN ('SUCCEEDED', 'FAILED', 'SKIPPED') AND status IN ('QUEUED', 'RUNNING'))
   )
 RETURNING batch_id, task_id, script_id, shot_id, kind, status, attempt, max_attempts,
           params, result_ref, error, created_at, updated_at`;

/**
 * claimTask 严格单赢者 CAS：仅 status='QUEUED' 可迁 RUNNING（跨进程原子）。
 * RUNNING（他 runner 已领）/ 终态 / 不存在 → rowCount 0，回查后给出精确错误码。
 * 不改 attempt/result_ref/error —— claim 不消费重试计数，也不越权清错。
 */
const CLAIM_TASK_SQL = `
UPDATE storyboard_batch_tasks
   SET status = 'RUNNING',
       updated_at = NOW()
 WHERE batch_id = $1
   AND task_id  = $2
   AND status = 'QUEUED'
 RETURNING batch_id, task_id, script_id, shot_id, kind, status, attempt, max_attempts,
           params, result_ref, error, created_at, updated_at`;

/** markTask 失败时回查现状，以区分 TASK_NOT_FOUND 与 TERMINAL_STATE。 */
const READ_STATUS_SQL = `
SELECT status FROM storyboard_batch_tasks
 WHERE batch_id = $1 AND task_id = $2`;

/** 仅复位可重试的 FAILED 行（attempt < max_attempts），attempt+1，清 result_ref/error。 */
const RETRY_FAILED_SQL = `
UPDATE storyboard_batch_tasks
   SET status     = 'QUEUED',
       attempt    = attempt + 1,
       result_ref = NULL,
       error      = NULL,
       updated_at = NOW()
 WHERE batch_id = $1
   AND status = 'FAILED'
   AND attempt < max_attempts
 RETURNING task_id`;

const PROGRESS_SQL = `
SELECT status, COUNT(*)::int AS n
  FROM storyboard_batch_tasks
 WHERE batch_id = $1
 GROUP BY status`;

/** jsonb 读取：node-pg 已 parse；mock 可能回传字符串。 */
function parseJson(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
  return v === undefined || v === null ? {} : v;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function err(code, message) {
  return { ok: false, error: { code, message } };
}

function normalizeRow(r) {
  return {
    batchId: r.batch_id,
    taskId: r.task_id,
    scriptId: r.script_id,
    shotId: r.shot_id,
    kind: r.kind,
    status: r.status,
    attempt: Number(r.attempt),
    maxAttempts: Number(r.max_attempts),
    params: parseJson(r.params),
    resultRef: r.result_ref,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 校验并归一化 createBatch 的任务入参；返回 { ok, value }。 */
function validateTasks(tasks) {
  if (!Array.isArray(tasks)) {
    return { ok: false, error: err('INVALID_TASKS', 'tasks must be an array') };
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i];
    const p = `tasks[${i}]`;
    if (t == null || typeof t !== 'object' || Array.isArray(t)) {
      return { ok: false, error: err('INVALID_TASK', `${p}: task object required`) };
    }
    if (!isNonEmptyString(t.taskId)) {
      return { ok: false, error: err('INVALID_TASK', `${p}: taskId must be a non-empty string`) };
    }
    if (!isNonEmptyString(t.shotId)) {
      return { ok: false, error: err('INVALID_TASK', `${p}: shotId must be a non-empty string`) };
    }
    if (!isNonEmptyString(t.kind)) {
      return { ok: false, error: err('INVALID_TASK', `${p}: kind must be a non-empty string`) };
    }
    if (t.params !== undefined && t.params !== null && (typeof t.params !== 'object' || Array.isArray(t.params))) {
      return { ok: false, error: err('INVALID_TASK', `${p}: params must be an object (or omitted)`) };
    }
    if (seen.has(t.taskId)) {
      return { ok: false, error: err('INVALID_TASK', `duplicate taskId ${JSON.stringify(t.taskId)} (would collide (batch_id, task_id) PK)`) };
    }
    seen.add(t.taskId);
    out.push({
      taskId: t.taskId,
      shotId: t.shotId,
      kind: t.kind,
      params: t.params === undefined || t.params === null ? {} : t.params,
    });
  }
  return { ok: true, value: out };
}

function createBatchTaskStore({ pg }) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createBatchTaskStore requires { pg } with .query()');
  }

  // Memoized once per store instance so concurrent first writes share one CREATE.
  let schemaReady = null;
  function ensureSchema() {
    if (!schemaReady) schemaReady = pg.query(DDL).then(() => true);
    return schemaReady;
  }

  /**
   * createBatch({ scriptId, tasks[] }) -> { ok:true, batchId, enqueued }
   * 整批单条 INSERT（原子）；batchId = rid('bt')。空 tasks 合法 → 空批。
   */
  async function createBatch({ scriptId, tasks } = {}) {
    if (!isNonEmptyString(scriptId)) {
      return err('INVALID_SCRIPT_ID', 'scriptId (non-empty string) required');
    }
    const vt = validateTasks(tasks);
    if (!vt.ok) return vt.error;
    const batchId = rid('bt');
    if (vt.value.length === 0) {
      return { ok: true, batchId, enqueued: 0 };
    }
    await ensureSchema();
    const values = [];
    const rows = [];
    for (const t of vt.value) {
      const i = values.length;
      rows.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, 'QUEUED', 0, 3, $${i + 6}::jsonb)`);
      values.push(batchId, t.taskId, scriptId, t.shotId, t.kind, JSON.stringify(t.params));
    }
    const sql = ENQUEUE_SQL.replace('%VALUES%', rows.join(',\n  '));
    const r = await pg.query(sql, values);
    return { ok: true, batchId, enqueued: Number(r && r.rowCount) || 0 };
  }

  /**
   * listTasks(batchId) -> { ok:true, tasks: [...] }（按 task_id 升序）。
   */
  async function listTasks(batchId) {
    if (!isNonEmptyString(batchId)) {
      return err('INVALID_BATCH_ID', 'batchId (non-empty string) required');
    }
    await ensureSchema();
    const r = await pg.query(LIST_SQL, [batchId]);
    const tasks = (r && r.rows ? r.rows : []).map(normalizeRow);
    return { ok: true, tasks };
  }

  /**
   * markTask({ batchId, taskId, status, attempt?, resultRef?, error? })
   * 转移矩阵 CAS：QUEUED→{RUNNING,SUCCEEDED,FAILED,SKIPPED}；RUNNING→{SUCCEEDED,FAILED,SKIPPED}。
   * RUNNING→RUNNING（二次 claim）与 RUNNING→QUEUED（降级）均被拒 → INVALID_TRANSITION。
   * 终态覆写 → TERMINAL_STATE；任务不存在 → TASK_NOT_FOUND；非法状态 → INVALID_STATUS。
   * 注：claim RUNNING 请用 claimTask（更严的单赢者 CAS + 精确 ALREADY_CLAIMED 错误码）。
   */
  async function markTask({ batchId, taskId, status, attempt, resultRef, error } = {}) {
    if (!isNonEmptyString(batchId)) {
      return err('INVALID_BATCH_ID', 'batchId (non-empty string) required');
    }
    if (!isNonEmptyString(taskId)) {
      return err('INVALID_TASK_ID', 'taskId (non-empty string) required');
    }
    if (!VALID_STATUSES.includes(status)) {
      return err('INVALID_STATUS', `status must be one of ${VALID_STATUSES.join(', ')}`);
    }
    if (attempt !== undefined && attempt !== null && !isNonNegInt(attempt)) {
      return err('INVALID_ATTEMPT', 'attempt must be a non-negative integer (or omitted)');
    }
    await ensureSchema();
    const attemptVal = attempt === undefined ? null : attempt;
    const resultRefVal = resultRef === undefined ? null : resultRef;
    const errorVal = error === undefined ? null : error;
    const r = await pg.query(MARK_TASK_SQL, [batchId, taskId, status, attemptVal, resultRefVal, errorVal]);
    if (r && r.rows && r.rows[0]) {
      return { ok: true, task: normalizeRow(r.rows[0]) };
    }
    // rowCount 0 → 区分任务不存在 vs 终态锁 vs 非法迁移。
    const cur = await pg.query(READ_STATUS_SQL, [batchId, taskId]);
    const row = cur && cur.rows && cur.rows[0];
    if (!row) {
      return err('TASK_NOT_FOUND', `task ${taskId} not found in batch ${batchId}`);
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      return err('TERMINAL_STATE', `task ${taskId} is ${row.status} (terminal); terminal states cannot be overwritten`);
    }
    return err('INVALID_TRANSITION', `cannot transition ${row.status} → ${status}`);
  }

  /**
   * claimTask({ batchId, taskId }) -> { ok:true, task } | { ok:false, error }
   * 跨进程单赢者 claim：仅 status='QUEUED' 原子迁到 RUNNING（WHERE status='QUEUED'）。
   * 失败回查精确区分：RUNNING → ALREADY_CLAIMED（他 runner 已领）；终态 → TERMINAL_STATE；
   * 不存在 → TASK_NOT_FOUND。不改 attempt/result_ref/error。
   */
  async function claimTask({ batchId, taskId } = {}) {
    if (!isNonEmptyString(batchId)) {
      return err('INVALID_BATCH_ID', 'batchId (non-empty string) required');
    }
    if (!isNonEmptyString(taskId)) {
      return err('INVALID_TASK_ID', 'taskId (non-empty string) required');
    }
    await ensureSchema();
    const r = await pg.query(CLAIM_TASK_SQL, [batchId, taskId]);
    if (r && r.rows && r.rows[0]) {
      return { ok: true, task: normalizeRow(r.rows[0]) };
    }
    const cur = await pg.query(READ_STATUS_SQL, [batchId, taskId]);
    const row = cur && cur.rows && cur.rows[0];
    if (!row) {
      return err('TASK_NOT_FOUND', `task ${taskId} not found in batch ${batchId}`);
    }
    if (row.status === 'RUNNING') {
      return err('ALREADY_CLAIMED', `task ${taskId} is already RUNNING (claimed by another runner)`);
    }
    return err('TERMINAL_STATE', `task ${taskId} is ${row.status} (terminal); cannot be claimed`);
  }

  /**
   * retryFailed(batchId) -> { ok:true, reset:N }
   * 仅复位 status=FAILED 且 attempt < max_attempts 的行 → QUEUED + attempt+1。
   */
  async function retryFailed(batchId) {
    if (!isNonEmptyString(batchId)) {
      return err('INVALID_BATCH_ID', 'batchId (non-empty string) required');
    }
    await ensureSchema();
    const r = await pg.query(RETRY_FAILED_SQL, [batchId]);
    return { ok: true, reset: Number(r && r.rowCount) || 0 };
  }

  /**
   * progress(batchId) -> { ok:true, total, byStatus: {QUEUED,RUNNING,SUCCEEDED,FAILED,SKIPPED} }
   * byStatus 五态全部给出（缺省 0）。
   */
  async function progress(batchId) {
    if (!isNonEmptyString(batchId)) {
      return err('INVALID_BATCH_ID', 'batchId (non-empty string) required');
    }
    await ensureSchema();
    const r = await pg.query(PROGRESS_SQL, [batchId]);
    const byStatus = {};
    for (const s of VALID_STATUSES) byStatus[s] = 0;
    let total = 0;
    for (const row of (r && r.rows ? r.rows : [])) {
      const n = Number(row.n) || 0;
      byStatus[row.status] = n;
      total += n;
    }
    return { ok: true, total, byStatus };
  }

  return { ensureSchema, createBatch, listTasks, markTask, claimTask, retryFailed, progress };
}

module.exports = {
  DDL,
  VALID_STATUSES,
  TERMINAL_STATUSES,
  createBatchTaskStore,
  SQL: { ENQUEUE_SQL, LIST_SQL, MARK_TASK_SQL, CLAIM_TASK_SQL, READ_STATUS_SQL, RETRY_FAILED_SQL, PROGRESS_SQL },
};
