'use strict';
/**
 * 0072 workflow_runs + workflow_step_runs schema tests（L50, G12）。
 *
 * 覆盖：
 *   1. 两表落库（information_schema 可见）。
 *   2. workflow_runs 列集 + status CHECK（接受 6 词表值、拒绝词表外、缺省 queued）。
 *   3. dag_snapshot NOT NULL 强制（23502）；failure_policy_snapshot 可空/可写。
 *   4. workflow_revision_id FK 强制（缺父 23503）+ ON DELETE RESTRICT（被 run 引用禁删）。
 *   5. workflow_step_runs 列集 + status CHECK（6 词表）+ attempt_count 缺省 0。
 *   6. workflow_run_id FK CASCADE（删 run 级联删 step_runs）。
 *   7. UNIQUE(workflow_run_id, step_key)（重复 23505；同 run 不同 step / 不同 run 同 step 放行）。
 *   8. pin 快照语义（§95）：run 落库后改写 revision.dag → run.dag_snapshot 不变；
 *      追加新 revision 行 → 旧 run 仍 pin 旧 revision、快照仍为旧 DAG。
 *
 * 运行：TEST_PG_PORT=54329 node --test server/db/workflow-runs-schema.test.cjs
 * （throwaway PG；本测试应用 0071 + 0072 两文件，自包含——0072 FK 引用 0071 的 workflow_revisions。）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const MIGRATIONS = [
  path.join(__dirname, 'migrations', '0071_workflow_definitions.sql'),
  path.join(__dirname, 'migrations', '0072_workflow_runs.sql'),
];

const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';

const adminPool = new Pool({
  host: pgHost, port: pgPort, user: pgUser, password: pgPass,
  database: 'postgres', max: 1,
});

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

async function createTestDb(suffix) {
  const dbName = `moling_wf_run_test_${suffix}`;
  await adminPool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  return dbName;
}

async function dropTestDb(dbName) {
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch (_) { /* best-effort teardown */ }
}

async function expectError(promise, code, label) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `${label}: 预期 SQLSTATE ${code} 的报错，实际未报错`);
  assert.equal(err.code, code, `${label}: 预期 SQLSTATE ${code}，实际 ${err.code}（${err.message}）`);
}

let dbName;
let pg;

test.before(async () => {
  dbName = await createTestDb(randomSuffix());
  pg = new Pool({
    host: pgHost, port: pgPort, user: pgUser, password: pgPass,
    database: dbName, max: 1,
  });
  for (const f of MIGRATIONS) {
    const sql = fs.readFileSync(f, 'utf8');
    await pg.query(sql);
  }
});

test.after(async () => {
  if (pg) { await pg.end().catch(() => {}); }
  if (dbName) { await dropTestDb(dbName); }
  await adminPool.end().catch(() => {});
});

// 一个可复用的父链：definition → revision(rev1, dag D1) → run R1 → 2 step_runs。
async function seedFixture() {
  await pg.query(
    `INSERT INTO workflow_definitions (id, code, name, status) VALUES ('wf-a', 'CODE_A', 'WF A', 'active')`);
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, version_code, dag, failure_policy, runtime_contract_revision)
     VALUES ('rev-1', 'wf-a', 1, 'v1.0.0', $1::jsonb, $2::jsonb, 'v3')`,
    [JSON.stringify(DAG1), JSON.stringify(FP1)]);
  await pg.query(
    `INSERT INTO workflow_runs (id, workflow_revision_id, project_id, status, dag_snapshot, failure_policy_snapshot)
     VALUES ('run-1', 'rev-1', 'proj-1', 'queued', $1::jsonb, $2::jsonb)`,
    [JSON.stringify(DAG1), JSON.stringify(FP1)]);
  await pg.query(
    `INSERT INTO workflow_step_runs (id, workflow_run_id, step_key, status, attempt_count)
     VALUES ('sr-1', 'run-1', 's1', 'pending', 0),
            ('sr-2', 'run-1', 's2', 'pending', 0)`);
}

const DAG1 = {
  nodes: [
    { step_id: 's1', kind: 'operation', operation_id: 'op-a', dependencies: [], failure_policy: 'FAIL_WORKFLOW' },
    { step_id: 's2', kind: 'operation', operation_id: 'op-b', dependencies: ['s1'], failure_policy: 'RETRY_STEP' },
  ],
  edges: [{ from: 's1', to: 's2' }],
};
const DAG2 = {
  nodes: [
    { step_id: 's1', kind: 'operation', operation_id: 'op-a', dependencies: [], failure_policy: 'FAIL_WORKFLOW' },
    { step_id: 's2', kind: 'operation', operation_id: 'op-b', dependencies: ['s1'], failure_policy: 'SKIP_STEP' },
    { step_id: 's3', kind: 'operation', operation_id: 'op-c', dependencies: ['s2'], failure_policy: 'FAIL_WORKFLOW' },
  ],
  edges: [{ from: 's1', to: 's2' }, { from: 's2', to: 's3' }],
};
const FP1 = { default: 'FAIL_WORKFLOW', steps: { s1: 'RETRY_STEP' } };

test('0072: workflow_runs + workflow_step_runs 两表落库', async () => {
  const r = await pg.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('workflow_runs', 'workflow_step_runs')
    ORDER BY table_name`);
  assert.deepEqual(r.rows.map(x => x.table_name),
    ['workflow_runs', 'workflow_step_runs'], '两表均应在 public schema 落库');
});

test('0072: workflow_runs 列集与 status CHECK（词表+缺省）', async () => {
  const cols = await pg.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'workflow_runs' ORDER BY ordinal_position`);
  assert.deepEqual(cols.rows.map(x => x.column_name),
    ['id', 'workflow_revision_id', 'project_id', 'status', 'dag_snapshot',
     'failure_policy_snapshot', 'started_at', 'finished_at', 'created_at'],
    'workflow_runs 列集应对齐规范');

  // 先造一个合法 revision 供 run 引用
  await pg.query(`INSERT INTO workflow_definitions (id, code, name, status) VALUES ('wf-s', 'CODE_S', 'WF S', 'active')`);
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('rev-s', 'wf-s', 1, '{}'::jsonb, 'v3')`);

  // status CHECK 词表全接受
  for (const s of ['queued', 'running', 'succeeded', 'failed', 'canceled', 'parked']) {
    await pg.query(
      `INSERT INTO workflow_runs (id, workflow_revision_id, status, dag_snapshot) VALUES ($1, 'rev-s', $2, '{}'::jsonb)`,
      [`run-${s}`, s]);
  }
  const n = await pg.query(`SELECT count(*)::int AS c FROM workflow_runs`);
  assert.equal(n.rows[0].c, 6, '6 个 status 词表值均应落库');

  // 缺省 queued
  await pg.query(
    `INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot) VALUES ('run-default', 'rev-s', '{}'::jsonb)`);
  const d = await pg.query(`SELECT status FROM workflow_runs WHERE id = 'run-default'`);
  assert.equal(d.rows[0].status, 'queued', 'status 缺省应为 queued');

  // 词表外值拒绝
  await expectError(
    pg.query(`INSERT INTO workflow_runs (id, workflow_revision_id, status, dag_snapshot) VALUES ('run-bogus', 'rev-s', 'bogus', '{}'::jsonb)`),
    '23514', 'status 词表外值');
});

test('0072: dag_snapshot NOT NULL + failure_policy_snapshot 可空/可写', async () => {
  await pg.query(`INSERT INTO workflow_definitions (id, code, name) VALUES ('wf-n', 'CODE_N', 'WF N')`);
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('rev-n', 'wf-n', 1, '{}'::jsonb, 'v3')`);
  await expectError(
    pg.query(`INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot) VALUES ('run-nodag', 'rev-n', NULL)`),
    '23502', 'dag_snapshot 为 NULL 应被 NOT NULL 拒绝');

  const ins = await pg.query(
    `INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot, failure_policy_snapshot)
     VALUES ('run-fp', 'rev-n', $1::jsonb, $2::jsonb) RETURNING failure_policy_snapshot`,
    [JSON.stringify(DAG1), JSON.stringify(FP1)]);
  assert.deepEqual(ins.rows[0].failure_policy_snapshot, FP1, 'failure_policy_snapshot JSONB 应读回');

  const nul = await pg.query(
    `INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot) VALUES ('run-nofp', 'rev-n', '{}'::jsonb) RETURNING failure_policy_snapshot`);
  assert.equal(nul.rows[0].failure_policy_snapshot, null, 'failure_policy_snapshot 应可 NULL');
});

test('0072: workflow_revision_id FK 强制 + ON DELETE RESTRICT', async () => {
  await pg.query(`INSERT INTO workflow_definitions (id, code, name) VALUES ('wf-f', 'CODE_F', 'WF F')`);
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('rev-f', 'wf-f', 1, '{}'::jsonb, 'v3')`);

  // 缺父 revision → FK 拒绝
  await expectError(
    pg.query(`INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot) VALUES ('run-orphan', 'rev-missing', '{}'::jsonb)`),
    '23503', 'workflow_revision_id 引用不存在的 revision 应被 FK 拒绝');

  // 有 run 引用的 revision 禁删（RESTRICT）
  await pg.query(
    `INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot) VALUES ('run-f1', 'rev-f', '{}'::jsonb)`);
  await expectError(
    pg.query(`DELETE FROM workflow_revisions WHERE id = 'rev-f'`),
    '23503', '被 run 引用的 revision 删除应被 ON DELETE RESTRICT 拒绝');
});

test('0072: workflow_step_runs 列集 + status CHECK + attempt_count 缺省', async () => {
  const cols = await pg.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'workflow_step_runs' ORDER BY ordinal_position`);
  assert.deepEqual(cols.rows.map(x => x.column_name),
    ['id', 'workflow_run_id', 'step_key', 'job_id', 'status', 'attempt_count',
     'error_code', 'started_at', 'finished_at'],
    'workflow_step_runs 列集应对齐规范');

  await pg.query(`INSERT INTO workflow_definitions (id, code, name) VALUES ('wf-st', 'CODE_ST', 'WF ST')`);
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('rev-st', 'wf-st', 1, '{}'::jsonb, 'v3')`);
  await pg.query(
    `INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot) VALUES ('run-st', 'rev-st', '{}'::jsonb)`);

  // status CHECK 词表全接受 + attempt_count 缺省 0 + job_id/error_code 可空
  for (const s of ['pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled']) {
    await pg.query(
      `INSERT INTO workflow_step_runs (id, workflow_run_id, step_key, status) VALUES ($1, 'run-st', $2, $3)`,
      [`srs-${s}`, `step-${s}`, s]);
  }
  const r = await pg.query(
    `SELECT status, attempt_count, job_id, error_code FROM workflow_step_runs WHERE id = 'srs-pending'`);
  assert.equal(r.rows[0].status, 'pending', 'pending 应落库');
  assert.equal(r.rows[0].attempt_count, 0, 'attempt_count 缺省应为 0');
  assert.equal(r.rows[0].job_id, null, 'job_id 应可 NULL');
  assert.equal(r.rows[0].error_code, null, 'error_code 应可 NULL');

  await expectError(
    pg.query(`INSERT INTO workflow_step_runs (id, workflow_run_id, step_key, status) VALUES ('srs-bogus', 'run-st', 'step-bogus', 'bogus')`),
    '23514', 'status 词表外值');
});

test('0072: workflow_run_id FK CASCADE（删 run 级联删 step_runs）', async () => {
  await pg.query(`INSERT INTO workflow_definitions (id, code, name) VALUES ('wf-c', 'CODE_C', 'WF C')`);
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('rev-c', 'wf-c', 1, '{}'::jsonb, 'v3')`);
  await pg.query(
    `INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot) VALUES ('run-c', 'rev-c', '{}'::jsonb)`);
  await pg.query(
    `INSERT INTO workflow_step_runs (id, workflow_run_id, step_key) VALUES ('srs-c1', 'run-c', 's1')`);

  await pg.query(`DELETE FROM workflow_runs WHERE id = 'run-c'`);
  const remain = await pg.query(`SELECT count(*)::int AS c FROM workflow_step_runs WHERE workflow_run_id = 'run-c'`);
  assert.equal(remain.rows[0].c, 0, '删除 run 后其 step_runs 应级联删除');
});

test('0072: UNIQUE(workflow_run_id, step_key)', async () => {
  await pg.query(`INSERT INTO workflow_definitions (id, code, name) VALUES ('wf-u', 'CODE_U', 'WF U')`);
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('rev-u', 'wf-u', 1, '{}'::jsonb, 'v3')`);
  await pg.query(
    `INSERT INTO workflow_runs (id, workflow_revision_id, dag_snapshot) VALUES ('run-u1', 'rev-u', '{}'::jsonb), ('run-u2', 'rev-u', '{}'::jsonb)`);
  await pg.query(
    `INSERT INTO workflow_step_runs (id, workflow_run_id, step_key) VALUES ('srs-u1', 'run-u1', 'shared')`);

  // 同一 run 内重复 step_key → 拒绝
  await expectError(
    pg.query(`INSERT INTO workflow_step_runs (id, workflow_run_id, step_key) VALUES ('srs-u1b', 'run-u1', 'shared')`),
    '23505', '同 run 内重复 step_key 应被 UNIQUE 拒绝');
  // 不同 run 同 step_key 放行（UNIQUE 作用域 = workflow_run_id + step_key）
  const ok = await pg.query(
    `INSERT INTO workflow_step_runs (id, workflow_run_id, step_key) VALUES ('srs-u2', 'run-u2', 'shared') RETURNING step_key`);
  assert.equal(ok.rows[0].step_key, 'shared', '不同 run 同 step_key 应放行');
});

test('0072: pin 快照语义（§95）——改 revision 不影响 run 快照列', async () => {
  await seedFixture();

  // 1) 落库读回：run 快照 = 执行时 revision 的 DAG/FP
  const before = await pg.query(
    `SELECT dag_snapshot, failure_policy_snapshot, workflow_revision_id FROM workflow_runs WHERE id = 'run-1'`);
  assert.deepEqual(before.rows[0].dag_snapshot, DAG1, 'run.dag_snapshot 应等于执行时 DAG1');
  assert.deepEqual(before.rows[0].failure_policy_snapshot, FP1, 'run.failure_policy_snapshot 应等于执行时 FP1');
  assert.equal(before.rows[0].workflow_revision_id, 'rev-1', 'run 应 pin rev-1');

  // 2) 改写 revision.dag → run.dag_snapshot 不变（快照是物化副本，非引用）
  await pg.query(`UPDATE workflow_revisions SET dag = $1::jsonb, failure_policy = $2::jsonb WHERE id = 'rev-1'`,
    [JSON.stringify(DAG2), JSON.stringify({ default: 'SKIP_STEP' })]);
  const after = await pg.query(
    `SELECT dag_snapshot, failure_policy_snapshot FROM workflow_runs WHERE id = 'run-1'`);
  assert.deepEqual(after.rows[0].dag_snapshot, DAG1, '改 revision 后 run.dag_snapshot 应仍为 DAG1（快照不随 revision 漂移）');
  assert.deepEqual(after.rows[0].failure_policy_snapshot, FP1, '改 revision 后 run.failure_policy_snapshot 应仍为 FP1');

  // 3) 追加新 revision（§95 immutable 正路）→ 旧 run 仍 pin 旧 revision，快照仍为旧 DAG
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('rev-2', 'wf-a', 2, $1::jsonb, 'v3')`, [JSON.stringify(DAG2)]);
  const pinned = await pg.query(
    `SELECT workflow_revision_id, dag_snapshot FROM workflow_runs WHERE id = 'run-1'`);
  assert.equal(pinned.rows[0].workflow_revision_id, 'rev-1', '追加新 revision 后 run 仍 pin rev-1（禁止默认 latest）');
  assert.deepEqual(pinned.rows[0].dag_snapshot, DAG1, '追加新 revision 后 run.dag_snapshot 仍为旧 DAG1');

  // 4) step_runs 关联完整性：run-1 有 2 个 step，且 step_key 唯一
  const steps = await pg.query(
    `SELECT step_key FROM workflow_step_runs WHERE workflow_run_id = 'run-1' ORDER BY step_key`);
  assert.deepEqual(steps.rows.map(x => x.step_key), ['s1', 's2'], 'run-1 应有 s1/s2 两个 step');
});
