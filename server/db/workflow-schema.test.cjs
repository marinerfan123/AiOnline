'use strict';
/**
 * 0071 workflow_definitions + workflow_revisions schema tests（L49, G12）。
 *
 * 覆盖：
 *   1. 两表落库（information_schema 可见）。
 *   2. workflow_definitions 列集 + status CHECK（接受 4 词表值、拒绝词表外、缺省 draft）。
 *   3. workflow_definitions.code UNIQUE（重复 23505）；name NOT NULL 强制。
 *   4. workflow_revisions dag / runtime_contract_revision NOT NULL 强制（23502）。
 *   5. runtime_contract_revision 禁 'latest'（CHECK，23514；§100/§95）。
 *   6. UNIQUE(workflow_id, revision) + revision>=1 CHECK（重复 23505 / revision=0 23514）。
 *   7. workflow_id FK 强制（缺父 23503）+ ON DELETE CASCADE。
 *   8. dag JSONB（nodes+edges）落库读回；failure_policy JSONB 可空/可写。
 *
 * 运行：TEST_PG_PORT=54329 node --test server/db/workflow-schema.test.cjs
 * （throwaway PG；本测试只应用 0071 单一文件，自包含，不依赖全量迁移链。）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const MIGRATION_FILE = path.join(__dirname, 'migrations', '0071_workflow_definitions.sql');

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
  const dbName = `moling_wf_schema_test_${suffix}`;
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
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  await pg.query(sql); // 只应用 0071 单一文件
});

test.after(async () => {
  if (pg) { await pg.end().catch(() => {}); }
  if (dbName) { await dropTestDb(dbName); }
  await adminPool.end().catch(() => {});
});

test('0071: workflow_definitions + workflow_revisions 两表落库', async () => {
  const r = await pg.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('workflow_definitions', 'workflow_revisions')
    ORDER BY table_name`);
  assert.deepEqual(r.rows.map(x => x.table_name),
    ['workflow_definitions', 'workflow_revisions'], '两表均应在 public schema 落库');
});

test('0071: workflow_definitions 列集与 status CHECK（词表+缺省）', async () => {
  const cols = await pg.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'workflow_definitions' ORDER BY ordinal_position`);
  assert.deepEqual(cols.rows.map(x => x.column_name),
    ['id', 'code', 'name', 'media_type', 'status', 'created_at'],
    'workflow_definitions 列集应对齐规范');

  // status CHECK 词表全接受
  for (const s of ['draft', 'active', 'deprecated', 'retired']) {
    await pg.query(
      `INSERT INTO workflow_definitions (id, code, name, status) VALUES ($1, $2, $3, $4)`,
      [`wf-${s}`, `CODE_${s.toUpperCase()}`, `Workflow ${s}`, s]);
  }
  const n = await pg.query(`SELECT count(*)::int AS c FROM workflow_definitions`);
  assert.equal(n.rows[0].c, 4, '4 个 status 词表值均应落库');

  // 缺省 draft
  await pg.query(
    `INSERT INTO workflow_definitions (id, code, name) VALUES ('wf-default', 'CODE_DEFAULT', 'Default')`);
  const d = await pg.query(`SELECT status FROM workflow_definitions WHERE id = 'wf-default'`);
  assert.equal(d.rows[0].status, 'draft', 'status 缺省应为 draft');

  // 词表外值拒绝
  await expectError(
    pg.query(`INSERT INTO workflow_definitions (id, code, name, status) VALUES ('wf-bogus', 'CODE_BOGUS', 'Bogus', 'bogus')`),
    '23514', 'status 词表外值');
});

test('0071: workflow_definitions.code UNIQUE + name NOT NULL', async () => {
  await expectError(
    pg.query(`INSERT INTO workflow_definitions (id, code, name) VALUES ('wf-dup', 'CODE_ACTIVE', 'Dup')`),
    '23505', '重复 code 应被 UNIQUE 拒绝');
  await expectError(
    pg.query(`INSERT INTO workflow_definitions (id, code) VALUES ('wf-noname', 'CODE_NONAME')`),
    '23502', 'name 缺失应被 NOT NULL 拒绝');
  // media_type 可空
  const m = await pg.query(
    `INSERT INTO workflow_definitions (id, code, name, media_type) VALUES ('wf-media', 'CODE_MEDIA', 'Media', NULL) RETURNING media_type`);
  assert.equal(m.rows[0].media_type, null, 'media_type 应可 NULL');
});

test('0071: workflow_revisions dag / runtime_contract_revision NOT NULL 强制', async () => {
  await expectError(
    pg.query(`INSERT INTO workflow_revisions (id, workflow_id, revision, dag) VALUES ('r-nodag', 'wf-active', 1, NULL)`),
    '23502', 'dag 为 NULL 应被 NOT NULL 拒绝');
  await expectError(
    pg.query(`INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
              VALUES ('r-nortcr', 'wf-active', 1, '{}'::jsonb, NULL)`),
    '23502', 'runtime_contract_revision 为 NULL 应被 NOT NULL 拒绝');
});

test('0071: runtime_contract_revision 禁 latest（§100/§95）', async () => {
  await expectError(
    pg.query(`INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
              VALUES ('r-latest', 'wf-active', 1, '{}'::jsonb, 'latest')`),
    '23514', "runtime_contract_revision='latest' 应被 CHECK 拒绝");
  const ok = await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('r-v3', 'wf-active', 1, '{}'::jsonb, 'v3') RETURNING runtime_contract_revision`);
  assert.equal(ok.rows[0].runtime_contract_revision, 'v3', '显式 pin 修订应放行');
});

test('0071: UNIQUE(workflow_id, revision) + revision>=1 CHECK', async () => {
  await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('r-d1', 'wf-draft', 1, '{}'::jsonb, 'v1')`);
  await expectError(
    pg.query(`INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
              VALUES ('r-d2', 'wf-draft', 1, '{}'::jsonb, 'v1')`),
    '23505', '同 (workflow_id, revision) 重复应被 UNIQUE 拒绝');
  await expectError(
    pg.query(`INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
              VALUES ('r-d0', 'wf-draft', 0, '{}'::jsonb, 'v1')`),
    '23514', 'revision=0 应被 CHECK(revision>=1) 拒绝');
  // 不同 workflow 同 revision 放行（UNIQUE 作用域 = workflow_id+revision）
  const ok = await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('r-d3', 'wf-retired', 1, '{}'::jsonb, 'v1') RETURNING revision`);
  assert.equal(ok.rows[0].revision, 1, '不同 workflow 同 revision 应放行');
});

test('0071: workflow_id FK 强制 + ON DELETE CASCADE', async () => {
  await expectError(
    pg.query(`INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
              VALUES ('r-orphan', 'wf-missing', 1, '{}'::jsonb, 'v1')`),
    '23503', 'workflow_id 引用不存在的定义应被 FK 拒绝');
  // 删除定义 → 修订级联删除
  await pg.query(`INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
                  VALUES ('r-c1', 'wf-media', 1, '{}'::jsonb, 'v1')`);
  await pg.query(`DELETE FROM workflow_definitions WHERE id = 'wf-media'`);
  const remain = await pg.query(`SELECT count(*)::int AS c FROM workflow_revisions WHERE workflow_id = 'wf-media'`);
  assert.equal(remain.rows[0].c, 0, '删除定义后其修订应级联删除');
});

test('0071: dag JSONB（nodes+edges）落库读回 + failure_policy 可空/可写', async () => {
  const dag = {
    nodes: [
      {
        step_id: 's1', kind: 'operation', operation_id: 'op-gen-video',
        dependencies: [], input_mapping: {}, output_mapping: {},
        retry_policy: { max_attempts: 3 }, failure_policy: 'FAIL_WORKFLOW',
      },
      {
        step_id: 's2', kind: 'operation', operation_id: 'op-finalize',
        dependencies: ['s1'], input_mapping: {}, output_mapping: {},
        retry_policy: { max_attempts: 2 }, failure_policy: 'RETRY_STEP',
      },
    ],
    edges: [{ from: 's1', to: 's2' }],
  };
  const fp = { default: 'FAIL_WORKFLOW', steps: { s1: 'RETRY_STEP' } };
  const ins = await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, version_code, dag, failure_policy, runtime_contract_revision)
     VALUES ('r-dag', 'wf-active', 2, 'v1.2.0', $1::jsonb, $2::jsonb, 'v3')
     RETURNING dag, failure_policy, version_code`,
    [JSON.stringify(dag), JSON.stringify(fp)]);
  assert.equal(ins.rows[0].version_code, 'v1.2.0', 'version_code 应落库');
  assert.deepEqual(ins.rows[0].dag.nodes.length, 2, 'dag.nodes 应含 2 节点');
  assert.deepEqual(ins.rows[0].dag.edges, [{ from: 's1', to: 's2' }], 'dag.edges 应读回');
  assert.equal(ins.rows[0].dag.nodes[1].dependencies[0], 's1', '节点依赖应读回');
  assert.deepEqual(ins.rows[0].failure_policy, fp, 'failure_policy JSONB 应读回');

  // failure_policy 可空
  const nul = await pg.query(
    `INSERT INTO workflow_revisions (id, workflow_id, revision, dag, runtime_contract_revision)
     VALUES ('r-nofp', 'wf-retired', 2, '{}'::jsonb, 'v2') RETURNING failure_policy`);
  assert.equal(nul.rows[0].failure_policy, null, 'failure_policy 应可 NULL');
});
