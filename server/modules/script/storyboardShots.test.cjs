'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  persistStoryboardShots,
  validatePersistArgs,
  buildShotRows,
} = require('./storyboardShots.cjs');
const { buildStoryboardPlan } = require('./storyboardPlan.cjs');

// ------------------------------------------------------------------ helpers
let RSEQ = 0;
/** Script row shorthand with a stable id (storyboardPlan needs id for refs). */
function R(kind, text, over = {}) {
  const row = { id: `row-${(RSEQ += 1)}`, scene_index: 0, kind, text, ...over };
  if (kind === 'dialogue') row.speaker = over.speaker || 'MAYA';
  return row;
}
const D = (speaker, text, over = {}) => R('dialogue', text, { speaker, ...over });
const A = (text, over = {}) => R('action', text, over);
const SD = (text, over = {}) => R('shot_direction', text, over);

const MAYA = { id: 'char-maya', name: 'MAYA' };

/** 2 场景 fixture：s0 一段对白（主语+反打），s1 一段动作 → 2 beats / 4 shots。 */
function samplePlan() {
  const rows = [
    D('MAYA', 'I never sent it.', { scene_index: 0, row_index: 0 }),
    D('LEO', 'Then who did?', { scene_index: 0, row_index: 1 }),
    A('The door opens.', { scene_index: 1, row_index: 0 }),
  ];
  const plan = buildStoryboardPlan({ rows, characters: [MAYA] });
  assert.equal(plan.ok, undefined);
  assert.equal(plan.totalShots, 4);
  return { plan, rows };
}

/**
 * 有状态 fake pg：模拟 projects / script_rows / project_shots_rows 语义，
 * 支持 connect() 专属 client（记录 BEGIN/COMMIT/ROLLBACK）与直连两种路径。
 * opts.ownerRowsOf = 哪些 project 拥有源行（默认 p-1）；opts.failAt = 第 N 条
 * INSERT 抛错（1 起）；opts.projectExists 控制项目存在性。
 */
function makePg(opts = {}) {
  const ownerRowsOf = opts.ownerRowsOf || ['p-1'];
  const projectExists = opts.projectExists !== false;
  const failAt = opts.failAt || 0;
  const state = { shots: [], log: [], insertCount: 0, released: 0, rollbacks: 0 };
  let snapshot = null;

  function handle(sql, params = []) {
    if (sql === 'BEGIN') { snapshot = JSON.parse(JSON.stringify(state.shots)); state.log.push('BEGIN'); return { rows: [] }; }
    if (sql === 'COMMIT') { state.log.push('COMMIT'); return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      state.log.push('ROLLBACK'); state.rollbacks += 1;
      if (snapshot) state.shots = JSON.parse(JSON.stringify(snapshot)); // 模拟事务回滚
      return { rows: [] };
    }
    if (/SELECT 1 AS ok FROM projects WHERE id = \$1/.test(sql)) {
      state.log.push('owner-project');
      return { rows: projectExists ? [{ ok: 1 }] : [] };
    }
    if (/SELECT id FROM script_rows WHERE project_id = \$1 AND id = ANY/.test(sql)) {
      state.log.push('owner-rows');
      const owned = ownerRowsOf.includes(params[0]);
      return { rows: owned ? params[1].map((id) => ({ id })) : [] };
    }
    if (/COALESCE\(MAX\(version\), 0\)/.test(sql)) {
      state.log.push('max-version');
      const v = state.shots
        .filter((s) => s.script_id === params[0] && s.project_id === params[1])
        .reduce((m, s) => Math.max(m, s.version), 0);
      return { rows: [{ v }] };
    }
    if (/DELETE FROM project_shots_rows WHERE script_id = \$1/.test(sql)) {
      state.log.push('delete');
      const before = state.shots.length;
      state.shots = state.shots.filter(
        (s) => !(s.script_id === params[0] && s.project_id === params[1]),
      );
      return { rowCount: before - state.shots.length };
    }
    if (/INSERT INTO project_shots_rows/.test(sql)) {
      state.insertCount += 1;
      if (failAt && state.insertCount >= failAt) {
        throw new Error('boom: insert failed');
      }
      state.log.push('insert');
      state.shots.push({
        project_id: params[0], script_id: params[1], shot_id: params[2],
        beat_id: params[3], scene_index: params[4], beat_index: params[5],
        shot_index: params[6], kind: params[7], intent: params[8],
        subject_refs: JSON.parse(params[9]), duration_ms: params[10],
        ordering: params[11], version: params[12],
      });
      return { rowCount: 1 };
    }
    return { rows: [] };
  }

  const pg = {
    state,
    async query(sql, params) { return handle(sql, params); },
    async connect() {
      const client = {
        released: false,
        async query(sql, params) { return handle(sql, params); },
        async release() { this.released = true; state.released += 1; },
      };
      return client;
    },
  };
  return pg;
}

const P_ID = 'p-1';
const S_ID = 's-1';

function callPersist(pg, over = {}) {
  return persistStoryboardShots({ pg, projectId: P_ID, scriptId: S_ID, ...over });
}

// ------------------------------------------------- input / plan shape (400)
test('G13: persist rejects bad input shape with 400 (pg/projectId/scriptId/plan)', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  const cases = [
    { pg: null, projectId: P_ID, scriptId: S_ID, plan },
    { pg, projectId: '', scriptId: S_ID, plan },
    { pg, projectId: P_ID, scriptId: '', plan },
    { pg, projectId: P_ID, scriptId: S_ID, plan: null },
    { pg, projectId: P_ID, scriptId: S_ID, plan: { beats: [] } },
    { pg, projectId: P_ID, scriptId: S_ID, plan: {} },
  ];
  for (const args of cases) {
    const res = await persistStoryboardShots(args);
    assert.equal(res.ok, false, JSON.stringify(args).slice(0, 80));
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.errors) && res.errors.length > 0);
  }
});

test('G13: malformed beats/shots are rejected 400 (missing fields, bad intent, mismatch, duplicate shotId)', async () => {
  const { plan, rows } = samplePlan();
  const pg = makePg();
  const good = plan.beats[0];

  const mutate = (fn) => {
    const p = JSON.parse(JSON.stringify(plan));
    fn(p, good);
    return p;
  };
  const cases = [
    mutate((p) => { p.beats[0].shots = []; }),                                    // empty shots
    mutate((p) => { delete p.beats[0].beatId; }),                                 // beatId missing
    mutate((p) => { p.beats[0].shots[0].intent = 'establish'; }),                 // intent not G13
    mutate((p) => { p.beats[0].shots[0].durationMs = 1500.5; }),                  // fractional ms
    mutate((p) => { p.beats[0].shots[0].durationMs = -3; }),                      // negative ms
    mutate((p) => { p.beats[0].shots[0].beatId = 's9:b9'; }),                     // beat mismatch
    mutate((p) => { p.beats[0].scriptRowIds = []; }),                             // no source refs
    mutate((p) => { p.beats[0].scriptRowIds = [rows[0].id, 42]; }),               // non-string ref
    mutate((p) => { p.beats[0].shots[1].shotId = p.beats[0].shots[0].shotId; }),  // duplicate shotId
    mutate((p) => { p.beats.push({ ...p.beats[0], shots: [] }); }),
  ];
  for (const bad of cases) {
    const res = await callPersist(pg, { plan: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.errors) && res.errors.length > 0);
  }
  // 且全部在触碰 DB 前拒绝：零查询、零事务
  assert.equal(pg.state.log.length, 0);
});

// ------------------------------------------------------- happy path (200)
test('G13: persist wraps DELETE+INSERT in one transaction with ownership + version probes (v1)', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  const res = await callPersist(pg, { plan });
  assert.equal(res.ok, true);
  assert.equal(res.projectId, P_ID);
  assert.equal(res.scriptId, S_ID);
  assert.equal(res.version, 1);
  assert.equal(res.inserted, 4);
  assert.equal(res.replaced, 0);

  // 事务断言行集合（顺序敏感）
  assert.deepEqual(pg.state.log, [
    'BEGIN', 'owner-project', 'owner-rows', 'max-version', 'delete',
    'insert', 'insert', 'insert', 'insert', 'COMMIT',
  ]);
  assert.equal(pg.state.log.filter((l) => l === 'BEGIN').length, 1);
  assert.equal(pg.state.log.filter((l) => l === 'COMMIT').length, 1);
  assert.equal(pg.state.log[0], 'BEGIN');
  assert.equal(pg.state.log[pg.state.log.length - 1], 'COMMIT');
  assert.equal(pg.state.rollbacks, 0);
  assert.equal(pg.state.released, 1, 'dedicated client released');
  assert.equal(pg.state.shots.length, 4);
});

test('G13: inserted row params mirror the plan (ids, indices, intent, durationMs, kind, subjectRefs, ordering)', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  await callPersist(pg, { plan });

  const [s0k0, s0k1, s1k0, s1k1] = pg.state.shots;
  assert.equal(s0k0.shot_id, 's0:b0:k0');
  assert.equal(s0k0.beat_id, 's0:b0');
  assert.equal(s0k0.scene_index, 0);
  assert.equal(s0k0.beat_index, 0);
  assert.equal(s0k0.shot_index, 0);
  assert.equal(s0k0.intent, 'dialogue');                       // 主语
  assert.equal(s0k1.intent, 'reaction');                       // 反打（无第二说话人 → 空 refs）
  assert.equal(s1k0.intent, 'action');
  assert.equal(s1k1.intent, 'action');
  assert.deepEqual(s0k0.subject_refs, [{ entityType: 'character', entityId: 'char-maya', label: 'MAYA' }]);
  assert.deepEqual(s0k1.subject_refs, []);
  assert.deepEqual(s1k0.subject_refs, []);
  for (const s of pg.state.shots) {
    assert.equal(s.kind, 'standard');
    assert.equal(s.duration_ms, 3000);
    assert.equal(s.version, 1);
    assert.equal(s.project_id, P_ID);
    assert.equal(s.script_id, S_ID);
  }
  assert.deepEqual(pg.state.shots.map((s) => s.ordering), [0, 1, 2, 3]);
});

test('G13: shots span scenes keep a single flat ordering (multi-beat, multi-scene)', async () => {
  const rows = [
    D('MAYA', 'scene0', { scene_index: 0 }),
    A('action in scene0', { scene_index: 0 }),
    SD('CLOSE ON: door', { scene_index: 1 }),
    A('rain', { scene_index: 2 }),
  ];
  const plan = buildStoryboardPlan({ rows });
  assert.equal(plan.totalShots, 6); // 3 beats × 2
  const pg = makePg();
  const res = await callPersist(pg, { plan });
  assert.equal(res.ok, true);
  assert.equal(res.inserted, 6);
  assert.deepEqual(pg.state.shots.map((s) => s.ordering), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(pg.state.shots.map((s) => s.beat_id), ['s0:b0', 's0:b0', 's1:b0', 's1:b0', 's2:b0', 's2:b0']);
});

// ------------------------------------------------------ ownership (404)
test('G13: missing project → 404 and the transaction rolls back (no DELETE/INSERT)', async () => {
  const { plan } = samplePlan();
  const pg = makePg({ projectExists: false });
  const res = await callPersist(pg, { plan });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.match(res.error, /项目不存在/);
  assert.deepEqual(pg.state.log, ['BEGIN', 'owner-project', 'ROLLBACK']);
  assert.equal(pg.state.rollbacks, 1);
  assert.equal(pg.state.shots.length, 0);
});

test('G13: script rows not owned by this project → 404 + rollback (ownership check)', async () => {
  const { plan } = samplePlan();
  const pg = makePg({ ownerRowsOf: ['p-OTHER'] }); // plan 源行属于别的项目 / 未落库
  const res = await callPersist(pg, { plan });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.match(res.error, /script 不存在或不属于该项目/);
  assert.deepEqual(pg.state.log, ['BEGIN', 'owner-project', 'owner-rows', 'ROLLBACK']);
  assert.equal(pg.state.rollbacks, 1);
  assert.equal(pg.state.shots.length, 0);
});

// ------------------------------------------------------ idempotent rerun
test('G13: rerun on the same script atomically replaces old rows — version bumps 1..N', async () => {
  const { plan } = samplePlan();
  const pg = makePg();

  const first = await callPersist(pg, { plan });
  assert.equal(first.version, 1);
  assert.equal(first.replaced, 0);

  const second = await callPersist(pg, { plan });
  assert.equal(second.ok, true);
  assert.equal(second.version, 2);
  assert.equal(second.replaced, 4);      // DELETE 命中上一版 4 行
  assert.equal(second.inserted, 4);
  assert.equal(pg.state.shots.length, 4); // 终态 = 本次 plan 行集（无残留）

  const third = await callPersist(pg, { plan });
  assert.equal(third.version, 3);
  assert.equal(third.replaced, 4);
  assert.equal(pg.state.shots.length, 4);
  assert.ok(pg.state.shots.every((s) => s.version === 3));
  assert.deepEqual(new Set(pg.state.shots.map((s) => s.shot_id)), new Set([
    's0:b0:k0', 's0:b0:k1', 's1:b0:k0', 's1:b0:k1',
  ]));
});

test('G13: a changed plan replaces the old shot set under the same script (version 2, old shots gone)', async () => {
  const { plan: planA } = samplePlan();
  const pg = makePg();
  await callPersist(pg, { plan: planA });

  // 同一 script 的修订版 plan：仅场景 0 的一个 beat（2 shots）
  const rows = [D('MAYA', 'Revised.', { scene_index: 0 })];
  const planB = buildStoryboardPlan({ rows, characters: [MAYA] });
  const res = await callPersist(pg, { plan: planB });
  assert.equal(res.ok, true);
  assert.equal(res.version, 2);
  assert.equal(res.replaced, 4);
  assert.equal(pg.state.shots.length, 2);
  assert.deepEqual(pg.state.shots.map((s) => s.shot_id), ['s0:b0:k0', 's0:b0:k1']);
  assert.ok(pg.state.shots.every((s) => s.version === 2));
});

// ------------------------------------------------------ mid-write failure
test('G13: DB error mid-insert rolls the whole transaction back and preserves the previous version', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  await callPersist(pg, { plan }); // v1 落库（4 行）

  // 重跑时第 3 条 INSERT 抛错 → 整体回滚，v1 原样保留
  const pg2 = makePg({ failAt: 3 });
  pg2.state.shots = [...pg.state.shots]; // 继承 v1 已存在行
  await assert.rejects(callPersist(pg2, { plan }), /boom/);
  assert.equal(pg2.state.rollbacks, 1);
  assert.equal(pg2.state.log.filter((l) => l === 'COMMIT').length, 0);
  assert.equal(pg2.state.shots.length, 4, 'old rows survive the aborted rerun');
  assert.ok(pg2.state.shots.every((s) => s.version === 1));
});

// ------------------------------------------------------ direct pg (no connect)
test('G13: pg without connect() still persists (owner→version→DELETE→INSERT), no fake txn markers', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  const direct = { query: pg.query.bind(pg) }; // 服务器挂载时的 { query } 包装形态
  const res = await persistStoryboardShots({ pg: direct, projectId: P_ID, scriptId: S_ID, plan });
  assert.equal(res.ok, true);
  assert.equal(res.version, 1);
  assert.equal(res.inserted, 4);
  assert.deepEqual(pg.state.log, ['owner-project', 'owner-rows', 'max-version', 'delete', 'insert', 'insert', 'insert', 'insert']);
  assert.equal(pg.state.log.includes('BEGIN'), false);
  assert.equal(pg.state.shots.length, 4);
});

// ------------------------------------------------------ pure row builder
test('G13: buildShotRows normalizes defaults (kind/subjectRefs/durationMs) and keeps flat ordering', () => {
  const plan = {
    beats: [
      {
        beatId: 's0:b0', sceneIndex: 0, beatIndex: 0, scriptRowIds: ['r1'],
        shots: [
          { shotId: 's0:b0:k0', beatId: 's0:b0', shotIndex: 0, intent: 'dialogue', durationMs: 5000, kind: 'closeup' },
          { shotId: 's0:b0:k1', beatId: 's0:b0', shotIndex: 1, intent: 'reaction', subjectRefs: [{ entityType: 'character', entityId: 'c', label: 'C' }] },
        ],
      },
      {
        beatId: 's1:b0', sceneIndex: 1, beatIndex: 0, scriptRowIds: ['r2'],
        shots: [{ shotId: 's1:b0:k0', beatId: 's1:b0', shotIndex: 0, intent: 'action' }],
      },
    ],
  };
  const rows = buildShotRows({ plan, projectId: P_ID, scriptId: S_ID, version: 2 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.ordering), [0, 1, 2]);
  assert.deepEqual(rows.map((r) => r.version), [2, 2, 2]);
  assert.equal(rows[0].kind, 'closeup');
  assert.equal(rows[0].duration_ms, 5000);
  assert.equal(rows[1].kind, 'standard');
  assert.equal(rows[1].duration_ms, 3000); // 缺省 → G13 默认
  assert.deepEqual(rows[1].subject_refs, [{ entityType: 'character', entityId: 'c', label: 'C' }]);
  assert.deepEqual(rows[2].subject_refs, []); // 缺省 → []
  assert.equal(rows[2].scene_index, 1);
});

test('G13: validatePersistArgs returns { ok } and dedupes scriptRowIds refs', () => {
  const { plan } = samplePlan();
  const pg = makePg();
  const good = validatePersistArgs({ pg, projectId: P_ID, scriptId: S_ID, plan });
  assert.equal(good.ok, true);
  assert.equal(good.refs.length, new Set(good.refs).size);
  // duplicate scriptRowIds across beats are tolerated (refs dedupe)…
  const dupRefs = validatePersistArgs({
    pg, projectId: P_ID, scriptId: S_ID,
    plan: { beats: [{ beatId: 's0:b0', sceneIndex: 0, beatIndex: 0, scriptRowIds: ['r1', 'r1'], shots: [{ shotId: 'x', beatId: 's0:b0', shotIndex: 0, intent: 'action' }] }] },
  });
  assert.equal(dupRefs.ok, true);
  assert.deepEqual(dupRefs.refs, ['r1']);
  // …but duplicate shotIds violate UNIQUE(script_id, shot_id) → 400 up front
  const dupShot = validatePersistArgs({
    pg, projectId: P_ID, scriptId: S_ID,
    plan: { beats: [{ beatId: 's0:b0', sceneIndex: 0, beatIndex: 0, scriptRowIds: ['r1'], shots: [{ shotId: 'x', beatId: 's0:b0', shotIndex: 0, intent: 'action' }, { shotId: 'x', beatId: 's0:b0', shotIndex: 1, intent: 'action' }] }] },
  });
  assert.equal(dupShot.ok, false);
  assert.equal(dupShot.status, 400);
  assert.ok(dupShot.errors.some((e) => /duplicate shotId/.test(e)));
});
