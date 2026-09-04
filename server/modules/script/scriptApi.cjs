'use strict';
/**
 * G13 phase-2 — Script rows CRUD API (0039 script_rows).
 * Endpoints under /api/v2/script (interface mirrors timelineApi/bibleApi:
 * deps {pg, sessionUser, sendJSON, parseBody}; internal requireUser(401) +
 * requireProject(404/403 via projects JOIN workspaces + workspace_members)).
 * Operations:
 *   POST   /api/v2/script/rows            {rows:[validated row...]} → batch insert
 *   GET    /api/v2/script/rows            ?scene= (filter by scene_index) or all
 *   GET    /api/v2/script/rows/:id        single
 *   PATCH  /api/v2/script/rows/:id        merge-update given columns (revalidated)
 *   PUT    /api/v2/script/order           {sceneIndex, rowIds:[...]} reindex 0..n
 *   DELETE /api/v2/script/rows/:id        hard delete (no deleted_at col)
 *   GET    /api/v2/script/:scriptId/storyboard  (or /api/v2/script/storyboard
 *          ?scriptId=) storyboard PLAN view — read-only; computes the
 *          deterministic beats/shots plan from the project's rows (scene order)
 *          via buildStoryboardPlan. Permissions follow GET /rows (viewer can
 *          read; owner/editor not required). Response adds the 0054 staleness
 *          contract (三视图接线收口): `dirty` bool — true when this script's
 *          PERSISTED plan (project_shots_rows) is behind script_rows, i.e.
 *          any persisted row was markDirty'd by a rows write, OR the stored
 *          plan fingerprint differs from the freshly computed one;
 *          `planFingerprint` — the stored fingerprint of the script's latest
 *          persisted generation (null when the script was never applied).
 *   POST   /api/v2/script/:scriptId/storyboard/apply  (or
 *          /api/v2/script/storyboard/apply?scriptId=) PERSIST the plan: same
 *          dual spelling, same project-bound ownership, but the write gate
 *          (owner/editor) applies. The plan is ALWAYS recomputed server-side
 *          from the project's own script_rows → buildStoryboardPlan →
 *          persistStoryboardShots; the request body is ignored (empty OK), so
 *          a client can never forge persisted beats/shots. rows 空 → 400.
 *          Success 200 { ok:true, applied:{ version, shotCount, replaced } }.
 *   POST   /api/v2/script/:scriptId/storyboard/batch  (or
 *          /api/v2/script/storyboard/batch?scriptId=) V2.0 must#4 — enqueue an
 *          image_gen BATCH for the storyboard plan. Same dual spelling, same
 *          write gate (owner/editor) as apply, body ignored: the plan is
 *          recomputed server-side (rows → buildStoryboardPlan → beats →
 *          storyboardBatchPlan) and every shot lacking a produced image is
 *          enqueued via batchTaskStore.createBatch. rows 空 / 计划空 → 400.
 *          Batch 一致性收口: ① 前置 dirty 门 —— 该 script 最新代持久化计划
 *          dirty=true（rows 写 markDirty 或 存储指纹 ≠ 现算指纹）→ 409
 *          { ok:false, error:'PLAN_DIRTY', message:'先 apply 再批量生成' }，
 *          不建批（与 GET plan 视图同口径 readPlanStaleness）; ② locked shot
 *          （0052）钉在旧代、apply 也跳过 —— 批量同样不为 locked shot 建任务
 *          （建批前查 (project,script) 锁定集合并排除）; ③ 全锁 → 空批 200
 *          { ok:true, batchId:null, enqueued:0, total, skippedLocked:全部,
 *          dirty:false }（选 200 非 409：请求合法只是无可生成内容；空批无任务
 *          行、不 mint 批次）。Success 200 { ok:true, batchId, enqueued, total,
 *          skippedLocked:[被锁排除的 shotId], dirty:false }。
 *   GET    /api/v2/script/storyboard/batches/:batchId   batch view (tasks +
 *          progress). Read follows GET /rows (viewer may read).
 *   POST   /api/v2/script/storyboard/batches/:batchId/retry-failed   batch-wide
 *          retry: resets every FAILED task with attempt < max_attempts →
 *          200 { ok:true, reset }.
 *   POST   /api/v2/script/storyboard/batches/:batchId/tasks/:taskId/retry
 *          single-task retry (only FAILED && attempt < max_attempts) →
 *          200 { ok:true, reset:1 }; non-retryable → 409; missing → 404.
 *   POST   /api/v2/script/:scriptId/storyboard/shots/lock  (or
 *          /api/v2/script/storyboard/shots/lock?scriptId=) lock/unlock plan
 *          shots (0052): body { shotIds:[...], locked:bool } → lockShots batch
 *          set on (project, script) scope → 200 { ok:true, locked }; empty /
 *          malformed shotIds → 400; no shot matched (cross-project / never
 *          applied / unknown shot) → 404; viewer → 403 (write gate).
 *          unlock = same body with locked:false.
 * 0054 接线（三视图收口）: rows 写操作（POST /rows、PATCH /rows/:id、PUT /order、
 *          DELETE /rows/:id）成功后，把该项目全部已持久化计划 script
 *          （project_shots_rows 中的 DISTINCT script_id）逐一 markDirty ——
 *          计划是该项目 script_rows 的投影，任何 rows 写都使所有已 apply 计划
 *          可报 STALE；从未 apply（无计划行）则无事可做。标注为 best-effort，
 *          失败不影响已成功的 rows 写。GET …/storyboard 据此 + 指纹比较报 dirty。
 *   Batch rows (0051) carry no project_id — project isolation of batch
 *   resource routes rests on the same requireProject membership gate every
 *   sibling route uses (batchId is an unguessable bt-UUID minted only for the
 *   requesting project's script).
 * Rows carry integer-ms timing only (Blueprint hard rule). Speaker enforced for
 * dialogue by validateScriptRow.
 */
const crypto = require('crypto');
const { validateScriptRow, buildSceneRows, normalizeContinuityNotes } = require('./scriptModel.cjs');
const { buildStoryboardPlan } = require('./storyboardPlan.cjs');
const {
  persistStoryboardShots,
  markDirty,
  lockShots,
  computePlanFingerprint,
  SQL: { LOCKED_SHOT_IDS_SQL },
} = require('./storyboardShots.cjs');
const { storyboardBatchPlan } = require('./storyboardBatchPlan.cjs');
const { createBatchTaskStore } = require('./batchTaskStore.cjs');

/**
 * Match the storyboard routes on a scriptApi URL. Accepted spellings
 * (same handler, same semantics for the scriptId-carrying ones):
 *   A) /api/v2/script/:scriptId/storyboard[/apply|/batch]  — scriptId in path
 *   B) /api/v2/script/storyboard[/apply|/batch]?scriptId=… — scriptId in query
 *   C) /api/v2/script/storyboard/batches/:batchId[/
 *         retry-failed | tasks/:taskId/retry]              — batch resource
 * (projectId is always supplied the way sibling rows routes receive it — from
 * the query string via req.params, project-bound SQL does the ownership.)
 * Returns null when the URL is not a storyboard route. Success shape:
 *   { kind, method, scriptId?, batchId?, taskId? } where kind ∈
 *   'plan' (GET plan view), 'apply' (POST persist), 'createBatch'
 *   (POST enqueue), 'listBatch' (GET), 'retryBatch' (POST),
 *   'retryTask' (POST), 'lock' (POST shots/lock; unlock same route with
 *   locked:false). scriptId may be null when spelling B omits it (the
 *   handler then 400s). The 'rows' / 'order' prefixes are reserved by the CRUD
 *   routes, so /api/v2/script/rows/storyboard… stays a rows route, never a
 *   storyboard view/action.
 */
function decodeSegment(raw) {
  try { return decodeURIComponent(raw); } catch (_) { return null; }
}

function scriptIdFromParams(params) {
  const sid = params && typeof params.scriptId === 'string' ? params.scriptId.trim() : '';
  return sid !== '' ? sid : null;
}

function matchStoryboardRoute(urlPath, params) {
  const sidParam = scriptIdFromParams(params);
  // B) query-form plan view / apply / batch create — scriptId lives in params.
  if (urlPath === '/api/v2/script/storyboard') {
    return { kind: 'plan', method: 'GET', scriptId: sidParam };
  }
  if (urlPath === '/api/v2/script/storyboard/apply') {
    return { kind: 'apply', method: 'POST', scriptId: sidParam };
  }
  if (urlPath === '/api/v2/script/storyboard/batch') {
    return { kind: 'createBatch', method: 'POST', scriptId: sidParam };
  }
  // B) query-form lock/unlock — shots/lock under the storyboard subtree.
  if (urlPath === '/api/v2/script/storyboard/shots/lock') {
    return { kind: 'lock', method: 'POST', scriptId: sidParam };
  }
  // A) path-form plan view / apply / batch create — :scriptId segment in path.
  const pm = /^\/api\/v2\/script\/([^/]+)\/storyboard(?:\/(apply|batch))?$/.exec(urlPath);
  if (pm && pm[1] !== 'rows' && pm[1] !== 'order') {
    const sid = decodeSegment(pm[1]);
    const verb = pm[2];
    if (verb === 'apply') return { kind: 'apply', method: 'POST', scriptId: sid };
    if (verb === 'batch') return { kind: 'createBatch', method: 'POST', scriptId: sid };
    return { kind: 'plan', method: 'GET', scriptId: sid };
  }
  // A) path-form shots lock/unlock — :scriptId/storyboard/shots/lock.
  const lockM = /^\/api\/v2\/script\/([^/]+)\/storyboard\/shots\/lock$/.exec(urlPath);
  if (lockM && lockM[1] !== 'rows' && lockM[1] !== 'order') {
    return { kind: 'lock', method: 'POST', scriptId: decodeSegment(lockM[1]) };
  }
  // C) batch resource subtree (0051 storyboard_batch_tasks).
  const listM = /^\/api\/v2\/script\/storyboard\/batches\/([^/]+)$/.exec(urlPath);
  if (listM) {
    const bid = decodeSegment(listM[1]);
    return bid ? { kind: 'listBatch', method: 'GET', batchId: bid } : { kind: 'badBatchId', method: 'GET' };
  }
  const retryM = /^\/api\/v2\/script\/storyboard\/batches\/([^/]+)\/retry-failed$/.exec(urlPath);
  if (retryM) {
    const bid = decodeSegment(retryM[1]);
    return bid ? { kind: 'retryBatch', method: 'POST', batchId: bid } : { kind: 'badBatchId', method: 'POST' };
  }
  const taskM = /^\/api\/v2\/script\/storyboard\/batches\/([^/]+)\/tasks\/([^/]+)\/retry$/.exec(urlPath);
  if (taskM) {
    const bid = decodeSegment(taskM[1]);
    const tid = decodeSegment(taskM[2]);
    if (!bid || !tid) return { kind: 'badBatchId', method: 'POST' };
    return { kind: 'retryTask', method: 'POST', batchId: bid, taskId: tid };
  }
  return null;
}

// 单任务重试（store 无此原语；retryFailed 只按 batch 复位，markTask 受终态锁
// 约束无法 FAILED→QUEUED，故路由层直接发这条带守卫的 UPDATE——与 0051 状态机
// 一致：仅 status=FAILED 且 attempt < max_attempts 的行被复位为 QUEUED）。
const RETRY_TASK_SQL = `
UPDATE storyboard_batch_tasks
   SET status = 'QUEUED', attempt = attempt + 1, result_ref = NULL,
       error = NULL, updated_at = NOW()
 WHERE batch_id = $1 AND task_id = $2 AND status = 'FAILED'
   AND attempt < max_attempts
 RETURNING task_id`;
// UPDATE 0 行时的回查：区分「任务不存在」(404) 与「存在但不可重试」(409)。
const READ_TASK_SQL = `
SELECT status, attempt, max_attempts FROM storyboard_batch_tasks
 WHERE batch_id = $1 AND task_id = $2`;

// ── 0054 三视图收口 ─────────────────────────────────────────────────────
// rows 写后把该项目所有已 apply 计划 script 标 dirty 用：先取 DISTINCT script_id
// （计划 = 该项目 script_rows 的投影，rows 一变全体落后），再逐 script markDirty。
const PERSISTED_SCRIPT_IDS_SQL =
  'SELECT DISTINCT script_id FROM project_shots_rows WHERE project_id = $1';
// GET …/storyboard 读侧：某 script「当前持久化计划代」的汇总 —— dirty = 最新
// version 各行是否存在脏标记（旧代 locked 行属钉住的例外，不计入活动代）；
// fingerprint = 最新代共享的计划指纹（同一次 apply 各行同值，MAX 等价取该值），
// 无任何行（从未 apply / 他 script）→ 空结果 → dirty=false、fingerprint=null。
const PERSISTED_PLAN_SUMMARY_SQL = `
SELECT COALESCE(bool_or(dirty), false) AS dirty,
       MAX(plan_fingerprint) AS fingerprint
  FROM project_shots_rows
 WHERE project_id = $1 AND script_id = $2
   AND version = (SELECT MAX(version) FROM project_shots_rows
                   WHERE project_id = $1 AND script_id = $2)`;

function createScriptApi({ pg, sessionUser, sendJSON, parseBody }) {
  // Batch store (0051): one instance per API — createBatch/listTasks/markTask/
  // retryFailed/progress all hit the same injected pg the rows CRUD uses.
  const batchStore = createBatchTaskStore({ pg });

  // GET …/batches/:batchId → tasks keep the documented public shape only.
  function publicTask(t) {
    return {
      taskId: t.taskId,
      shotId: t.shotId,
      kind: t.kind,
      status: t.status,
      attempt: t.attempt,
      maxAttempts: t.maxAttempts,
      resultRef: t.resultRef,
      error: t.error,
    };
  }

  function requireUser(req, res) {
    const user = sessionUser ? sessionUser(req) : null;
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    return user;
  }
  async function requireProject(res, user, projectId) {
    const r = await pg.query(
      `SELECT p.*, w.owner_id AS workspace_owner_id
       FROM projects p JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = $1`,
      [projectId],
    );
    if (!r.rows.length) { sendJSON(res, 404, { ok: false, error: '项目不存在' }); return null; }
    const m = await pg.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [r.rows[0].workspace_id, user.id],
    );
    if (!m.rows.length) { sendJSON(res, 403, { ok: false, error: '无项目权限' }); return null; }
    // Attach membership role so handlers can gate mutating routes (viewer = read-only).
    return { ...r.rows[0], role: m.rows[0].role };
  }

  // Batch existence guard shared by GET …/batches/:batchId and
  // POST …/batches/:batchId/retry-failed. 0051 rows carry no project_id, so an
  // unknown/foreign batchId surfaces here as 404 (ids are unguessable bt-UUIDs
  // minted by createBatch for the requesting project's own script).
  async function loadBatchOr404(res2, batchId) {
    await batchStore.ensureSchema();
    const listed = await batchStore.listTasks(batchId);
    const tasks = listed && listed.ok === true ? listed.tasks : [];
    if (tasks.length === 0) {
      sendJSON(res2, 404, { ok: false, error: '批次不存在' });
      return null;
    }
    return tasks;
  }

  // rows 写（POST/PATCH/PUT order/DELETE）成功后调用（0054 三视图收口）：
  // 计划 = 该项目 script_rows 的投影（storyboardShots 属主模型：script 的内容
  // 载体即该项目 script_rows），任何 rows 写都让该项目全部已 apply 的持久化
  // 计划落后 —— 逐一 markDirty，使 GET …/storyboard 可报 dirty=true（STALE）。
  // 从未 apply（project_shots_rows 无该项目计划行）→ 无事可做。全程 best-effort：
  // 标注失败/0 行（markDirty 404）绝不影响已成功的 rows 写。
  async function markPersistedScriptsDirty(pid) {
    let scripts = [];
    try {
      const r = await pg.query(PERSISTED_SCRIPT_IDS_SQL, [pid]);
      scripts = (r.rows || [])
        .map((x) => x && x.script_id)
        .filter((s) => typeof s === 'string' && s.length > 0);
    } catch (_) { return; }
    for (const scriptId of scripts) {
      try { await markDirty({ pg, projectId: pid, scriptId }); } catch (_) { /* best-effort */ }
    }
  }

  // 0054 共用读取：某 (project, script) 最新代持久化计划的陈旧度。dirty = 最新代
  // 存在 markDirty 脏行（rows 写后置位、apply 落新行即清），或存储指纹 ≠
  // freshFingerprint（现算——rows 结构被绕过 API 直改的兜底）；从未 apply（无
  // 计划行）→ { dirty:false, storedFingerprint:null }。GET plan 视图与 POST batch
  // 前置 dirty 门共用同一计算（同一 PERSISTED_PLAN_SUMMARY_SQL），口径恒一致。
  async function readPlanStaleness(projectId, scriptId, freshFingerprint) {
    const sum = await pg.query(PERSISTED_PLAN_SUMMARY_SQL, [projectId, scriptId]);
    const persistedRow = sum && sum.rows && sum.rows[0] ? sum.rows[0] : null;
    const storedFingerprint = persistedRow && persistedRow.fingerprint != null
      ? String(persistedRow.fingerprint)
      : null;
    const persistedDirty = persistedRow ? !!persistedRow.dirty : false;
    return {
      dirty: persistedDirty
        || (storedFingerprint !== null && storedFingerprint !== freshFingerprint),
      storedFingerprint,
    };
  }

  // POST …/batches/:batchId/tasks/:taskId/retry — single-task partial retry.
  // Only a FAILED row with attempt < max_attempts may be reset to QUEUED
  // (attempt+1, result_ref/error cleared). Rejected otherwise: 404 when the
  // task is unknown, 409 when it exists but is not retryable.
  async function handleRetryTask(res2, batchId, taskId) {
    await batchStore.ensureSchema();
    const r = await pg.query(RETRY_TASK_SQL, [batchId, taskId]);
    if (r && Number(r.rowCount) > 0) {
      return sendJSON(res2, 200, { ok: true, reset: Number(r.rowCount) });
    }
    const cur = await pg.query(READ_TASK_SQL, [batchId, taskId]);
    const row = cur && cur.rows && cur.rows[0];
    if (!row) return sendJSON(res2, 404, { ok: false, error: '任务不存在或不属于该批次' });
    const attempt = Number(row.attempt);
    const max = Number(row.max_attempts);
    const why = row.status === 'FAILED' && attempt >= max
      ? `任务已 FAILED 且 attempt ${attempt} 已达上限 ${max}，不可再重试`
      : `任务状态 ${row.status} 非 FAILED，不可单任务重试`;
    return sendJSON(res2, 409, { ok: false, error: why });
  }

  async function handle(req, res, urlPath, method) {
    // Storyboard routes — GET …/storyboard (plan view), POST …/storyboard/apply
    // (persist), POST …/storyboard/batch (enqueue) and the batch resource
    // subtree …/storyboard/batches/:batchId[…]. Each route answers exactly one
    // method; anything else falls through unhandled (false) to the outer router.
    const storyboard = matchStoryboardRoute(urlPath, req.params || {});
    if (storyboard && method !== storyboard.method) return false;
    const m = urlPath.match(/^\/api\/v2\/script\/rows(?:\/([^/]+))?$/) || urlPath.match(/^\/api\/v2\/script\/order$/);
    if (!m && !storyboard) return false;
    const isOrder = urlPath === '/api/v2/script/order';
    const { projectId } = req.params || {};
    if (!projectId) { sendJSON(res, 400, { ok: false, error: 'projectId 必填' }); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const project = await requireProject(res, user, projectId);
    if (!project) return true;
    // Audit fix (G14 v4pro M1): viewer is read-only — mutating routes need an
    // owner/editor role (PATCH included for script rows). POST …/storyboard/apply
    // is a write → this gate applies; the GET plan view never reaches it.
    const WRITE = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (WRITE.includes(method) && !['owner', 'editor'].includes(project.role)) {
      return sendJSON(res, 403, { ok: false, error: '只读成员不可修改（需 owner/editor）' });
    }

    // Shared storyboard source read: this project's ordered script_rows + the
    // best-effort entity tables used for shot subjectRefs. scriptId ownership =
    // project-scope: a script's content carrier is that project's script_rows
    // (no standalone scripts table before 0045's note), so the SELECT binds
    // project_id in SQL exactly like the row-level ownership checks — no other
    // project's rows can ever leak into a plan (GET or apply). rows 空 → 400.
    async function loadStoryboardContext(res2, pid) {
      const r = await pg.query(
        `SELECT * FROM script_rows WHERE project_id = $1 ORDER BY scene_index ASC, row_index ASC`,
        [pid],
      );
      if (!r.rows.length) {
        return sendJSON(res2, 400, { ok: false, error: '计划需至少 1 行脚本行（该项目暂无 script_rows）' });
      }
      // Best-effort entity sources for shot subjectRefs. Both live in this
      // project's bible tables (0027/0028); a read failure must never break the
      // plan (view or apply), so swallow to [] — subjectRefs then stay
      // row-internal (dialogue speaker only), which is exactly
      // buildStoryboardPlan S4's never-invent rule.
      let characters = [];
      let locations = [];
      try {
        const [ch, loc] = await Promise.all([
          pg.query('SELECT id, name FROM project_characters WHERE project_id = $1', [pid]),
          pg.query('SELECT id, name FROM project_environments WHERE project_id = $1', [pid]),
        ]);
        characters = (ch.rows || []).map((x) => ({ id: x.id, name: x.name }));
        locations = (loc.rows || []).map((x) => ({ id: x.id, name: x.name }));
      } catch (e) {
        characters = [];
        locations = [];
      }
      return {
        // PG returns BIGINT timing_ms as a string — normalize to an int ms.
        rows: r.rows.map((row) => ({
          id: row.id,
          episode_id: row.episode_id,
          scene_index: row.scene_index,
          row_index: row.row_index,
          kind: row.kind,
          speaker: row.speaker,
          text: row.text,
          beat: row.beat,
          timing_ms: row.timing_ms == null ? null : Number(row.timing_ms),
        })),
        characters,
        locations,
      };
    }

    // GET …/storyboard — read-only plan view (any member may read, viewer
    // included). POST …/storyboard/apply — persist: recomputes the SAME
    // server-side plan (rows → buildStoryboardPlan → persistStoryboardShots)
    // and never trusts a client-supplied body, so persisted shots can't be
    // forged or point at rows outside this project. POST …/storyboard/batch —
    // enqueue: same server-side plan, then storyboardBatchPlan turns every
    // shot missing a produced image into one image_gen task row (0051).
    if (storyboard) {
      // ── Batch resource subtree (no scriptId in URL; batchId is a bt-UUID
      // minted by this API for the requesting project's script). ──
      if (storyboard.kind === 'badBatchId') {
        return sendJSON(res, 400, { ok: false, error: '批次/任务 ID 无效' });
      }
      if (storyboard.kind === 'listBatch'
        || storyboard.kind === 'retryBatch'
        || storyboard.kind === 'retryTask') {
        if (storyboard.kind === 'retryTask') return handleRetryTask(res, storyboard.batchId, storyboard.taskId);
        const tasks = await loadBatchOr404(res, storyboard.batchId);
        if (!tasks) return true; // 404 sent
        if (storyboard.kind === 'retryBatch') {
          const r = await batchStore.retryFailed(storyboard.batchId);
          return sendJSON(res, 200, { ok: true, reset: r && r.ok === true ? r.reset : 0 });
        }
        const p = await batchStore.progress(storyboard.batchId);
        const progress = p && p.ok === true
          ? { total: p.total, byStatus: p.byStatus }
          : { total: tasks.length, byStatus: {} };
        return sendJSON(res, 200, {
          ok: true,
          batchId: storyboard.batchId,
          tasks: tasks.map(publicTask),
          progress,
        });
      }
      const scriptId = storyboard.scriptId;
      // ── POST …/storyboard/shots/lock — batch lock/unlock (0052). No rows
      // context needed: target = persisted plan rows only. 200 {ok,locked} on
      // ≥1 hit; no hit (cross-project / never applied / unknown shot) → 404;
      // malformed body → 400; viewer is blocked earlier by the write gate.
      if (storyboard.kind === 'lock') {
        if (!scriptId) return sendJSON(res, 400, { ok: false, error: 'scriptId 必填' });
        const body = (await parseBody(req)) || {};
        const shotIds = body.shotIds;
        const locked = body.locked;
        if (!Array.isArray(shotIds) || shotIds.length === 0
          || shotIds.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
          return sendJSON(res, 400, { ok: false, error: 'shotIds 必填非空字符串数组' });
        }
        if (typeof locked !== 'boolean') {
          return sendJSON(res, 400, { ok: false, error: 'locked 必填布尔' });
        }
        const r = await lockShots({ pg, projectId, scriptId, shotIds, locked });
        if (!r || r.ok !== true) {
          const e = r && r.errors && r.errors[0] ? r.errors[0] : (r && r.error ? r.error : '锁定失败');
          return sendJSON(res, Number.isInteger(r && r.status) ? r.status : 400, { ok: false, error: e });
        }
        if (!Array.isArray(r.updated) || r.updated.length === 0) {
          return sendJSON(res, 404, { ok: false, error: 'shot 不存在或不属于该项目' });
        }
        return sendJSON(res, 200, { ok: true, locked });
      }
      if (!scriptId) return sendJSON(res, 400, { ok: false, error: 'scriptId 必填' });
      const ctx = await loadStoryboardContext(res, projectId);
      if (!ctx || !ctx.rows) return true; // 400 already sent (empty rows / read error)
      const plan = buildStoryboardPlan({
        rows: ctx.rows,
        characters: ctx.characters,
        locations: ctx.locations,
      });
      if (!plan || !Array.isArray(plan.beats)) {
        return sendJSON(res, 400, {
          ok: false,
          errors: plan && Array.isArray(plan.errors) ? plan.errors : ['计划构建失败：脚本行不满足模型校验'],
        });
      }
      if (storyboard.kind === 'createBatch') {
        // ── 前置 dirty 门（batch 一致性收口 ①）── 批量生成只对准「已 apply 且
        // 最新」的计划：最新代 dirty=true（rows 写 markDirty 置位，或存储指纹 ≠
        // 本次现算指纹）⇒ 持久化计划已落后于 script_rows，此刻批量生成会按过期
        // 结构产图 → 409 PLAN_DIRTY 且不建批；先 apply 落新行（dirty 复位 false）
        // 再批量生成。与 GET plan 视图共用 readPlanStaleness —— 报 STALE 与拒批
        // 恒同口径。从未 apply（无计划行 → dirty false）不拦：批量以服务端现算
        // 计划为准（既有语义）。
        const stale = await readPlanStaleness(projectId, scriptId, computePlanFingerprint(plan));
        if (stale.dirty) {
          return sendJSON(res, 409, {
            ok: false,
            error: 'PLAN_DIRTY',
            message: '先 apply 再批量生成',
          });
        }
        // shotImagesByShotId: 当前没有"已产出图"注册表（迁移 0001–0052 无
        // shot→produced-image 表）——传空查找即每个计划 shot 都入队；执行引擎
        // 经 result_ref 记录产出后，后续叶子可接入真实查找让已产出 shot 跳过。
        const bp = storyboardBatchPlan({ beats: plan.beats, shotImagesByShotId: {} });
        if (!bp || bp.ok !== true || !Array.isArray(bp.tasks)) {
          return sendJSON(res, 400, {
            ok: false,
            error: '批次计划构建失败',
            errors: bp && Array.isArray(bp.errors) ? bp.errors : undefined,
          });
        }
        if (bp.tasks.length === 0) {
          return sendJSON(res, 400, { ok: false, error: '计划为空：无待生成的镜头任务（空计划）' });
        }
        // ── locked shot 排除（batch 一致性收口 ②，0052）── locked shot 钉在
        // 旧代（apply 亦跳过覆写/删除），批量生成同样不得为其建任务：建批前查
        // (project, script) 锁定 shot 集合并排除。skippedLocked = 锁定 ∩ 本计划
        // shot（按计划序，只回报本次真正被拦下的）；total 恒为计划 shot 数。
        const lockRes = await pg.query(LOCKED_SHOT_IDS_SQL, [scriptId, projectId]);
        const lockedIds = new Set((lockRes.rows || []).map((r) => String(r.shot_id)));
        const total = bp.counts && Number.isInteger(bp.counts.total) ? bp.counts.total : bp.tasks.length;
        const skippedLocked = lockedIds.size === 0
          ? []
          : bp.tasks.filter((t) => lockedIds.has(t.shotId)).map((t) => t.shotId);
        const tasks = lockedIds.size === 0 ? bp.tasks : bp.tasks.filter((t) => !lockedIds.has(t.shotId));
        // ── 全锁 → 空批（batch 一致性收口 ③，决策：200 而非 409）── 请求合法
        // 只是无可生成内容，不 mint 批次（空批次无任务行、GET 视图无法列出）→
        // 200 { ok:true, batchId:null, enqueued:0, total, skippedLocked:全部,
        // dirty:false }，batchId null 即「空批、无落库任务」的注明。
        if (tasks.length === 0) {
          return sendJSON(res, 200, {
            ok: true,
            batchId: null,
            enqueued: 0,
            total,
            skippedLocked,
            dirty: false,
          });
        }
        const created = await batchStore.createBatch({ scriptId, tasks });
        if (!created || created.ok !== true) {
          const e = created && created.error;
          const reason = e && typeof e.message === 'string'
            ? e.message
            : (e && typeof e.code === 'string' ? e.code : '批次创建失败');
          return sendJSON(res, 500, { ok: false, error: reason });
        }
        return sendJSON(res, 200, {
          ok: true,
          batchId: created.batchId,
          enqueued: created.enqueued,
          total,
          skippedLocked,
          dirty: false,
        });
      }
      if (storyboard.kind === 'apply') {
        const persisted = await persistStoryboardShots({ pg, projectId, scriptId, plan });
        if (!persisted || persisted.ok !== true) {
          const status = persisted && Number.isInteger(persisted.status) ? persisted.status : 400;
          return sendJSON(res, status, {
            ok: false,
            error: persisted && typeof persisted.error === 'string' ? persisted.error : '计划持久化失败',
            errors: persisted && Array.isArray(persisted.errors) ? persisted.errors : undefined,
          });
        }
        return sendJSON(res, 200, {
          ok: true,
          applied: {
            version: persisted.version,
            shotCount: persisted.inserted,
            replaced: persisted.replaced,
          },
        });
      }
      // GET …/storyboard plan view（0054 三视图收口）—— dirty/planFingerprint：
      // dirty = 持久化计划落后于 script_rows —— 该 script 最新代存在 markDirty
      // 脏行（rows 写后置位，apply 落新行即清），或存储指纹 ≠ 本次现算指纹
      // （rows 结构变化而未被 flag 覆盖的兜底）；planFingerprint = 存储的
      // 最新代计划指纹（客户端可自行与现算比较），从未 apply → null。与 batch
      // 前置门共用 readPlanStaleness（见文件头 0054 接线说明）。
      const stale = await readPlanStaleness(projectId, scriptId, computePlanFingerprint(plan));
      return sendJSON(res, 200, {
        ok: true,
        plan: { beats: plan.beats, totalShots: plan.totalShots },
        dirty: stale.dirty,
        planFingerprint: stale.storedFingerprint,
      });
    }

    const id = m && m[1] ? decodeURIComponent(m[1]) : null;

    // PUT /order — reindex rows of one scene in given order
    if (method === 'PUT' && isOrder) {
      const body = (await parseBody(req)) || {};
      const sceneIndex = Number(body.sceneIndex);
      const rowIds = Array.isArray(body.rowIds) ? body.rowIds : [];
      if (!Number.isInteger(sceneIndex) || sceneIndex < 0) return sendJSON(res, 400, { ok: false, error: 'sceneIndex 必须为非负整数' });
      if (!rowIds.length) return sendJSON(res, 400, { ok: false, error: 'rowIds 必填数组' });
      let client = null;
      try {
        client = typeof pg.connect === 'function' ? await pg.connect() : null;
        const q = client || pg;
        if (client) await client.query('BEGIN');
        for (let i = 0; i < rowIds.length; i++) {
          await q.query(
            `UPDATE script_rows SET row_index = $1, updated_at = NOW()
              WHERE id = $2 AND project_id = $3 AND scene_index = $4`,
            [i, rowIds[i], projectId, sceneIndex],
          );
        }
        if (client) await client.query('COMMIT');
        // 0054: rows 写后标脏（best-effort，不阻断已成功的重排）。
        await markPersistedScriptsDirty(projectId);
        return sendJSON(res, 200, { ok: true, reordered: rowIds.length });
      } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        if (client && typeof client.release === 'function') await client.release();
      }
    }

    // PATCH /rows/:id — merge update given columns (validated against the full
    // merged row, so partial payloads can't skip required-field semantics).
    if (method === 'PATCH' && id) {
      const body = (await parseBody(req)) || {};
      const cur = await pg.query(`SELECT * FROM script_rows WHERE id = $1 AND project_id = $2`, [id, projectId]);
      if (!cur.rows.length) return sendJSON(res, 404, { ok: false, error: 'row 不存在或不属于该项目' });
      const existing = cur.rows[0];
      const merged = { ...existing, project_id: projectId };
      const allowed = ['kind', 'speaker', 'text', 'beat', 'timing_ms', 'scene_index', 'row_index', 'continuity_notes', 'episode_id'];
      const sets = [];
      const vals = [];
      for (const k of allowed) {
        if (body[k] !== undefined) {
          // continuity_notes is JSONB: normalize so a pre-encoded JSON string
          // is not double-encoded on the way to the column.
          const v = k === 'continuity_notes' ? normalizeContinuityNotes(body[k]) : body[k];
          merged[k] = v; sets.push(`${k} = $${sets.length + 2}`); vals.push(v);
        }
      }
      if (!sets.length) return sendJSON(res, 400, { ok: false, error: '无更新字段' });
      const check = validateScriptRow({ ...merged, id: existing.id || id || 'row-x' });
      if (!check.ok) return sendJSON(res, 400, { ok: false, errors: check.errors });
      const r = await pg.query(
        `UPDATE script_rows SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING id`,
        [id, projectId, ...vals],
      );
      if (!r.rows.length) return sendJSON(res, 409, { ok: false, error: '并发修改，请重试' });
      // 0054: rows 写后标脏（best-effort，不阻断已成功的 PATCH）。
      await markPersistedScriptsDirty(projectId);
      return sendJSON(res, 200, { ok: true, id });
    }

    // DELETE /rows/:id
    if (method === 'DELETE' && id) {
      const r = await pg.query(`DELETE FROM script_rows WHERE id = $1 AND project_id = $2`, [id, projectId]);
      if (r.rowCount) {
        // 0054: rows 写后标脏（best-effort，不阻断已成功的 DELETE）。
        await markPersistedScriptsDirty(projectId);
      }
      return sendJSON(res, r.rowCount ? 200 : 404, { ok: r.rowCount ? true : false, error: r.rowCount ? undefined : 'row 不存在' });
    }

    // POST /rows — batch insert (validated, auto row_index per scene)
    if (method === 'POST' && !id) {
      const body = (await parseBody(req)) || {};
      const rows = Array.isArray(body.rows) ? body.rows : (body.row ? [body.row] : null);
      if (!rows || !rows.length) return sendJSON(res, 400, { ok: false, error: 'rows 必填数组' });
      const out = [];
      const errors = [];
      for (let i = 0; i < rows.length; i++) {
        const raw = { ...rows[i], project_id: projectId };
        const v = validateScriptRow(raw);
        if (!v.ok) { errors.push({ index: i, errors: v.errors }); continue; }
        const rid = `sr-${crypto.randomUUID()}`;
        const sceneIndex = Number.isInteger(raw.scene_index) ? raw.scene_index : 0;
        const next = await pg.query(
          `SELECT COALESCE(MAX(row_index), -1) AS m FROM script_rows WHERE project_id = $1 AND scene_index = $2`,
          [projectId, sceneIndex],
        );
        const rowIndex = Number.isInteger(raw.row_index) ? raw.row_index : next.rows[0].m + 1;
        const row = {
          id: rid, project_id: projectId, episode_id: raw.episode_id || null,
          scene_index: sceneIndex, row_index: rowIndex,
          kind: raw.kind || 'dialogue', speaker: raw.speaker || null,
          text: String(raw.text || ''), beat: raw.beat || null,
          timing_ms: raw.timing_ms != null ? raw.timing_ms : null,
          continuity_notes: normalizeContinuityNotes(raw.continuity_notes),
        };
        await pg.query(
          `INSERT INTO script_rows (id, project_id, episode_id, scene_index, row_index, kind, speaker, text, beat, timing_ms, continuity_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.project_id, row.episode_id, row.scene_index, row.row_index, row.kind, row.speaker, row.text, row.beat, row.timing_ms, JSON.stringify(row.continuity_notes)],
        );
        out.push(row);
      }
      if (out.length > 0) {
        // 0054: rows 写后标脏（best-effort；至少 1 行真实落库才标）。
        await markPersistedScriptsDirty(projectId);
      }
      return sendJSON(res, errors.length ? 207 : 201, { ok: true, inserted: out, errors });
    }

    // GET /rows/:id
    if (method === 'GET' && id) {
      const r = await pg.query(`SELECT * FROM script_rows WHERE id = $1 AND project_id = $2`, [id, projectId]);
      if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'row 不存在' });
      return sendJSON(res, 200, { ok: true, row: r.rows[0] });
    }

    // GET /rows — all or by scene (scene grouping helper exported for UI)
    if (method === 'GET' && !id) {
      const scene = req.params.scene !== undefined ? Number(req.params.scene) : NaN;
      const where = Number.isInteger(scene) ? ` WHERE project_id = $1 AND scene_index = $2` : ` WHERE project_id = $1`;
      const params = Number.isInteger(scene) ? [projectId, scene] : [projectId];
      const r = await pg.query(
        `SELECT * FROM script_rows${where} ORDER BY scene_index ASC, row_index ASC`, params,
      );
      return sendJSON(res, 200, { ok: true, scenes: buildSceneRows(r.rows), rows: r.rows });
    }

    return false;
  }

  return { handle, batchStore };
}

module.exports = { createScriptApi };
