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
 *          read; owner/editor not required).
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
 *          Success 200 { ok:true, batchId, enqueued, total }.
 *   GET    /api/v2/script/storyboard/batches/:batchId   batch view (tasks +
 *          progress). Read follows GET /rows (viewer may read).
 *   POST   /api/v2/script/storyboard/batches/:batchId/retry-failed   batch-wide
 *          retry: resets every FAILED task with attempt < max_attempts →
 *          200 { ok:true, reset }.
 *   POST   /api/v2/script/storyboard/batches/:batchId/tasks/:taskId/retry
 *          single-task retry (only FAILED && attempt < max_attempts) →
 *          200 { ok:true, reset:1 }; non-retryable → 409; missing → 404.
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
const { persistStoryboardShots } = require('./storyboardShots.cjs');
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
 *   'retryTask' (POST). scriptId may be null when spelling B omits it (the
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
  // A) path-form plan view / apply / batch create — :scriptId segment in path.
  const pm = /^\/api\/v2\/script\/([^/]+)\/storyboard(?:\/(apply|batch))?$/.exec(urlPath);
  if (pm && pm[1] !== 'rows' && pm[1] !== 'order') {
    const sid = decodeSegment(pm[1]);
    const verb = pm[2];
    if (verb === 'apply') return { kind: 'apply', method: 'POST', scriptId: sid };
    if (verb === 'batch') return { kind: 'createBatch', method: 'POST', scriptId: sid };
    return { kind: 'plan', method: 'GET', scriptId: sid };
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
        const created = await batchStore.createBatch({ scriptId, tasks: bp.tasks });
        if (!created || created.ok !== true) {
          const e = created && created.error;
          const reason = e && typeof e.message === 'string'
            ? e.message
            : (e && typeof e.code === 'string' ? e.code : '批次创建失败');
          return sendJSON(res, 500, { ok: false, error: reason });
        }
        const total = bp.counts && Number.isInteger(bp.counts.total) ? bp.counts.total : bp.tasks.length;
        return sendJSON(res, 200, {
          ok: true,
          batchId: created.batchId,
          enqueued: created.enqueued,
          total,
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
      return sendJSON(res, 200, { ok: true, plan: { beats: plan.beats, totalShots: plan.totalShots } });
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
      return sendJSON(res, 200, { ok: true, id });
    }

    // DELETE /rows/:id
    if (method === 'DELETE' && id) {
      const r = await pg.query(`DELETE FROM script_rows WHERE id = $1 AND project_id = $2`, [id, projectId]);
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
