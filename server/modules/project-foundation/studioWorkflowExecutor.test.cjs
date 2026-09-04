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
const { createWorkflowExecutor, validateWorkflowDag, resolveWorkflowFailureMode } = require('./studioRunEngine.cjs');

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
