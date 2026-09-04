'use strict';
/**
 * L51/L52 — Workflow 执行引擎测试（createWorkflowExecutor，§94-100，G12/G20）。
 *
 * 覆盖：
 *   1. 单元：validateWorkflowDag 拓扑序 / 环检测 / 未解析依赖。
 *   2. 单元：resolveWorkflowFailureMode（fail_fast 缺省 / SKIP_STEP→continue / 节点级覆盖 / {mode} 直白二态）。
 *   3. 拓扑序执行（菱形 DAG）：submitJob 调用序满足拓扑约束，全步 succeeded，run succeeded。
 *   4. 依赖门（continue + 传递 skip）：失败依赖的下游标 skipped、不派发 submitJob。
 *   5. fail_fast 中止：链中某步失败 → 其余步 canceled(WORKFLOW_ABORTED)，run failed。
 *   6. continue 跳 failed：失败步标 failed，其下游 skipped，独立分支继续执行。
 *   7. pin 快照（§95）：run 落库后改写 revision.dag → run.dag_snapshot 不变（物化副本）。
 *   8. 并发重入单跑：同 revision+project+inputs 并发两次 → 单 run、submitJob 每步只派发一次。
 *   9. L52 Gate 20 强制 pin：latest/head/未指定 → 400 WORKFLOW_REVISION_REQUIRED 拒。
 *  10. L52 resolvePinnedRevision：未给 revision → ACTIVE workflow 当前 ACTIVE revision 显式物化（禁存 latest）。
 *  11. L52 workflowCode+revision 经 run() 物化为具体 revision id 并 pin 落库。
 *  12. L52 并发：运行中追加新 ACTIVE revision → 新 run 用新 revision、旧 run 快照互不影响。
 *  13. L52 运行后改 def（追加 revision/改名）不波及既有 run 的 pin 与快照。
 *
 * 运行：TEST_PG_PORT=54329 node --test server/modules/project-foundation/studioWorkflowExecutor.test.cjs
 * （throwaway PG；本测试应用 0071 + 0072 两文件，自包含。）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createWorkflowExecutor, validateWorkflowDag, resolveWorkflowFailureMode, resolvePinnedRevision } = require('./studioRunEngine.cjs');

const MIGRATIONS = [
  path.join(__dirname, '..', '..', 'db', 'migrations', '0071_workflow_definitions.sql'),
  path.join(__dirname, '..', '..', 'db', 'migrations', '0072_workflow_runs.sql'),
];

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';

const adminPool = new Pool({ host: pgHost, port: pgPort, user: pgUser, password: pgPass, database: 'postgres', max: 1 });

function randomSuffix() { return crypto.randomBytes(4).toString('hex'); }

async function createTestDb(suffix) {
  const dbName = `moling_wf_exec_test_${suffix}`;
  await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  return dbName;
}

async function dropTestDb(dbName) {
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch (_) { /* best-effort teardown */ }
}

let dbName;
let pg;

test.before(async () => {
  dbName = await createTestDb(randomSuffix());
  pg = new Pool({ host: pgHost, port: pgPort, user: pgUser, password: pgPass, database: dbName, max: 2 });
  for (const f of MIGRATIONS) {
    await pg.query(fs.readFileSync(f, 'utf8'));
  }
});

test.after(async () => {
  if (pg) { await pg.end().catch(() => {}); }
  if (dbName) { await dropTestDb(dbName); }
  await adminPool.end().catch(() => {});
});

async function seedRevision({ defId, revId, dag, failurePolicy, contractRev = 'v3', revNo = 1 }) {
  await pg.query(
    `INSERT INTO workflow_definitions (id, code, name, status) VALUES ($1, $2, $3, 'active') ON CONFLICT (id) DO NOTHING`,
    [defId, `CODE_${defId.toUpperCase()}`, `WF ${defId}`]);
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, failure_policy, runtime_contract_revision)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [revId, defId, revNo, JSON.stringify(dag), failurePolicy == null ? null : JSON.stringify(failurePolicy), contractRev]);
}

function makeSubmitJob({ failSteps = [], failCode = 'MOCK_STEP_FAILED' } = {}) {
  const fail = new Set(failSteps);
  const job = async (ctx) => {
    job.calls.push(ctx.stepKey);
    if (fail.has(ctx.stepKey)) {
      return { ok: false, error: { code: failCode, message: `mock fail ${ctx.stepKey}` } };
    }
    return { ok: true, jobId: `job-${ctx.stepKey}` };
  };
  job.calls = [];
  return job;
}

/** 门控 submitJob：在第一步挂起，直到调用 job.release() —— 用于构造「运行中」态。 */
function makeGatedSubmitJob() {
  let release;
  const gate = new Promise((res) => { release = res; });
  const job = async (ctx) => {
    job.calls.push(ctx.stepKey);
    await gate;
    return { ok: true, jobId: `job-${ctx.stepKey}` };
  };
  job.calls = [];
  job.release = release;
  return job;
}

/** 轮询等待谓词成立（有限超时），用于并发测试的确定性同步。 */
async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const DIAMOND = {
  nodes: [
    { step_id: 's1', kind: 'operation', operation_id: 'op-a', dependencies: [] },
    { step_id: 's2', kind: 'operation', operation_id: 'op-b', dependencies: ['s1'] },
    { step_id: 's3', kind: 'operation', operation_id: 'op-c', dependencies: ['s1'] },
    { step_id: 's4', kind: 'operation', operation_id: 'op-d', dependencies: ['s2', 's3'] },
  ],
  edges: [{ from: 's1', to: 's2' }, { from: 's1', to: 's3' }, { from: 's2', to: 's4' }, { from: 's3', to: 's4' }],
};
const CHAIN = {
  nodes: [
    { step_id: 's1', kind: 'operation', operation_id: 'op-a', dependencies: [] },
    { step_id: 's2', kind: 'operation', operation_id: 'op-b', dependencies: ['s1'] },
    { step_id: 's3', kind: 'operation', operation_id: 'op-c', dependencies: ['s2'] },
  ],
  edges: [{ from: 's1', to: 's2' }, { from: 's2', to: 's3' }],
};
const BRANCH = {
  nodes: [
    { step_id: 's1', kind: 'operation', operation_id: 'op-a', dependencies: [] },
    { step_id: 's2', kind: 'operation', operation_id: 'op-b', dependencies: ['s1'] },
    { step_id: 's3', kind: 'operation', operation_id: 'op-c', dependencies: [] },
  ],
  edges: [{ from: 's1', to: 's2' }],
};

// ── 单元：DAG 校验 / 拓扑序 ───────────────────────────────────────────────
test('validateWorkflowDag: 稳定拓扑序（菱形）', () => {
  const r = validateWorkflowDag(DIAMOND);
  assert.equal(r.ok, true);
  assert.equal(r.order.length, 4);
  assert.equal(r.order[0], 's1', '源节点应最先');
  assert.equal(r.order[3], 's4', '汇节点应最后');
  assert.deepEqual(new Set(r.order.slice(1, 3)), new Set(['s2', 's3']), '中间层为 s2/s3');
});

test('validateWorkflowDag: 环检测 + 未解析依赖 + 空 DAG', () => {
  const cyc = validateWorkflowDag({ nodes: [
    { step_id: 'a', dependencies: ['b'] },
    { step_id: 'b', dependencies: ['a'] },
  ] });
  assert.equal(cyc.ok, false);
  assert.equal(cyc.error.code, 'DAG_HAS_CYCLE');

  const unres = validateWorkflowDag({ nodes: [{ step_id: 'a', dependencies: ['ghost'] }] });
  assert.equal(unres.ok, false);
  assert.equal(unres.error.code, 'DAG_UNRESOLVED_DEPENDENCY');

  const dup = validateWorkflowDag({ nodes: [{ step_id: 'a', dependencies: [] }, { step_id: 'a', dependencies: [] }] });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'DAG_DUPLICATE_STEP_ID');

  assert.equal(validateWorkflowDag({ nodes: [] }).error.code, 'DAG_EMPTY');
});

test('resolveWorkflowFailureMode: 裁决映射', () => {
  assert.equal(resolveWorkflowFailureMode(null, {}), 'fail_fast', '无策略缺省 fail_fast');
  assert.equal(resolveWorkflowFailureMode({ default: 'FAIL_WORKFLOW' }, {}), 'fail_fast');
  assert.equal(resolveWorkflowFailureMode({ default: 'SKIP_STEP' }, {}), 'continue');
  assert.equal(resolveWorkflowFailureMode({ mode: 'continue' }, {}), 'continue', '{mode} 直白二态');
  assert.equal(resolveWorkflowFailureMode({ mode: 'fail_fast' }, {}), 'fail_fast');
  assert.equal(resolveWorkflowFailureMode({ default: 'FAIL_WORKFLOW' }, { failure_policy: 'SKIP_STEP' }), 'continue', '节点级覆盖');
});

// ── 集成：拓扑序执行 ──────────────────────────────────────────────────────
test('拓扑序执行：菱形 DAG 全步 succeeded，run succeeded', async () => {
  await seedRevision({ defId: 'wf-topo', revId: 'rev-topo', dag: DIAMOND });
  const submitJob = makeSubmitJob();
  const ex = createWorkflowExecutor({ pg, submitJob });

  const res = await ex.run({ workflowRevisionId: 'rev-topo', projectId: 'proj-topo', inputs: { a: 1 } });

  assert.equal(res.ok, true);
  assert.equal(res.idempotent, false);
  assert.equal(res.status, 'succeeded');
  assert.equal(res.stepCount, 4);
  assert.equal(submitJob.calls.length, 4, '每步派发一次');
  assert.equal(submitJob.calls[0], 's1');
  assert.equal(submitJob.calls[3], 's4');
  assert.deepEqual(new Set(submitJob.calls.slice(1, 3)), new Set(['s2', 's3']));

  const steps = await pg.query(`SELECT step_key, status, job_id FROM workflow_step_runs WHERE workflow_run_id = $1 ORDER BY step_key`, [res.runId]);
  assert.equal(steps.rows.length, 4);
  for (const r of steps.rows) {
    assert.equal(r.status, 'succeeded', `step ${r.step_key} 应 succeeded`);
    assert.ok(r.job_id, `step ${r.step_key} 应有 job_id`);
  }
  const run = await pg.query(`SELECT status, workflow_revision_id FROM workflow_runs WHERE id = $1`, [res.runId]);
  assert.equal(run.rows[0].status, 'succeeded');
  assert.equal(run.rows[0].workflow_revision_id, 'rev-topo', 'run 应 pin rev-topo');
});

// ── 集成：依赖门（continue + 传递 skip）──────────────────────────────────
test('依赖门：失败依赖下游 skipped（含传递），且不派发 submitJob', async () => {
  await seedRevision({ defId: 'wf-gate', revId: 'rev-gate', dag: CHAIN, failurePolicy: { default: 'SKIP_STEP' } });
  const submitJob = makeSubmitJob({ failSteps: ['s1'] });
  const ex = createWorkflowExecutor({ pg, submitJob });

  const res = await ex.run({ workflowRevisionId: 'rev-gate', projectId: 'proj-gate', inputs: {} });

  assert.equal(res.status, 'failed');
  assert.deepEqual(submitJob.calls, ['s1'], '仅失败步本身派发；被门的下游绝不派发');

  const steps = await pg.query(`SELECT step_key, status, error_code FROM workflow_step_runs WHERE workflow_run_id = $1 ORDER BY step_key`, [res.runId]);
  const byKey = Object.fromEntries(steps.rows.map((r) => [r.step_key, r]));
  assert.equal(byKey.s1.status, 'failed');
  assert.equal(byKey.s1.error_code, 'MOCK_STEP_FAILED');
  assert.equal(byKey.s2.status, 'skipped', '直接下游应 skipped');
  assert.equal(byKey.s2.error_code, 'DEPENDENCY_FAILED');
  assert.equal(byKey.s3.status, 'skipped', '传递下游应 skipped');
  assert.equal(byKey.s3.error_code, 'DEPENDENCY_FAILED');
});

// ── 集成：fail_fast 中止 ─────────────────────────────────────────────────
test('fail_fast 中止：链中失败 → 其余 canceled，run failed', async () => {
  await seedRevision({ defId: 'wf-ff', revId: 'rev-ff', dag: CHAIN, failurePolicy: { default: 'FAIL_WORKFLOW' } });
  const submitJob = makeSubmitJob({ failSteps: ['s2'] });
  const ex = createWorkflowExecutor({ pg, submitJob });

  const res = await ex.run({ workflowRevisionId: 'rev-ff', projectId: 'proj-ff', inputs: {} });

  assert.equal(res.status, 'failed');
  assert.deepEqual(submitJob.calls, ['s1', 's2'], '失败后其余步不再派发');

  const steps = await pg.query(`SELECT step_key, status, error_code FROM workflow_step_runs WHERE workflow_run_id = $1 ORDER BY step_key`, [res.runId]);
  const byKey = Object.fromEntries(steps.rows.map((r) => [r.step_key, r]));
  assert.equal(byKey.s1.status, 'succeeded');
  assert.equal(byKey.s2.status, 'failed');
  assert.equal(byKey.s2.error_code, 'MOCK_STEP_FAILED');
  assert.equal(byKey.s3.status, 'canceled', '下游应 canceled（中止）');
  assert.equal(byKey.s3.error_code, 'WORKFLOW_ABORTED');
});

// ── 集成：continue 跳 failed ─────────────────────────────────────────────
test('continue 跳 failed：失败步 failed，下游 skipped，独立分支继续', async () => {
  await seedRevision({ defId: 'wf-cont', revId: 'rev-cont', dag: BRANCH, failurePolicy: { default: 'SKIP_STEP' } });
  const submitJob = makeSubmitJob({ failSteps: ['s1'] });
  const ex = createWorkflowExecutor({ pg, submitJob });

  const res = await ex.run({ workflowRevisionId: 'rev-cont', projectId: 'proj-cont', inputs: {} });

  assert.equal(res.status, 'failed');
  assert.deepEqual(new Set(submitJob.calls), new Set(['s1', 's3']), '独立分支 s3 应继续派发');
  assert.ok(!submitJob.calls.includes('s2'), '失败依赖的下游 s2 不派发');

  const steps = await pg.query(`SELECT step_key, status, error_code FROM workflow_step_runs WHERE workflow_run_id = $1 ORDER BY step_key`, [res.runId]);
  const byKey = Object.fromEntries(steps.rows.map((r) => [r.step_key, r]));
  assert.equal(byKey.s1.status, 'failed');
  assert.equal(byKey.s2.status, 'skipped');
  assert.equal(byKey.s3.status, 'succeeded', '独立分支应成功');
});

// ── 集成：pin 快照（§95）─────────────────────────────────────────────────
test('pin 快照：运行后改 revision 不影响 run.dag_snapshot', async () => {
  const DAG_A = { nodes: [
    { step_id: 'a1', kind: 'operation', operation_id: 'op-a', dependencies: [] },
    { step_id: 'a2', kind: 'operation', operation_id: 'op-b', dependencies: ['a1'] },
  ] };
  const DAG_B = { nodes: [
    { step_id: 'b1', kind: 'operation', operation_id: 'op-x', dependencies: [] },
    { step_id: 'b2', kind: 'operation', operation_id: 'op-y', dependencies: ['b1'] },
    { step_id: 'b3', kind: 'operation', operation_id: 'op-z', dependencies: ['b2'] },
  ] };
  await seedRevision({ defId: 'wf-pin', revId: 'rev-pin', dag: DAG_A, failurePolicy: { default: 'FAIL_WORKFLOW' } });
  const submitJob = makeSubmitJob();
  const ex = createWorkflowExecutor({ pg, submitJob });

  const res = await ex.run({ workflowRevisionId: 'rev-pin', projectId: 'proj-pin', inputs: {} });
  assert.equal(res.status, 'succeeded');

  const before = await pg.query(`SELECT dag_snapshot, workflow_revision_id FROM workflow_runs WHERE id = $1`, [res.runId]);
  assert.deepEqual(before.rows[0].dag_snapshot, DAG_A, 'dag_snapshot 应为执行时 DAG_A');

  // 运行后改写 revision.dag（历史行漂移）→ run 快照不变
  await pg.query(`UPDATE workflow_revisions SET dag = $1::jsonb WHERE id = 'rev-pin'`, [JSON.stringify(DAG_B)]);
  const after = await pg.query(`SELECT dag_snapshot FROM workflow_runs WHERE id = $1`, [res.runId]);
  assert.deepEqual(after.rows[0].dag_snapshot, DAG_A, '改 revision 后 dag_snapshot 应仍为 DAG_A（物化副本）');

  const stepKeys = await pg.query(`SELECT step_key FROM workflow_step_runs WHERE workflow_run_id = $1 ORDER BY step_key`, [res.runId]);
  assert.deepEqual(stepKeys.rows.map((r) => r.step_key), ['a1', 'a2'], 'step_runs 应按旧 DAG_A 步骤');
});

// ── 集成：并发重入单跑 ───────────────────────────────────────────────────
test('并发重入单跑：同 inputs 并发两次 → 单 run、submitJob 每步只派发一次', async () => {
  await seedRevision({ defId: 'wf-conc', revId: 'rev-conc', dag: DIAMOND });
  const submitJob = makeSubmitJob();
  const ex = createWorkflowExecutor({ pg, submitJob });

  const params = { workflowRevisionId: 'rev-conc', projectId: 'proj-conc', inputs: { k: 'v' } };
  const [r1, r2] = await Promise.all([ex.run(params), ex.run({ ...params, inputs: { k: 'v' } })]);

  assert.equal(r1.runId, r2.runId, '两次应派生同一 runId');
  const idem = [r1, r2].filter((r) => r.idempotent === true);
  const fresh = [r1, r2].filter((r) => r.idempotent === false);
  assert.equal(idem.length, 1, '恰一次幂等重入');
  assert.equal(fresh.length, 1, '恰一次 fresh 执行');
  assert.equal(fresh[0].status, 'succeeded');

  assert.equal(submitJob.calls.length, 4, 'submitJob 每步仅派发一次（共 4 步，非 8）');

  const runs = await pg.query(`SELECT count(*)::int AS c FROM workflow_runs WHERE id = $1`, [r1.runId]);
  assert.equal(runs.rows[0].c, 1, 'workflow_runs 仅一行');
  const steps = await pg.query(`SELECT count(*)::int AS c FROM workflow_step_runs WHERE workflow_run_id = $1`, [r1.runId]);
  assert.equal(steps.rows[0].c, 4, 'step_runs 仅 4 行（无重复）');
});

// ── 集成：缺 revision 拒绝 + runtime_contract latest 被 DB CHECK 兜底 ────
test('run 拒绝不存在的 revision；runtime_contract latest 被 DB CHECK 拒绝（§100）', async () => {
  const ex = createWorkflowExecutor({ pg, submitJob: makeSubmitJob() });
  await assert.rejects(
    ex.run({ workflowRevisionId: 'rev-missing', projectId: 'p' }),
    (e) => e.code === 'WORKFLOW_REVISION_NOT_FOUND'
  );

  // §100: runtime_contract_revision = 'latest' 在写入 revision 行时即被 DB CHECK 拒绝
  // （0071 CHECK(runtime_contract_revision <> 'latest')），executor 的应用层双保险不可达。
  await seedRevision({ defId: 'wf-latest', revId: 'rev-latest', dag: DIAMOND, contractRev: 'v3' });
  await assert.rejects(
    pg.query(
      `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
       VALUES ('rev-latest-x', 'wf-latest', 99, '{}'::jsonb, 'latest')`),
    (e) => e.code === '23514'
  );
});

// ── L52 Gate 20：强制 pin（禁 latest/head/未指定）─────────────────────────
test('L52 Gate 20：latest/head/未指定 pin → WORKFLOW_REVISION_REQUIRED', async () => {
  const ex = createWorkflowExecutor({ pg, submitJob: makeSubmitJob() });
  const cases = [
    { params: { projectId: 'p' }, label: '未指定 pin（无 revision）' },
    { params: { workflowRevisionId: 'latest', projectId: 'p' }, label: 'workflowRevisionId=latest' },
    { params: { workflowRevisionId: 'head', projectId: 'p' }, label: 'workflowRevisionId=head' },
    { params: { workflowRevisionId: 'LATEST', projectId: 'p' }, label: 'workflowRevisionId=LATEST（大小写）' },
    { params: { workflowCode: 'CODE_X', projectId: 'p' }, label: 'workflowCode 无 revision' },
    { params: { workflowCode: 'CODE_X', revision: 'latest', projectId: 'p' }, label: 'revision=latest' },
    { params: { workflowCode: 'CODE_X', revision: 'head', projectId: 'p' }, label: 'revision=head' },
    { params: { workflowCode: 'CODE_X', revision: 0, projectId: 'p' }, label: 'revision=0' },
    { params: { workflowCode: 'CODE_X', revision: -1, projectId: 'p' }, label: 'revision=-1' },
  ];
  for (const c of cases) {
    await assert.rejects(ex.run(c.params), (e) => e.code === 'WORKFLOW_REVISION_REQUIRED', c.label);
  }
});

// ── L52：resolvePinnedRevision 显式物化（禁存 latest 引用）────────────────
test('L52 resolvePinnedRevision：未给 revision → ACTIVE 当前 ACTIVE revision 显式物化', async () => {
  await seedRevision({ defId: 'wf-rs', revId: 'rev-rs-1', dag: DIAMOND, revNo: 1 });
  await seedRevision({ defId: 'wf-rs', revId: 'rev-rs-2', dag: CHAIN, revNo: 2 });

  const cur = await resolvePinnedRevision({ pg, workflowCode: 'CODE_WF-RS' });
  assert.equal(cur.workflowRevisionId, 'rev-rs-2', '应物化为当前 ACTIVE revision 的具体 id');
  assert.equal(cur.revision, 2);
  assert.notEqual(cur.workflowRevisionId, 'latest', '绝不返回 latest 引用');
  assert.notEqual(cur.workflowRevisionId, 'head', '绝不返回 head 引用');
  assert.deepEqual(cur.dag, CHAIN, 'dag 应为当前 ACTIVE revision 的 DAG');

  const v1 = await resolvePinnedRevision({ pg, workflowCode: 'CODE_WF-RS', revision: 1 });
  assert.equal(v1.workflowRevisionId, 'rev-rs-1', '显式 revision=1 应物化 rev-rs-1');
  assert.deepEqual(v1.dag, DIAMOND);

  await assert.rejects(
    resolvePinnedRevision({ pg, workflowCode: 'CODE_WF-RS', revision: 99 }),
    (e) => e.code === 'WORKFLOW_REVISION_NOT_FOUND'
  );
  await assert.rejects(
    resolvePinnedRevision({ pg, workflowCode: 'CODE_NOPE' }),
    (e) => e.code === 'WORKFLOW_REVISION_NOT_FOUND'
  );
  await assert.rejects(
    resolvePinnedRevision({ pg, workflowCode: 'CODE_WF-RS', revision: 'latest' }),
    (e) => e.code === 'WORKFLOW_REVISION_REQUIRED'
  );
});

// ── L52：workflowCode+revision 经 run() 物化并 pin ────────────────────────
test('L52 run(workflowCode+revision)：物化并 pin 具体 revision', async () => {
  await seedRevision({ defId: 'wf-wc', revId: 'rev-wc-1', dag: DIAMOND, revNo: 1 });
  await seedRevision({ defId: 'wf-wc', revId: 'rev-wc-2', dag: CHAIN, revNo: 2 });
  const submitJob = makeSubmitJob();
  const ex = createWorkflowExecutor({ pg, submitJob });

  const res = await ex.run({ workflowCode: 'CODE_WF-WC', revision: 1, projectId: 'proj-wc', inputs: {} });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'succeeded');
  assert.equal(res.stepCount, 4, 'rev-1 为 DIAMOND（4 步）');

  const run = await pg.query(`SELECT workflow_revision_id, dag_snapshot FROM workflow_runs WHERE id = $1`, [res.runId]);
  assert.equal(run.rows[0].workflow_revision_id, 'rev-wc-1', 'run 应 pin rev-wc-1');
  assert.deepEqual(run.rows[0].dag_snapshot, DIAMOND);
});

// ── L52：运行中并发追加新 ACTIVE revision，新/旧 run 互不影响 ────────────
test('L52 并发：运行中追加新 ACTIVE revision → 新 run 用新 revision、旧 run 快照不受影响', async () => {
  await seedRevision({ defId: 'wf-cc', revId: 'rev-cc-1', dag: DIAMOND, revNo: 1 });

  // run A（rev-1）：第一步挂起 → run 处于 running
  const submitA = makeGatedSubmitJob();
  const exA = createWorkflowExecutor({ pg, submitJob: submitA });
  const pA = exA.run({ workflowRevisionId: 'rev-cc-1', projectId: 'proj-cc-a', inputs: { tag: 'A' } });

  // 等 run A 第一步进入 running（已派发但挂起）
  await waitFor(async () => {
    const r = await pg.query(`SELECT count(*)::int AS c FROM workflow_step_runs WHERE status = 'running'`);
    return r.rows[0].c >= 1;
  });

  // 运行中追加新 revision（rev-2 成为当前 ACTIVE）
  await seedRevision({ defId: 'wf-cc', revId: 'rev-cc-2', dag: CHAIN, revNo: 2 });

  // 新 run B 用当前 ACTIVE revision（resolvePinnedRevision 未给 revision → rev-2 物化）
  const resolved = await resolvePinnedRevision({ pg, workflowCode: 'CODE_WF-CC' });
  assert.equal(resolved.workflowRevisionId, 'rev-cc-2', '运行中追加后当前 ACTIVE 应为 rev-cc-2');

  const submitB = makeSubmitJob();
  const exB = createWorkflowExecutor({ pg, submitJob: submitB });
  const rB = await exB.run({ workflowRevisionId: resolved.workflowRevisionId, projectId: 'proj-cc-b', inputs: { tag: 'B' } });
  assert.equal(rB.status, 'succeeded');

  // 释放 run A → 完成
  submitA.release();
  const rA = await pA;
  assert.equal(rA.status, 'succeeded');

  // 快照互不影响
  const a = await pg.query(`SELECT workflow_revision_id, dag_snapshot FROM workflow_runs WHERE id = $1`, [rA.runId]);
  const b = await pg.query(`SELECT workflow_revision_id, dag_snapshot FROM workflow_runs WHERE id = $1`, [rB.runId]);
  assert.equal(a.rows[0].workflow_revision_id, 'rev-cc-1', '旧 run 仍 pin rev-cc-1');
  assert.deepEqual(a.rows[0].dag_snapshot, DIAMOND, '旧 run 快照仍为 DIAMOND（rev-1）');
  assert.equal(b.rows[0].workflow_revision_id, 'rev-cc-2', '新 run pin rev-cc-2');
  assert.deepEqual(b.rows[0].dag_snapshot, CHAIN, '新 run 快照为 CHAIN（rev-2）');

  const stepsA = await pg.query(`SELECT step_key FROM workflow_step_runs WHERE workflow_run_id = $1 ORDER BY step_key`, [rA.runId]);
  const stepsB = await pg.query(`SELECT step_key FROM workflow_step_runs WHERE workflow_run_id = $1 ORDER BY step_key`, [rB.runId]);
  assert.deepEqual(stepsA.rows.map((x) => x.step_key), ['s1', 's2', 's3', 's4'], '旧 run 按 DIAMOND 4 步');
  assert.deepEqual(stepsB.rows.map((x) => x.step_key), ['s1', 's2', 's3'], '新 run 按 CHAIN 3 步');
});

// ── L52：运行后改 def（追加 revision/改名）不波及既有 run ─────────────────
test('L52 运行后改 def（追加 revision/改名）不波及既有 run 的 pin 与快照', async () => {
  await seedRevision({ defId: 'wf-def', revId: 'rev-def-1', dag: DIAMOND, revNo: 1 });
  const ex = createWorkflowExecutor({ pg, submitJob: makeSubmitJob() });
  const res = await ex.run({ workflowRevisionId: 'rev-def-1', projectId: 'proj-def', inputs: {} });
  assert.equal(res.status, 'succeeded');

  // 运行后：追加新 revision（成为新 ACTIVE）+ 改写定义名称
  await seedRevision({ defId: 'wf-def', revId: 'rev-def-2', dag: CHAIN, revNo: 2 });
  await pg.query(`UPDATE workflow_definitions SET name = 'WF renamed' WHERE id = 'wf-def'`);

  const run = await pg.query(`SELECT workflow_revision_id, dag_snapshot FROM workflow_runs WHERE id = $1`, [res.runId]);
  assert.equal(run.rows[0].workflow_revision_id, 'rev-def-1', '既有 run 仍 pin rev-def-1');
  assert.deepEqual(run.rows[0].dag_snapshot, DIAMOND, '既有 run 快照仍为 DIAMOND（不随 ACTIVE 前移漂移）');

  // 新解析取到新 ACTIVE revision
  const cur = await resolvePinnedRevision({ pg, workflowCode: 'CODE_WF-DEF' });
  assert.equal(cur.workflowRevisionId, 'rev-def-2', '新增后当前 ACTIVE 应为 rev-def-2');
});
