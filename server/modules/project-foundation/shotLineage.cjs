'use strict';
/**
 * shotLineage.cjs — 三视图只读 lineage 查询服务（叶：shot lineage trace）。
 * traceShot({ projectId, planShotId }) 沿「计划 shot → canvas 绑定 → run 快照 → run 事件」
 * 链回放一个计划镜头的执行足迹。纯只读：本模块不建表、不写库、无 schema 自举
 * （依赖迁移 0015 / 0043 / 0045 已跑），工厂注入 pg（{ query }）——与
 * runEventStore.cjs / budgetSpentStore.cjs 同款 DI 形状。
 *
 * ── 真实链接点（读迁移 + 引擎/relay 源码得出，非猜测）────────────────────
 *   1. plan shot : project_shots_rows（0045）。project_id + shot_id 定位计划镜头行，
 *      shot_id 为 storyboardPlan shotId（'s{scene}:b{beat}:k{shot}'）。
 *   2. bindings  : studio_canvas_nodes.data_json->>'shotId' === planShotId 的字符串等值
 *      join（画布按 project_id 归域）。没有 FK/列把计划 shot 指向 canvas 节点——
 *      W2-06 接线后 canvas PATCH 权威校验把 data.shotId 语义钉在执行 shot
 *      （shots.id，'shot-…'），计划格式 id 会被 409；故严格部署里用 planShotId 追
 *      绑定可能为空。这是三视图 §1.5 标记的「计划→执行绑定列缺失」缺口（规划叶4），
 *      本查询如实按字符串等值实现，不臆造映射。
 *   3. runs      : studio_run_nodes 没有 shot_id 列（0015 表结构无）。实际可连点是
 *      studio_runs.canvas_id = 绑定画布 AND studio_run_nodes.studio_node_id = 绑定
 *      nodeId（0015 注释与 studioRunEngine.createRunFromCanvas 均确认 studio_node_id
 *      = 编译时 canvas node_id；W2-08 编译快照携带 lineage id）。canvas 节点 → run
 *      节点之间无 FK：本查询只回放「该节点被纳入快照的 run」；节点入画布前的历史 run
 *      或画布漂移后的 run 天然不在结果里（快照不可变语义）。
 *   4. events    : run_events（0043，PK (run_id, seq)），seq ASC 单调。节点身份由
 *      studioRunEngine.emitEvent 的 relay 桥折叠进 payload_json.run_node_id（=srn PK）
 *      与 payload_json.studio_node_id（=canvas node id）；节点级过滤按二者任一命中。
 *
 * ── 链路缺口（如实注释，runs/events 为空时据此判读）────────────────────────
 *   · 引擎以无 relay（deps.relay 缺省）部署时，事件只落 studio_run_events（0015，
 *     无人读回的表）而不落 run_events → runs[].events 为空。
 *   · 计划镜头行存在但无画布节点绑定（L2→L3 断，叶4 前置未做）→ bindings 为空，
 *     链路在此截断。
 *   · run 的 payload 若从未折叠 run_node_id/studio_node_id（早期数据/第三方写），
 *     节点级事件过滤不到 → 该 run 的 events 为空但 run 仍在列表里（runId/status/
 *     nodeId 来自快照表，可靠）。
 */

const PROJECT_SQL = 'SELECT id FROM projects WHERE id = $1';

const PLAN_SHOT_SQL = `
SELECT id, project_id, script_id, shot_id, beat_id,
       scene_index, beat_index, shot_index, kind, intent,
       subject_refs, duration_ms, ordering, version, created_at, updated_at
  FROM project_shots_rows
 WHERE project_id = $1 AND shot_id = $2`;

const BINDINGS_SQL = `
SELECT c.id AS canvas_id, c.is_primary, c.archived_at,
       n.node_id AS node_id, n.node_type AS node_type
  FROM studio_canvas_nodes n
  JOIN studio_canvases c ON c.id = n.canvas_id
 WHERE c.project_id = $1 AND n.data_json->>'shotId' = $2
 ORDER BY c.created_at ASC, c.id ASC, n.node_id ASC`;

const RUNS_SQL = `
SELECT r.id AS run_id, r.status AS run_status, r.created_at,
       r.canvas_id AS canvas_id,
       srn.id AS run_node_id, srn.studio_node_id AS node_id,
       srn.status AS node_status
  FROM studio_runs r
  JOIN studio_run_nodes srn ON srn.run_id = r.id
  JOIN jsonb_to_recordset($2::jsonb) AS b (canvas_id text, node_id text)
    ON b.canvas_id = r.canvas_id AND b.node_id = srn.studio_node_id
 WHERE r.project_id = $1
 ORDER BY r.created_at DESC, r.id ASC, srn.studio_node_id ASC`;

const EVENTS_SQL = `
SELECT run_id, seq, type, payload_json, created_at
  FROM run_events
 WHERE run_id = ANY($1::text[])
 ORDER BY run_id ASC, seq ASC`;

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function err(code, message) { return { ok: false, error: { code, message } }; }
function parseJson(v) {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return []; } }
  return v;
}
function toIso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function formatPlanShot(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    shotId: row.shot_id,
    beatId: row.beat_id,
    sceneIndex: toInt(row.scene_index),
    beatIndex: toInt(row.beat_index),
    shotIndex: toInt(row.shot_index),
    kind: row.kind,
    intent: row.intent,
    subjectRefs: parseJson(row.subject_refs),
    durationMs: toInt(row.duration_ms),
    ordering: toInt(row.ordering),
    version: toInt(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * 节点级事件过滤：run 的事件属于该 run 里被追踪的节点，当且仅当 payload 折叠的
 * run_node_id（=studio_run_nodes.id，srn PK）或 studio_node_id（=canvas node_id）
 * 命中该条目。run 级事件（无节点身份）不进入任何节点的 events。
 */
function eventMatchesNode(payload, entry) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return (p.run_node_id != null && p.run_node_id === entry.runNodeId)
    || (p.studio_node_id != null && p.studio_node_id === entry.nodeId);
}

function createShotLineage({ pg }) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createShotLineage: { pg } with query() required');
  }

  /**
   * 追踪一个计划镜头的 lineage。
   * @param {{projectId:string, planShotId:string}} params
   * @returns {Promise<
   *   {ok:true, projectId:string, planShot:object,
   *    bindings:Array<{canvasId,nodeId,nodeType}>, runs:Array<...>}
   *   | {ok:true, planShot:null, reason:'PLAN_SHOT_NOT_FOUND', bindings:[], runs:[]}
   *   | {ok:false, error:{code,message}}>}
   *   error.code 语义：PROJECT_NOT_FOUND → 调用方映射 HTTP 404；INVALID_* → 400。
   *   planShot:null + reason → 项目存在但项目域内无该 planShot（可能属于其它项目），
   *   非错误，按 {ok:true} 返回。
   */
  async function traceShot({ projectId, planShotId } = {}) {
    if (!isNonEmptyString(projectId)) {
      return err('INVALID_PROJECT_ID', 'projectId (non-empty string) required');
    }
    if (!isNonEmptyString(planShotId)) {
      return err('INVALID_PLAN_SHOT_ID', 'planShotId (non-empty string) required');
    }

    // 1) 项目存在性（404 语义）。
    const pr = await pg.query(PROJECT_SQL, [projectId]);
    if (!pr || !pr.rows || !pr.rows.length) {
      return err('PROJECT_NOT_FOUND', `project ${projectId} not found`);
    }

    // 2) 项目域内的计划镜头行。
    const psr = await pg.query(PLAN_SHOT_SQL, [projectId, planShotId]);
    if (!psr || !psr.rows || !psr.rows.length) {
      return { ok: true, planShot: null, reason: 'PLAN_SHOT_NOT_FOUND', bindings: [], runs: [] };
    }
    const planShot = formatPlanShot(psr.rows[0]);

    // 3) canvas 绑定：data.shotId === planShotId（字符串等值，见文件头缺口说明）。
    const br = await pg.query(BINDINGS_SQL, [projectId, planShotId]);
    const bindings = ((br && br.rows) || []).map((r) => ({
      canvasId: r.canvas_id,
      nodeId: r.node_id,
      nodeType: r.node_type,
    }));
    if (!bindings.length) {
      // 无绑定节点：链路在 L2→L3 截断（无 canvas 节点把计划镜头带上执行图）。
      return { ok: true, planShot, bindings: [], runs: [] };
    }

    // 4) runs：快照 join（canvas_id + studio_node_id）。studio_run_nodes 无 shot_id 列，
    //    该 join 是 DB 里唯一真实可连点（见文件头）。无匹配 → runs 为空列表（节点从未
    //    被纳入任何 run 快照）。
    const bindingPairs = bindings.map((b) => ({ canvas_id: b.canvasId, node_id: b.nodeId }));
    const rr = await pg.query(RUNS_SQL, [projectId, JSON.stringify(bindingPairs)]);
    const runRows = (rr && rr.rows) || [];
    if (!runRows.length) {
      return { ok: true, planShot, bindings, runs: [] };
    }

    // 5) run 事件（run_events, seq ASC）。若引擎无 relay，此表无行 → events 为空。
    const runIds = Array.from(new Set(runRows.map((r) => r.run_id)));
    const er = await pg.query(EVENTS_SQL, [runIds]);
    const eventsByRun = new Map();
    for (const row of ((er && er.rows) || [])) {
      if (!eventsByRun.has(row.run_id)) eventsByRun.set(row.run_id, []);
      eventsByRun.get(row.run_id).push({
        seq: toInt(row.seq),
        type: row.type,
        ts: toIso(row.created_at),
        _payload: parseJson(row.payload_json),
      });
    }

    const runs = [];
    for (const r of runRows) {
      const entry = {
        runId: r.run_id,
        status: r.run_status,
        nodeId: r.node_id,
        runNodeId: r.run_node_id, // studio_run_nodes PK（srn-…），内部过滤键，也外露供审计
        nodeStatus: r.node_status,
        createdAt: toIso(r.created_at),
      };
      const events = (eventsByRun.get(r.run_id) || [])
        .filter((e) => eventMatchesNode(e._payload, entry))
        .map((e) => ({ seq: e.seq, type: e.type, ts: e.ts }));
      runs.push({ runId: entry.runId, status: entry.status, nodeId: entry.nodeId, nodeStatus: entry.nodeStatus, createdAt: entry.createdAt, events });
    }

    return { ok: true, planShot, bindings, runs };
  }

  return { traceShot };
}

module.exports = {
  createShotLineage,
  SQL: { PROJECT_SQL, PLAN_SHOT_SQL, BINDINGS_SQL, RUNS_SQL, EVENTS_SQL },
};
