'use strict';
/**
 * shotLineage.test.cjs — 三视图只读 shot lineage 查询服务测试。
 * 自包含内存 fake pg（无真实 DB、无迁移依赖），按模块 5 条 SELECT 逐句路由，
 * 语义模拟 studio_runs/studio_run_nodes/run_events/project_shots_rows/
 * studio_canvases/studio_canvas_nodes 的投影。覆盖：参数/404 校验、绑定查询、
 * 事件 seq 顺序与节点级过滤、runs 空（无执行快照）、跨项目隔离。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createShotLineage, SQL } = require('./shotLineage.cjs');

const T = '2026-09-01T10:00:00.000Z';

function makeFakeDb({ projects = [], planShots = [], canvases = [], canvasNodes = [], runs = [], runNodes = [], runEvents = [] } = {}) {
  const hasProject = (id) => projects.some((p) => p.id === id);
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      // 1) project 存在性
      if (sql === SQL.PROJECT_SQL) {
        return { rows: hasProject(params[0]) ? [{ id: params[0] }] : [] };
      }
      // 2) plan shot 行（0045）
      if (sql === SQL.PLAN_SHOT_SQL) {
        return { rows: planShots.filter((r) => r.project_id === params[0] && r.shot_id === params[1]) };
      }
      // 3) canvas 绑定：项目内 data.shotId 字符串等值
      if (sql === SQL.BINDINGS_SQL) {
        const projectCanvases = canvases.filter((c) => c.project_id === params[0]);
        const rows = [];
        for (const c of projectCanvases) {
          for (const n of canvasNodes.filter((x) => x.canvas_id === c.id)) {
            if (n.data_json && n.data_json.shotId === params[1]) {
              rows.push({
                canvas_id: c.id,
                is_primary: c.is_primary != null ? c.is_primary : true,
                archived_at: c.archived_at != null ? c.archived_at : null,
                node_id: n.node_id,
                node_type: n.node_type,
              });
            }
          }
        }
        rows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.canvas_id.localeCompare(b.canvas_id) || a.node_id.localeCompare(b.node_id));
        return { rows };
      }
      // 4) runs：快照 join（canvas_id + studio_node_id 对）
      if (sql === SQL.RUNS_SQL) {
        const pairs = JSON.parse(params[1] || '[]'); // [{canvas_id, node_id}]
        const rows = [];
        for (const run of runs) {
          if (run.project_id !== params[0]) continue;
          for (const p of pairs) {
            if (run.canvas_id !== p.canvas_id) continue;
            for (const rn of runNodes) {
              if (rn.run_id === run.id && rn.studio_node_id === p.node_id) {
                rows.push({
                  run_id: run.id,
                  run_status: run.status,
                  created_at: run.created_at,
                  canvas_id: run.canvas_id,
                  run_node_id: rn.id,
                  node_id: rn.studio_node_id,
                  node_status: rn.status,
                });
              }
            }
          }
        }
        rows.sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
          || String(a.run_id).localeCompare(String(b.run_id))
          || String(a.node_id).localeCompare(String(b.node_id)));
        return { rows };
      }
      // 5) run_events（0043）：seq ASC
      if (sql === SQL.EVENTS_SQL) {
        const ids = new Set(params[0] || []);
        const rows = runEvents
          .filter((e) => ids.has(e.run_id))
          .slice()
          .sort((a, b) => a.run_id.localeCompare(b.run_id) || Number(a.seq) - Number(b.seq));
        return { rows };
      }
      throw new Error('unhandled query: ' + sql);
    },
  };
}

function baseFixture(overrides = {}) {
  const f = {
    projects: [{ id: 'proj-a' }, { id: 'proj-b' }],
    planShots: [{
      id: 'psr-1', project_id: 'proj-a', script_id: 'script-1',
      shot_id: 's1:b2:k3', beat_id: 'b2', scene_index: 1, beat_index: 2, shot_index: 3,
      kind: 'standard', intent: 'action',
      subject_refs: [{ entityType: 'character', entityId: 'ch-9', label: 'Alice' }],
      duration_ms: 3000, ordering: 5, version: 2,
      created_at: T, updated_at: T,
    }],
    canvases: [
      { id: 'canvas-a1', project_id: 'proj-a', created_at: T, is_primary: true, archived_at: null },
      { id: 'canvas-b1', project_id: 'proj-b', created_at: T, is_primary: true, archived_at: null },
    ],
    canvasNodes: [
      { canvas_id: 'canvas-a1', node_id: 'node-gen-1', node_type: 'image-generation', data_json: { shotId: 's1:b2:k3' } },
      { canvas_id: 'canvas-b1', node_id: 'node-gen-B', node_type: 'image-generation', data_json: { shotId: 's1:b2:k3' } },
    ],
    runs: [{ id: 'run-1', project_id: 'proj-a', canvas_id: 'canvas-a1', status: 'COMPLETED', created_at: '2026-09-02T08:00:00.000Z' }],
    runNodes: [{ id: 'srn-1', run_id: 'run-1', studio_node_id: 'node-gen-1', status: 'SUCCEEDED' }],
    runEvents: [
      { run_id: 'run-1', seq: 1, type: 'studio.run.started', payload_json: {}, created_at: '2026-09-02T08:00:01.000Z' },
      { run_id: 'run-1', seq: 2, type: 'studio.run_node.started', payload_json: { run_node_id: 'srn-1', studio_node_id: 'node-gen-1', attempt: 1 }, created_at: '2026-09-02T08:00:02.000Z' },
      { run_id: 'run-1', seq: 3, type: 'studio.run_node.succeeded', payload_json: { run_node_id: 'srn-1', studio_node_id: 'node-gen-1', attempt: 1 }, created_at: '2026-09-02T08:00:03.000Z' },
    ],
  };
  for (const [k, v] of Object.entries(overrides || {})) f[k] = v;
  return f;
}

test('factory: requires { pg } with query()', () => {
  assert.throws(() => createShotLineage(), TypeError);
  assert.throws(() => createShotLineage({}), TypeError);
  assert.throws(() => createShotLineage({ pg: { query: 'nope' } }), TypeError);
  const svc = createShotLineage({ pg: makeFakeDb() });
  assert.equal(typeof svc.traceShot, 'function');
});

test('arg/project validation: INVALID_* codes + PROJECT_NOT_FOUND (404)', async () => {
  const svc = createShotLineage({ pg: makeFakeDb() });
  assert.equal((await svc.traceShot({})).error.code, 'INVALID_PROJECT_ID');
  assert.equal((await svc.traceShot({ projectId: 'proj-a' })).error.code, 'INVALID_PLAN_SHOT_ID');
  assert.equal((await svc.traceShot({ projectId: '   ', planShotId: 's1' })).error.code, 'INVALID_PROJECT_ID');
  const missing = await svc.traceShot({ projectId: 'proj-does-not-exist', planShotId: 's1:b2:k3' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'PROJECT_NOT_FOUND'); // 调用方映射 HTTP 404
});

test('project exists but planShot not in its domain → {ok, planShot:null, reason}', async () => {
  const svc = createShotLineage({ pg: makeFakeDb(baseFixture({ planShots: [] })) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's9:z9:k0' });
  assert.equal(r.ok, true);
  assert.equal(r.planShot, null);
  assert.equal(r.reason, 'PLAN_SHOT_NOT_FOUND');
  assert.deepEqual(r.bindings, []);
  assert.deepEqual(r.runs, []);
});

test('planShot row formatted (camelCase, ints, jsonb subjectRefs, ISO ts)', async () => {
  const svc = createShotLineage({ pg: makeFakeDb(baseFixture()) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.planShot, {
    id: 'psr-1', projectId: 'proj-a', scriptId: 'script-1', shotId: 's1:b2:k3', beatId: 'b2',
    sceneIndex: 1, beatIndex: 2, shotIndex: 3, kind: 'standard', intent: 'action',
    subjectRefs: [{ entityType: 'character', entityId: 'ch-9', label: 'Alice' }],
    durationMs: 3000, ordering: 5, version: 2, createdAt: T, updatedAt: T,
  });
});

test('bindings: nodes with data.shotId===planShotId, scoped to project canvases', async () => {
  const svc = createShotLineage({ pg: makeFakeDb(baseFixture()) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.equal(r.ok, true);
  // proj-a 只命中 canvas-a1/node-gen-1；proj-b 的相同 shotId 绑定不泄漏
  assert.deepEqual(r.bindings, [{ canvasId: 'canvas-a1', nodeId: 'node-gen-1', nodeType: 'image-generation' }]);
});

test('bindings with same shotId on multiple canvases of one project (deterministic order)', async () => {
  const db = baseFixture({
    canvases: [
      { id: 'canvas-a1', project_id: 'proj-a', created_at: '2026-08-01T00:00:00.000Z', is_primary: true, archived_at: null },
      { id: 'canvas-a2', project_id: 'proj-a', created_at: '2026-08-02T00:00:00.000Z', is_primary: false, archived_at: null },
    ],
    canvasNodes: [
      { canvas_id: 'canvas-a2', node_id: 'node-gen-2', node_type: 'text-to-video', data_json: { shotId: 's1:b2:k3' } },
      { canvas_id: 'canvas-a1', node_id: 'node-gen-1', node_type: 'image-generation', data_json: { shotId: 's1:b2:k3' } },
      { canvas_id: 'canvas-a1', node_id: 'node-other', node_type: 'output', data_json: { shotId: 'shot-exec-other' } },
    ],
  });
  const svc = createShotLineage({ pg: makeFakeDb(db) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.deepEqual(r.bindings.map((b) => b.canvasId), ['canvas-a1', 'canvas-a2']); // created_at ASC
  assert.equal(r.bindings.length, 2);
});

test('runs empty: binding exists but node was never part of any run snapshot', async () => {
  const db = baseFixture({ runs: [], runNodes: [], runEvents: [] });
  const svc = createShotLineage({ pg: makeFakeDb(db) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.equal(r.ok, true);
  assert.equal(r.bindings.length, 1); // 画布已绑定
  assert.deepEqual(r.runs, []);       // 但无执行快照含该节点
});

test('runs traced via (canvas_id, studio_node_id) snapshot join; node-scoped events in seq order', async () => {
  const db = baseFixture();
  // 同 run 内加一个「其它节点」的事件 + 一个 run 级事件，验证节点级过滤
  db.runEvents.push(
    { run_id: 'run-1', seq: 4, type: 'studio.run_node.started', payload_json: { run_node_id: 'srn-other', studio_node_id: 'node-other', attempt: 1 }, created_at: '2026-09-02T08:00:04.000Z' },
  );
  const svc = createShotLineage({ pg: makeFakeDb(db) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.equal(r.ok, true);
  assert.equal(r.runs.length, 1);
  const run = r.runs[0];
  assert.equal(run.runId, 'run-1');
  assert.equal(run.status, 'COMPLETED');   // run 级状态
  assert.equal(run.nodeStatus, 'SUCCEEDED');
  assert.equal(run.nodeId, 'node-gen-1');  // 追踪的 canvas/run 节点
  // 只有属于 srn-1（payload.run_node_id 或 studio_node_id 命中）的事件，seq 升序
  assert.deepEqual(run.events.map((e) => e.type), ['studio.run_node.started', 'studio.run_node.succeeded']);
  assert.deepEqual(run.events.map((e) => e.seq), [2, 3]);
  assert.equal(run.events[0].ts, '2026-09-02T08:00:02.000Z');
});

test('event ordering: unordered insert still yields seq-ascending output per run; runs newest-first', async () => {
  const db = baseFixture({
    runs: [
      { id: 'run-1', project_id: 'proj-a', canvas_id: 'canvas-a1', status: 'COMPLETED', created_at: '2026-09-01T08:00:00.000Z' },
      { id: 'run-2', project_id: 'proj-a', canvas_id: 'canvas-a1', status: 'FAILED', created_at: '2026-09-03T08:00:00.000Z' },
    ],
    runNodes: [
      { id: 'srn-1', run_id: 'run-1', studio_node_id: 'node-gen-1', status: 'SUCCEEDED' },
      { id: 'srn-2', run_id: 'run-2', studio_node_id: 'node-gen-1', status: 'FAILED' },
    ],
    runEvents: [
      { run_id: 'run-2', seq: 3, type: 'studio.run_node.failed', payload_json: { run_node_id: 'srn-2', studio_node_id: 'node-gen-1', code: 'X', final: true }, created_at: '2026-09-03T08:00:03.000Z' },
      { run_id: 'run-1', seq: 9, type: 'studio.run_node.succeeded', payload_json: { run_node_id: 'srn-1', studio_node_id: 'node-gen-1' }, created_at: '2026-09-01T08:00:09.000Z' },
      { run_id: 'run-2', seq: 1, type: 'studio.run.started', payload_json: {}, created_at: '2026-09-03T08:00:01.000Z' },
      { run_id: 'run-2', seq: 2, type: 'studio.run_node.started', payload_json: { run_node_id: 'srn-2', studio_node_id: 'node-gen-1' }, created_at: '2026-09-03T08:00:02.000Z' },
      { run_id: 'run-1', seq: 1, type: 'studio.run.started', payload_json: {}, created_at: '2026-09-01T08:00:01.000Z' },
      { run_id: 'run-1', seq: 2, type: 'studio.run_node.started', payload_json: { run_node_id: 'srn-1', studio_node_id: 'node-gen-1' }, created_at: '2026-09-01T08:00:02.000Z' },
    ],
  });
  const svc = createShotLineage({ pg: makeFakeDb(db) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.equal(r.runs.length, 2);
  assert.deepEqual(r.runs.map((x) => x.runId), ['run-2', 'run-1']); // created_at DESC
  const r2 = r.runs.find((x) => x.runId === 'run-2');
  assert.deepEqual(r2.events.map((e) => e.seq), [2, 3]); // 节点事件升序；run.started(seq1) 被节点级过滤
  const r1 = r.runs.find((x) => x.runId === 'run-1');
  assert.deepEqual(r1.events.map((e) => e.seq), [2, 9]);
});

test('two canvas nodes bound to the same shotId → two run entries, own events each', async () => {
  const db = baseFixture({
    canvasNodes: [
      { canvas_id: 'canvas-a1', node_id: 'node-img', node_type: 'image-generation', data_json: { shotId: 's1:b2:k3' } },
      { canvas_id: 'canvas-a1', node_id: 'node-vid', node_type: 'text-to-video', data_json: { shotId: 's1:b2:k3' } },
    ],
    runs: [{ id: 'run-1', project_id: 'proj-a', canvas_id: 'canvas-a1', status: 'RUNNING', created_at: '2026-09-02T08:00:00.000Z' }],
    runNodes: [
      { id: 'srn-img', run_id: 'run-1', studio_node_id: 'node-img', status: 'RUNNING' },
      { id: 'srn-vid', run_id: 'run-1', studio_node_id: 'node-vid', status: 'WAITING' },
    ],
    runEvents: [
      { run_id: 'run-1', seq: 1, type: 'studio.run_node.started', payload_json: { run_node_id: 'srn-img', studio_node_id: 'node-img' }, created_at: '2026-09-02T08:00:01.000Z' },
      { run_id: 'run-1', seq: 2, type: 'studio.run_node.started', payload_json: { run_node_id: 'srn-vid', studio_node_id: 'node-vid' }, created_at: '2026-09-02T08:00:02.000Z' },
    ],
  });
  const svc = createShotLineage({ pg: makeFakeDb(db) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.equal(r.runs.length, 2);
  const img = r.runs.find((x) => x.nodeId === 'node-img');
  const vid = r.runs.find((x) => x.nodeId === 'node-vid');
  assert.equal(img.runId, 'run-1');
  assert.equal(vid.runId, 'run-1');
  assert.deepEqual(img.events.map((e) => e.seq), [1]);
  assert.deepEqual(vid.events.map((e) => e.seq), [2]);
});

test('relay gap: run node snapshot exists but run_events empty → events []', async () => {
  const db = baseFixture({ runEvents: [] });
  const svc = createShotLineage({ pg: makeFakeDb(db) });
  const r = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].runId, 'run-1');
  assert.deepEqual(r.runs[0].events, []);
});

test('cross-project isolation: same shotId in A and B traces only the queried project', async () => {
  const db = baseFixture({
    planShots: [
      { id: 'psr-A', project_id: 'proj-a', script_id: 'script-1', shot_id: 's1:b2:k3', beat_id: 'b2', scene_index: 1, beat_index: 2, shot_index: 3, kind: 'standard', intent: 'action', subject_refs: [], duration_ms: 3000, ordering: 0, version: 1, created_at: T, updated_at: T },
      { id: 'psr-B', project_id: 'proj-b', script_id: 'script-B', shot_id: 's1:b2:k3', beat_id: 'b2', scene_index: 1, beat_index: 2, shot_index: 3, kind: 'standard', intent: 'dialogue', subject_refs: [], duration_ms: 2000, ordering: 0, version: 1, created_at: T, updated_at: T },
    ],
    runs: [
      { id: 'run-A', project_id: 'proj-a', canvas_id: 'canvas-a1', status: 'COMPLETED', created_at: '2026-09-02T08:00:00.000Z' },
      { id: 'run-B', project_id: 'proj-b', canvas_id: 'canvas-b1', status: 'RUNNING', created_at: '2026-09-02T09:00:00.000Z' },
    ],
    runNodes: [
      { id: 'srn-A', run_id: 'run-A', studio_node_id: 'node-gen-1', status: 'SUCCEEDED' },
      { id: 'srn-B', run_id: 'run-B', studio_node_id: 'node-gen-B', status: 'RUNNING' },
    ],
    runEvents: [
      { run_id: 'run-A', seq: 1, type: 'studio.run_node.started', payload_json: { run_node_id: 'srn-A', studio_node_id: 'node-gen-1' }, created_at: '2026-09-02T08:00:01.000Z' },
      { run_id: 'run-B', seq: 1, type: 'studio.run_node.started', payload_json: { run_node_id: 'srn-B', studio_node_id: 'node-gen-B' }, created_at: '2026-09-02T09:00:01.000Z' },
    ],
  });
  const svc = createShotLineage({ pg: makeFakeDb(db) });
  const b = await svc.traceShot({ projectId: 'proj-b', planShotId: 's1:b2:k3' });
  assert.equal(b.ok, true);
  assert.equal(b.planShot.id, 'psr-B');
  assert.deepEqual(b.bindings, [{ canvasId: 'canvas-b1', nodeId: 'node-gen-B', nodeType: 'image-generation' }]);
  assert.deepEqual(b.runs.map((x) => x.runId), ['run-B']);
  // A 项目内同 shotId 的绑定/run 不泄漏
  const a = await svc.traceShot({ projectId: 'proj-a', planShotId: 's1:b2:k3' });
  assert.equal(a.planShot.id, 'psr-A');
  assert.deepEqual(a.runs.map((x) => x.runId), ['run-A']);
});
