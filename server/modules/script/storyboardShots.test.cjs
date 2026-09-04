'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  persistStoryboardShots,
  validatePersistArgs,
  buildShotRows,
  setLocked,
  lockShot,
  lockShots,
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
    if (/SELECT shot_id FROM project_shots_rows WHERE script_id = \$1/.test(sql)) {
      // LOCKED_SHOT_IDS_SQL：返回锁定 shot_id（不记日志，避免污染既有事务断言）
      return {
        rows: state.shots
          .filter((s) => s.script_id === params[0] && s.project_id === params[1] && s.locked)
          .map((s) => ({ shot_id: s.shot_id })),
      };
    }
    if (/DELETE FROM project_shots_rows WHERE script_id = \$1/.test(sql)) {
      state.log.push('delete');
      const before = state.shots.length;
      state.shots = state.shots.filter(
        (s) => !(s.script_id === params[0] && s.project_id === params[1] && !s.locked),
      );
      return { rowCount: before - state.shots.length };
    }
    if (/UPDATE project_shots_rows SET locked/.test(sql) && /ANY\(\$3::text\[\]\)/.test(sql)) {
      // SET_LOCKED_BATCH_SQL：script_id=$1, project_id=$2, shot_ids=$3, locked=$4
      const ids = params[2];
      const updated = [];
      for (const s of state.shots) {
        if (s.script_id === params[0] && s.project_id === params[1] && ids.includes(s.shot_id)) {
          s.locked = params[3];
          updated.push({ shot_id: s.shot_id });
        }
      }
      return { rows: updated };
    }
    if (/UPDATE project_shots_rows SET locked/.test(sql)) {
      // SET_LOCKED_SQL：script_id=$1, shot_id=$2, project_id=$3, locked=$4
      const target = state.shots.find(
        (s) => s.script_id === params[0] && s.shot_id === params[1] && s.project_id === params[2],
      );
      if (!target) return { rows: [] };
      target.locked = params[3];
      return { rows: [{ shot_id: target.shot_id, locked: target.locked }] };
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
        locked: params[13], source_trace: JSON.parse(params[14]),
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

// ---------------------------------------------- 并发 apply 竞态（CRITICAL fix）
/**
 * 忠实模拟 Postgres 下同 (project, script) 并发 apply 的关键语义，验证 LOCK_SQL：
 *   - 每个 `await q.query(...)` 让出事件循环 → 两个请求自然逐语句交错；
 *   - MAX(version) 读共享 committed 行集（本事务未提交写入对他人不可见由锁保证）；
 *   - INSERT 强制 UNIQUE(script_id, shot_id)，撞已提交同 key → 抛 23505 唯一冲突；
 *   - pg_advisory_xact_lock 以 (project, script) 为键互斥，COMMIT/ROLLBACK 自动释放。
 */
function makeConcurrentPg() {
  const committed = [];                 // committed shot rows
  const shotIds = new Set();            // committed (script|shot) unique index
  const locks = new Map();              // key -> { held, waiters[] }

  const keyOf = (p, s) => `${p}|${s}`;
  const ukey = (s, k) => `${s}|${k}`;

  async function acquire(key) {
    let l = locks.get(key);
    if (!l) { l = { held: false, waiters: [] }; locks.set(key, l); }
    if (!l.held) { l.held = true; return; }
    await new Promise((resolve) => l.waiters.push(resolve));
  }
  function release(key) {
    const l = locks.get(key);
    if (!l) return;
    if (l.waiters.length) l.waiters.shift()();
    else l.held = false;
  }

  const state = { committed, insertCount: 0, lockLog: [] };

  function execData(sql, params) {
    if (/SELECT 1 AS ok FROM projects/.test(sql)) return { rows: [{ ok: 1 }] };
    if (/SELECT id FROM script_rows WHERE project_id = \$1 AND id = ANY/.test(sql)) {
      return { rows: (params[1] || []).map((id) => ({ id })) };
    }
    if (/COALESCE\(MAX\(version\), 0\)/.test(sql)) {
      const [scriptId, projectId] = params;
      const v = committed
        .filter((s) => s.script_id === scriptId && s.project_id === projectId)
        .reduce((m, s) => Math.max(m, s.version), 0);
      return { rows: [{ v }] };
    }
    if (/DELETE FROM project_shots_rows WHERE script_id = \$1/.test(sql)) {
      const [scriptId, projectId] = params;
      const before = committed.length;
      const kept = [];
      for (const s of committed) {
        if (s.script_id === scriptId && s.project_id === projectId) shotIds.delete(ukey(s.script_id, s.shot_id));
        else kept.push(s);
      }
      committed.length = 0; committed.push(...kept);
      return { rowCount: before - committed.length };
    }
    if (/INSERT INTO project_shots_rows/.test(sql)) {
      const [projectId, scriptId, shotId] = [params[0], params[1], params[2]];
      const k = ukey(scriptId, shotId);
      if (shotIds.has(k)) {
        const e = new Error(`duplicate key value violates unique constraint (script_id, shot_id)=(${scriptId}, ${shotId})`);
        e.code = '23505';
        throw e;
      }
      shotIds.add(k);
      committed.push({
        project_id: projectId, script_id: scriptId, shot_id: shotId,
        beat_id: params[3], scene_index: params[4], beat_index: params[5],
        shot_index: params[6], kind: params[7], intent: params[8],
        subject_refs: JSON.parse(params[9]), duration_ms: params[10],
        ordering: params[11], version: params[12],
      });
      state.insertCount += 1;
      return { rowCount: 1 };
    }
    return { rows: [] };
  }

  const pg = {
    state,
    async query(sql, params = []) { return execData(sql, params); }, // validatePersistArgs 要求 pg.query 存在
    async connect() {
      const txn = { lockedKey: null };
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'COMMIT') { if (txn.lockedKey) release(txn.lockedKey); return { rows: [] }; }
          if (sql === 'ROLLBACK') { if (txn.lockedKey) release(txn.lockedKey); return { rows: [] }; }
          if (/pg_advisory_xact_lock/.test(sql)) {
            const key = keyOf(params[0], params[1]);
            state.lockLog.push(`lock:${key}`);
            await acquire(key);
            txn.lockedKey = key;
            return { rows: [] };
          }
          return execData(sql, params);
        },
        async release() {},
      };
    },
  };
  return pg;
}

test('G13 CRITICAL: concurrent apply on the same script serializes — distinct versions, no unique conflict', async () => {
  const { plan } = samplePlan();
  const pg = makeConcurrentPg();

  const [a, b] = await Promise.allSettled([
    callPersist(pg, { plan }),
    callPersist(pg, { plan }),
  ]);

  // 两个请求都必须成功（修复后：advisory lock 串行化，第二个读到 MAX=1 → v2）
  assert.equal(a.status, 'fulfilled', a.reason ? a.reason.message : 'a rejected');
  assert.equal(b.status, 'fulfilled', b.reason ? b.reason.message : 'b rejected');
  const versions = [a.value.version, b.value.version].sort((x, y) => x - y);
  assert.deepEqual(versions, [1, 2], 'versions must be distinct 1..2, not both 1');
  // 两次 apply 各插 4 行 → 8 次 INSERT；终态 = 最新 plan 行集（version 2，无残留/重复）
  assert.equal(pg.state.insertCount, 8);
  assert.equal(pg.state.committed.length, 4);
  assert.ok(pg.state.committed.every((s) => s.version === 2));
  assert.deepEqual(new Set(pg.state.committed.map((s) => s.shot_id)), new Set([
    's0:b0:k0', 's0:b0:k1', 's1:b0:k0', 's1:b0:k1',
  ]));
  // 锁确实以 (project, script) 为键取过两次（两次 apply 各一次，第二次等待第一次提交）
  assert.equal(pg.state.lockLog.length, 2);
});

test('G13 CRITICAL: advisory lock is acquired before the MAX(version) read (mechanism)', async () => {
  const { plan } = samplePlan();
  const calls = [];
  const pg = {
    async query(sql, params = []) {
      if (/SELECT 1 AS ok FROM projects/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/SELECT id FROM script_rows/.test(sql)) return { rows: (params[1] || []).map((id) => ({ id })) };
      if (/COALESCE\(MAX\(version\)/.test(sql)) { calls.push('max'); return { rows: [{ v: 0 }] }; }
      if (/DELETE FROM project_shots_rows/.test(sql)) { calls.push('delete'); return { rowCount: 0 }; }
      if (/INSERT INTO project_shots_rows/.test(sql)) { calls.push('insert'); return { rowCount: 1 }; }
      if (/pg_advisory_xact_lock/.test(sql)) { calls.push('lock'); return { rows: [] }; }
      return { rows: [] };
    },
  };
  await persistStoryboardShots({ pg, projectId: P_ID, scriptId: S_ID, plan });
  assert.equal(calls[0], 'lock', 'advisory lock must precede the version read');
  assert.ok(calls.indexOf('lock') < calls.indexOf('max'), 'lock before MAX(version)');
});

// ------------------------------------------------------ locked semantics (0052)
test('G13 V2.0: locked shot survives re-apply — row preserved, replaced/inserted exclude it, skippedLocked returned', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  const first = await callPersist(pg, { plan });
  assert.equal(first.ok, true);
  assert.equal(first.version, 1);
  assert.deepEqual(first.skippedLocked, []);
  assert.equal(pg.state.shots.length, 4);

  const locked = await lockShot({ pg, projectId: P_ID, scriptId: S_ID, shotId: 's0:b0:k0', locked: true });
  assert.equal(locked.ok, true);
  assert.equal(locked.locked, true);

  const second = await callPersist(pg, { plan });
  assert.equal(second.ok, true);
  assert.equal(second.version, 2);
  assert.deepEqual(second.skippedLocked, ['s0:b0:k0']); // 锁定 shot_id 被跳过并上报
  assert.equal(second.replaced, 3);                     // 只删 3 行 unlocked
  assert.equal(second.inserted, 3);                     // 跳过锁定的 1 行
  assert.equal(pg.state.shots.length, 4);               // 锁定行保留 + 3 新行

  const lockedRow = pg.state.shots.find((s) => s.shot_id === 's0:b0:k0');
  assert.equal(lockedRow.locked, true);
  assert.equal(lockedRow.version, 1, 'locked row keeps its old version (never overwritten)');
  const unlocked = pg.state.shots.filter((s) => s.shot_id !== 's0:b0:k0');
  assert.ok(unlocked.every((s) => s.locked === false && s.version === 2));
});

test('G13 V2.0: a locked shot no longer in the plan is still preserved (DELETE skips it)', async () => {
  const { plan: planA } = samplePlan();
  const pg = makePg();
  await callPersist(pg, { plan: planA });
  // 锁定一个将要从修订版 plan 中消失的 shot（s1 场景的 s1:b0:k0）
  await lockShot({ pg, projectId: P_ID, scriptId: S_ID, shotId: 's1:b0:k0', locked: true });

  // 修订版 plan：仅场景 0 一个 beat（2 shots），不再包含 s1:b0:* 
  const rows = [D('MAYA', 'Revised.', { scene_index: 0 })];
  const planB = buildStoryboardPlan({ rows, characters: [MAYA] });
  const res = await callPersist(pg, { plan: planB });
  assert.equal(res.ok, true);
  assert.equal(res.version, 2);
  assert.deepEqual(res.skippedLocked, ['s1:b0:k0']);
  assert.equal(res.replaced, 3);              // 3 个 unlocked 被删
  assert.equal(res.inserted, 2);              // 新 plan 2 shots
  assert.equal(pg.state.shots.length, 3);     // 2 新 + 1 锁定保留
  assert.ok(pg.state.shots.some((s) => s.shot_id === 's1:b0:k0' && s.locked && s.version === 1));
  assert.deepEqual(new Set(pg.state.shots.filter((s) => !s.locked).map((s) => s.shot_id)), new Set(['s0:b0:k0', 's0:b0:k1']));
});

// ------------------------------------------------------ source trace (0053)
test('G13 V2.0: source_trace lands per row with scriptRowIds + fixed appliedAtMs', async () => {
  const { plan, rows } = samplePlan();
  const pg = makePg();
  await callPersist(pg, { plan });

  const s0k0 = pg.state.shots.find((s) => s.shot_id === 's0:b0:k0');
  assert.deepEqual(s0k0.source_trace, {
    scriptRowIds: plan.beats[0].scriptRowIds,
    sceneIndex: 0,
    beatIndex: 0,
    shotIndex: 0,
    appliedAtMs: 0,
  });
  assert.ok(s0k0.source_trace.scriptRowIds.length > 0);
  assert.deepEqual(s0k0.source_trace.scriptRowIds, plan.beats[0].scriptRowIds);
  for (const id of s0k0.source_trace.scriptRowIds) {
    assert.ok(rows.some((r) => r.id === id), `trace scriptRowId ${id} must reference a source row`);
  }
  // 不可变时间戳 = 固定值 0（apply 确定性，不随系统时钟漂移）
  assert.ok(pg.state.shots.every((s) => s.source_trace.appliedAtMs === 0));
  assert.equal(s0k0.locked, false, 'new rows are never locked on write');
  // 每个 shot 的 trace 映射到自身 beat/scene 上下文
  const s1k0 = pg.state.shots.find((s) => s.shot_id === 's1:b0:k0');
  assert.equal(s1k0.source_trace.sceneIndex, 1);
  assert.equal(s1k0.source_trace.beatIndex, 0);
  assert.deepEqual(s1k0.source_trace.scriptRowIds, plan.beats[1].scriptRowIds);
});

// ------------------------------------------------------ lock/unlock + 404
test('G13 V2.0: lockShot/setLocked toggle the locked boolean; unlock clears protection', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  await callPersist(pg, { plan });

  const on = await lockShot({ pg, projectId: P_ID, scriptId: S_ID, shotId: 's1:b0:k0', locked: true });
  assert.equal(on.ok, true);
  assert.equal(on.locked, true);
  assert.equal(pg.state.shots.find((s) => s.shot_id === 's1:b0:k0').locked, true);

  const off = await setLocked({ pg, projectId: P_ID, scriptId: S_ID, shotId: 's1:b0:k0', locked: false });
  assert.equal(off.ok, true);
  assert.equal(off.locked, false);
  assert.equal(pg.state.shots.find((s) => s.shot_id === 's1:b0:k0').locked, false);
});

test('G13 V2.0: lockShot on a foreign project / unknown shot → 404 (row untouched)', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  await callPersist(pg, { plan }); // rows belong to p-1

  const foreign = await lockShot({ pg, projectId: 'p-OTHER', scriptId: S_ID, shotId: 's0:b0:k0', locked: true });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.status, 404);
  assert.match(foreign.error, /shot 不存在或不属于该项目/);

  const missing = await lockShot({ pg, projectId: P_ID, scriptId: S_ID, shotId: 'nope', locked: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);

  assert.equal(pg.state.shots.find((s) => s.shot_id === 's0:b0:k0').locked, false, 'cross-project lock must not touch the row');
});

test('G13 V2.0: lockShots batch-toggles multiple shot ids under one script', async () => {
  const { plan } = samplePlan();
  const pg = makePg();
  await callPersist(pg, { plan });

  const res = await lockShots({ pg, projectId: P_ID, scriptId: S_ID, shotIds: ['s0:b0:k0', 's1:b0:k1'], locked: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.updated.sort(), ['s0:b0:k0', 's1:b0:k1']);
  assert.equal(res.locked, true);
  assert.equal(pg.state.shots.find((s) => s.shot_id === 's0:b0:k0').locked, true);
  assert.equal(pg.state.shots.find((s) => s.shot_id === 's1:b0:k1').locked, true);
  assert.equal(pg.state.shots.find((s) => s.shot_id === 's0:b0:k1').locked, false);

  const off = await lockShots({ pg, projectId: P_ID, scriptId: S_ID, shotIds: ['s0:b0:k0', 's1:b0:k1'], locked: false });
  assert.equal(off.ok, true);
  assert.ok(pg.state.shots.every((s) => s.locked === false));
});

test('G13 V2.0: lockShot/lockShots validate bad input (400)', async () => {
  const pg = makePg();
  const cases = [
    () => lockShot({ pg: null, projectId: P_ID, scriptId: S_ID, shotId: 'x', locked: true }),
    () => lockShot({ pg, projectId: '', scriptId: S_ID, shotId: 'x', locked: true }),
    () => lockShot({ pg, projectId: P_ID, scriptId: '', shotId: 'x', locked: true }),
    () => lockShot({ pg, projectId: P_ID, scriptId: S_ID, shotId: '', locked: true }),
    () => lockShot({ pg, projectId: P_ID, scriptId: S_ID, shotId: 'x', locked: 'yes' }),
    () => lockShots({ pg, projectId: P_ID, scriptId: S_ID, shotIds: [], locked: true }),
    () => lockShots({ pg, projectId: P_ID, scriptId: S_ID, shotIds: ['x', 42], locked: true }),
  ];
  for (const fn of cases) {
    const res = await fn();
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.errors) && res.errors.length > 0);
  }
});

