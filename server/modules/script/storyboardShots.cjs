'use strict';
/**
 * G13 — beats/shots → DB 服务（storyboard 批量绑定，持久化层；不含 HTTP 路由）。
 *
 * persistStoryboardShots({ pg, projectId, scriptId, plan }) 把 storyboardPlan
 * （buildStoryboardPlan 的 { beats, totalShots } 输出，单一真源）逐 beat.shot 落为
 * project_shots_rows（迁移 0045）行。端点挂载（鉴权/角色）由主线在 server.js 完成；
 * 本模块是纯 DB 服务，返回 { ok, ... }，HTTP 语义以 status 字段表达：
 *   200 → { ok:true, projectId, scriptId, version, inserted, replaced, skippedLocked }
 *   400 → { ok:false, status:400, errors:[...] }          （入参/计划形状非法）
 *   404 → { ok:false, status:404, error }                 （项目或 script 不属于该项目）
 *   DB 异常原样抛出（已回滚）。
 *
 * ── script 属 project 校验（决策记录，见迁移 0045 注释）───────────────────
 * 当前 schema（0001–0044）没有独立 scripts 表；0039_script_rows 注释自述
 * "A script becomes an ordered, per-scene set of typed rows" —— script 的内容载体
 * 就是 script_rows（project_id NOT NULL）。因此属主校验在事务内做两层：
 *   1) projects 表存在该 project（否则 404 项目不存在）；
 *   2) plan 每个 beat.scriptRowIds（storyboardPlan 恒产出，全量覆盖其源行）在
 *      script_rows 中按 (project_id, id) 全数命中 —— plan 引用行不属该项目（含
 *      未落库/他项目行）→ 404 script 不存在或不属于该项目。无 scripts 表前这是
 *      唯一可实测的内容级属主证明；scripts 实体落库后仅需替换 SCRIPT_OWNER 查询。
 *
 * ── 幂等 / 版本 ────────────────────────────────────────────────────────
 * 同一 script 重跑：单事务内先 SELECT MAX(version) → nextVersion = +1（1..N），
 * DELETE 该 script 全部 unlocked 旧行（replaced=rowCount），再整体 INSERT 新行
 * （version 相同），COMMIT —— 同 script 重跑原子替换，最终 unlocked 行集恒等于
 * 本次 plan。locked=true 的行保留（DELETE 不命中、覆写被跳过），replaced 与
 * inserted 计数均不含它们，persist 返回 skippedLocked=[锁定 shot_id 列表]。
 *
 * ── 事务 ───────────────────────────────────────────────────────────────
 * pg.connect 存在时（node-postgres Pool/Client）取专属 client，BEGIN…COMMIT/
 * ROLLBACK 并 release；否则退回在 pg 上直接执行（与 scriptApi PUT /order 同款
 * 约定）—— 生产挂载请传暴露 connect() 的 pg，保证 DELETE+INSERT 原子。
 */

const INTENTS = new Set(['dialogue', 'reaction', 'action']); // G13 S2/S3 intent 枚举
// 事务级咨询锁：串行化同一 (project_id, script_id) 的并发 apply。MAX(version)+1 是
// 读-改-写，两请求同 script 并发会同时读到 MAX=N、都算 N+1，随后 DELETE+INSERT 撞上
// UNIQUE(script_id, shot_id)（或 version 丢失更新）。此锁让第二个 apply 阻塞到第一个
// COMMIT 后再读 MAX=N+1 → N+2，竞态消除。hashtext 碰撞仅导致无谓串行，绝不破坏正确性。
const LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';
const OWNER_PROJECT_SQL = 'SELECT 1 AS ok FROM projects WHERE id = $1';
const OWNER_ROWS_SQL = 'SELECT id FROM script_rows WHERE project_id = $1 AND id = ANY($2::text[])';
const MAX_VERSION_SQL =
  'SELECT COALESCE(MAX(version), 0)::int AS v FROM project_shots_rows WHERE script_id = $1 AND project_id = $2';
// locked 行保留：先查锁定 shot_id 用于跳过覆写；DELETE 只作用于 unlocked 行。
const LOCKED_SHOT_IDS_SQL =
  'SELECT shot_id FROM project_shots_rows WHERE script_id = $1 AND project_id = $2 AND locked = true';
const DELETE_UNLOCKED_SQL =
  'DELETE FROM project_shots_rows WHERE script_id = $1 AND project_id = $2 AND locked = false';
const INSERT_SHOT_SQL =
  `INSERT INTO project_shots_rows
     (project_id, script_id, shot_id, beat_id, scene_index, beat_index,
      shot_index, kind, intent, subject_refs, duration_ms, ordering, version,
      locked, source_trace)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;
// 锁定/解锁（lockShot/lockShots/setLocked）：按 (project_id, script_id, shot_id)
// 作用域更新 locked —— 跨项目/不存在 → 0 行 → 404。
const SET_LOCKED_SQL =
  `UPDATE project_shots_rows SET locked = $4, updated_at = NOW()
   WHERE script_id = $1 AND shot_id = $2 AND project_id = $3
   RETURNING shot_id, locked`;
const SET_LOCKED_BATCH_SQL =
  `UPDATE project_shots_rows SET locked = $4, updated_at = NOW()
   WHERE script_id = $1 AND project_id = $2 AND shot_id = ANY($3::text[])
   RETURNING shot_id`;
// 不可变时间戳语义：appliedAtMs 固定值，apply 输出确定（不随系统时钟漂移）。
const APPLIED_AT_MS = 0;

/** 非空字符串判定。 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
/** 非负整数判定。 */
function isNonNegativeInt(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * 校验入参 + 计划形状。成功 → { ok:true, refs }（refs = 全部去重 scriptRowIds）；
 * 失败 → { ok:false, status:400, errors }。纯函数，无 I/O。
 */
function validatePersistArgs({ pg, projectId, scriptId, plan }) {
  const errors = [];
  if (!pg || typeof pg.query !== 'function') errors.push('pg (query) required');
  if (!isNonEmptyString(projectId)) errors.push('projectId must be a non-empty string');
  if (!isNonEmptyString(scriptId)) errors.push('scriptId must be a non-empty string');
  if (plan == null || typeof plan !== 'object' || Array.isArray(plan)) {
    errors.push('plan object { beats } required');
  } else {
    const beats = plan.beats;
    if (!Array.isArray(beats) || beats.length === 0) {
      errors.push('plan.beats must be a non-empty array');
    } else {
      beats.forEach((beat, bi) => {
        if (beat == null || typeof beat !== 'object' || Array.isArray(beat)) {
          errors.push(`beats[${bi}]: beat object required`);
          return;
        }
        if (!isNonEmptyString(beat.beatId)) errors.push(`beats[${bi}]: beatId required`);
        if (!isNonNegativeInt(beat.sceneIndex)) errors.push(`beats[${bi}]: sceneIndex must be a non-negative integer`);
        if (!isNonNegativeInt(beat.beatIndex)) errors.push(`beats[${bi}]: beatIndex must be a non-negative integer`);
        if (!Array.isArray(beat.scriptRowIds) || beat.scriptRowIds.length === 0
            || beat.scriptRowIds.some((r) => !isNonEmptyString(r))) {
          errors.push(`beats[${bi}]: scriptRowIds must be a non-empty array of row ids (storyboardPlan output)`);
        }
        if (!Array.isArray(beat.shots) || beat.shots.length === 0) {
          errors.push(`beats[${bi}]: shots must be a non-empty array`);
          return;
        }
        beat.shots.forEach((shot, si) => {
          const p = `beats[${bi}].shots[${si}]`;
          if (shot == null || typeof shot !== 'object' || Array.isArray(shot)) {
            errors.push(`${p}: shot object required`);
            return;
          }
          if (!isNonEmptyString(shot.shotId)) errors.push(`${p}: shotId required`);
          if (!isNonEmptyString(shot.beatId)) errors.push(`${p}: beatId required`);
          else if (shot.beatId !== beat.beatId) errors.push(`${p}: beatId ${JSON.stringify(shot.beatId)} must equal beat beatId ${JSON.stringify(beat.beatId)}`);
          if (!isNonNegativeInt(shot.shotIndex)) errors.push(`${p}: shotIndex must be a non-negative integer`);
          if (typeof shot.intent !== 'string' || !INTENTS.has(shot.intent)) {
            errors.push(`${p}: intent must be one of ${[...INTENTS].join(', ')}`);
          }
          if (shot.durationMs !== undefined && shot.durationMs !== null
              && !(Number.isInteger(shot.durationMs) && shot.durationMs >= 0)) {
            errors.push(`${p}: durationMs must be a non-negative integer of milliseconds`);
          }
          if (shot.subjectRefs !== undefined && shot.subjectRefs !== null
              && !Array.isArray(shot.subjectRefs)) {
            errors.push(`${p}: subjectRefs must be an array`);
          }
        });
      });
      // shot_id 去重：UNIQUE(script_id, shot_id) 前提下重复必炸，提前 400 报错
      const seen = new Set();
      for (const beat of beats) {
        for (const shot of beat.shots || []) {
          if (shot && isNonEmptyString(shot.shotId)) {
            if (seen.has(shot.shotId)) errors.push(`duplicate shotId ${JSON.stringify(shot.shotId)} in plan`);
            seen.add(shot.shotId);
          }
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, status: 400, errors };
  const refs = [...new Set(plan.beats.flatMap((b) => b.scriptRowIds))];
  return { ok: true, refs };
}

/**
 * 纯函数：把 plan 拍平成 project_shots_rows 的 INSERT 参数行。
 * ordering = 全 script 扁平序（按 beats 数组序 × shots 数组序，0..N-1）。
 */
function buildShotRows({ plan, projectId, scriptId, version }) {
  const rows = [];
  let ordering = 0;
  for (const beat of plan.beats) {
    for (const shot of beat.shots) {
      const subjectRefs = Array.isArray(shot.subjectRefs) ? shot.subjectRefs : [];
      const kind = typeof shot.kind === 'string' && shot.kind !== '' ? shot.kind : 'standard';
      const durationMs = Number.isInteger(shot.durationMs) ? shot.durationMs : 3000;
      rows.push({
        project_id: projectId,
        script_id: scriptId,
        shot_id: shot.shotId,
        beat_id: shot.beatId,
        scene_index: beat.sceneIndex,
        beat_index: beat.beatIndex,
        shot_index: shot.shotIndex,
        kind,
        intent: shot.intent,
        subject_refs: subjectRefs, // 由调用方 JSON.stringify 后绑定 $10
        duration_ms: durationMs,
        ordering,
        version,
        locked: false, // 新行恒为未锁定；锁定只经 lockShot/lockShots 置位
        source_trace: {
          scriptRowIds: beat.scriptRowIds,
          sceneIndex: beat.sceneIndex,
          beatIndex: beat.beatIndex,
          shotIndex: shot.shotIndex,
          appliedAtMs: APPLIED_AT_MS, // 固定值 — 不可变时间戳语义
        },
      });
      ordering += 1;
    }
  }
  return rows;
}

/** BEGIN/COMMIT/ROLLBACK/release 包装；pg 无 connect 时直接执行（不退化为假事务）。 */
async function withTx(pg, fn) {
  const client = typeof pg.connect === 'function' ? await pg.connect() : null;
  const q = client || pg;
  let begun = false;
  try {
    if (client) { await q.query('BEGIN'); begun = true; }
    const result = await fn(q);
    if (client) await q.query('COMMIT');
    return result;
  } catch (e) {
    if (begun) await q.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (client && typeof client.release === 'function') await client.release();
  }
}

/**
 * 持久化一个 storyboard plan 的 beats/shots 到 project_shots_rows。
 * @returns 见文件头返回约定。
 */
async function persistStoryboardShots({ pg, projectId, scriptId, plan }) {
  const check = validatePersistArgs({ pg, projectId, scriptId, plan });
  if (!check.ok) return check;
  const { refs } = check;

  let result;
  try {
    result = await withTx(pg, async (q) => {
      // 0) 串行化同 script 并发 apply（见 LOCK_SQL 注释）——必须在 MAX(version) 读前取锁。
      await q.query(LOCK_SQL, [projectId, scriptId]);
      // 1) project 存在（否则 404）
      const project = await q.query(OWNER_PROJECT_SQL, [projectId]);
      if (!project.rows || project.rows.length === 0) {
        throw Object.assign(new Error('项目不存在'), { status: 404 });
      }
      // 2) script 属 project：plan 引用的源行必须全数属于该项目（script_rows = script 内容载体）
      const owned = await q.query(OWNER_ROWS_SQL, [projectId, refs]);
      const ownedSet = new Set((owned.rows || []).map((r) => String(r.id)));
      if (!refs.every((r) => ownedSet.has(String(r)))) {
        throw Object.assign(new Error('script 不存在或不属于该项目'), { status: 404 });
      }
    // 3) 版本号 = 1..N（同 script 重跑递增）
    const ver = await q.query(MAX_VERSION_SQL, [scriptId, projectId]);
    const version = (ver.rows && ver.rows[0] && ver.rows[0].v != null ? Number(ver.rows[0].v) : 0) + 1;
    // 4) 锁定 shot 保留：先查锁定 shot_id；DELETE 仅删 unlocked 行（replaced 不含 locked）。
    const lockedRes = await q.query(LOCKED_SHOT_IDS_SQL, [scriptId, projectId]);
    const skippedLocked = (lockedRes.rows || []).map((r) => String(r.shot_id));
    const lockedSet = new Set(skippedLocked);
    const del = await q.query(DELETE_UNLOCKED_SQL, [scriptId, projectId]);
    const replaced = del && Number.isInteger(del.rowCount) ? del.rowCount : 0;

    // 覆写跳过 locked shot_id（其行保留），inserted / replaced 均不含它们。
    const rows = buildShotRows({ plan, projectId, scriptId, version })
      .filter((row) => !lockedSet.has(row.shot_id));
    for (const row of rows) {
      await q.query(INSERT_SHOT_SQL, [
        row.project_id, row.script_id, row.shot_id, row.beat_id,
        row.scene_index, row.beat_index, row.shot_index, row.kind,
        row.intent, JSON.stringify(row.subject_refs), row.duration_ms,
        row.ordering, row.version, row.locked,
        JSON.stringify(row.source_trace),
      ]);
    }
    return { ok: true, projectId, scriptId, version, inserted: rows.length, replaced, skippedLocked };
    });
  } catch (e) {
    if (e && Number.isInteger(e.status)) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
  return result;
}

/**
 * 单个 shot 锁定/解锁（显式布尔置位）。按 (project_id, script_id, shot_id)
 * 作用域更新 —— 跨项目/不存在 → 0 行 → 404。纯 DB 服务，与 persist 同款返回约定。
 * @returns { ok:true, projectId, scriptId, shotId, locked }
 *        | { ok:false, status:404, error } | { ok:false, status:400, errors }
 */
async function setLocked({ pg, projectId, scriptId, shotId, locked }) {
  if (!pg || typeof pg.query !== 'function') return { ok: false, status: 400, errors: ['pg (query) required'] };
  if (!isNonEmptyString(projectId)) return { ok: false, status: 400, errors: ['projectId must be a non-empty string'] };
  if (!isNonEmptyString(scriptId)) return { ok: false, status: 400, errors: ['scriptId must be a non-empty string'] };
  if (!isNonEmptyString(shotId)) return { ok: false, status: 400, errors: ['shotId must be a non-empty string'] };
  if (typeof locked !== 'boolean') return { ok: false, status: 400, errors: ['locked must be a boolean'] };
  const r = await pg.query(SET_LOCKED_SQL, [scriptId, shotId, projectId, locked]);
  if (!r.rows || r.rows.length === 0) {
    return { ok: false, status: 404, error: 'shot 不存在或不属于该项目' };
  }
  return { ok: true, projectId, scriptId, shotId, locked: !!r.rows[0].locked };
}

/** 单 shot 锁定/解锁（setLocked 别名，布尔置位）。 */
async function lockShot(args) {
  return setLocked(args);
}

/** 批量锁定/解锁：同一 script 下多个 shot_id 一次置位；部分命中只回命中集。 */
async function lockShots({ pg, projectId, scriptId, shotIds, locked }) {
  if (!pg || typeof pg.query !== 'function') return { ok: false, status: 400, errors: ['pg (query) required'] };
  if (!isNonEmptyString(projectId)) return { ok: false, status: 400, errors: ['projectId must be a non-empty string'] };
  if (!isNonEmptyString(scriptId)) return { ok: false, status: 400, errors: ['scriptId must be a non-empty string'] };
  if (!Array.isArray(shotIds) || shotIds.length === 0 || shotIds.some((s) => !isNonEmptyString(s))) {
    return { ok: false, status: 400, errors: ['shotIds must be a non-empty array of shot ids'] };
  }
  if (typeof locked !== 'boolean') return { ok: false, status: 400, errors: ['locked must be a boolean'] };
  const r = await pg.query(SET_LOCKED_BATCH_SQL, [scriptId, projectId, shotIds, locked]);
  const updated = (r.rows || []).map((row) => String(row.shot_id));
  return { ok: true, projectId, scriptId, updated, locked };
}

module.exports = {
  persistStoryboardShots,
  validatePersistArgs,
  buildShotRows,
  setLocked,
  lockShot,
  lockShots,
  SQL: { LOCK_SQL, OWNER_PROJECT_SQL, OWNER_ROWS_SQL, MAX_VERSION_SQL, LOCKED_SHOT_IDS_SQL, DELETE_UNLOCKED_SQL, INSERT_SHOT_SQL, SET_LOCKED_SQL, SET_LOCKED_BATCH_SQL },
};
