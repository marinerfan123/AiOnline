'use strict';
/**
 * M05-D1 — Migration 0015 (studio run engine) schema tests.
 * LOCAL TEST DB ONLY. Verifies tables, FKs, uniques, and indexes so the
 * durable scheduling path (lease/retry/status) runs on an indexed plan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { initTestSchema } = require('../tests/helpers/test-db.cjs');

const MIGRATIONS = [
  '0012_project_workspace_foundation.sql',
  '0013_asset_foundation.sql',
  '0014_studio_canvas_persistence.sql',
  '0015_studio_run_engine.sql',
];

const ADMIN_HOST = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const ADMIN_PORT = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const ADMIN_USER = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const ADMIN_PW = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || process.env.PGPASSWORD || '0.0.1abcd';

function poolConfig(database, max = 8) {
  return { host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, password: ADMIN_PW, database, max };
}

async function bootstrap() {
  const admin = new Pool(poolConfig('postgres', 1));
  const name = `moling_m05d_mig_${crypto.randomBytes(4).toString('hex')}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const pg = new Pool(poolConfig(name));
  await initTestSchema(pg);
  for (const m of MIGRATIONS) {
    await pg.query(fs.readFileSync(path.resolve(__dirname, 'migrations', m), 'utf8'));
  }
  return { dbName: name, pg };
}

async function dropDb(name) {
  try {
    const admin = new Pool(poolConfig('postgres', 1));
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  } catch (_) {}
}

/** Seed minimal FK parents: user/workspace/project/canvas. */
async function seedParents(pg) {
  const user = `u-${crypto.randomUUID()}`;
  await pg.query(`INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits, role, status) VALUES ($1,'mig@test.local','Mig','x',0,0,'user','active')`, [user]);
  const ws = `ws-${crypto.randomUUID()}`;
  await pg.query(`INSERT INTO workspaces (id, name, owner_id) VALUES ($1,'Mig WS',$2)`, [ws, user]);
  const proj = `proj-${crypto.randomUUID()}`;
  await pg.query(`INSERT INTO projects (id, workspace_id, owner_id, name, project_type, status) VALUES ($1,$2,$3,'Mig','studio','active')`, [proj, ws, user]);
  const canvas = `canvas-${crypto.randomUUID()}`;
  await pg.query(`INSERT INTO studio_canvases (id, project_id, workspace_id, name, revision, schema_version, created_by, updated_by) VALUES ($1,$2,$3,'C',1,1,$4,$4)`, [canvas, proj, ws, user]);
  return { user, ws, proj, canvas };
}

test('migration 0015 creates the durable studio run engine schema', { concurrency: 1 }, async () => {
  const { dbName, pg } = await bootstrap();
  try {
    const tables = ['studio_runs', 'studio_run_nodes', 'studio_run_node_edges', 'studio_run_events'];
    for (const t of tables) {
      const r = await pg.query(`SELECT 1 FROM information_schema.tables WHERE table_name=$1`, [t]);
      assert.equal(r.rows.length, 1, `${t} exists`);
    }
    // studio_runs: idempotency unique is scoped to (canvas_id, idempotency_key)
    // (inline table unique). A project-level idempotency unique would be
    // over-constraining and does NOT exist.
    const uniques = (await pg.query(`SELECT indexname FROM pg_indexes WHERE tablename='studio_runs'`)).rows.map((x) => x.indexname);
    assert.ok(uniques.some((n) => n.includes('canvas_id') && n.includes('idempotency_key')), 'unique (canvas_id, idempotency_key) present');
    assert.ok(!uniques.includes('uq_studio_runs_idempotency'), 'no over-constraining project-level idempotency unique');
    // node-level identity unique
    const nodeIdx = (await pg.query(`SELECT indexname FROM pg_indexes WHERE tablename='studio_run_nodes'`)).rows.map((x) => x.indexname);
    assert.ok(nodeIdx.some((n) => n.includes('studio_node_id') && n.startsWith('studio_run_nodes_')), 'unique (run_id, studio_node_id) present');
    // scheduling indexes (lease hot path + retry + expiry reaper)
    assert.ok(nodeIdx.includes('ix_studio_run_nodes_ready_eligible'), 'ready-eligible lease index present');
    assert.ok(nodeIdx.includes('ix_studio_run_nodes_lease_expires'), 'lease-expiry reaper index present');
    assert.ok(nodeIdx.includes('ix_studio_run_nodes_run_status'), 'run+status index present');
    // run list indexes
    assert.ok(uniques.includes('ix_studio_runs_project'), 'project list index present');
    assert.ok(uniques.includes('ix_studio_runs_status_created'), 'status+created index present');
    // edge FKs to run nodes (composite source + target) plus run_id FK to runs
    const fks = (await pg.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'studio_run_node_edges'::regclass AND contype='f' ORDER BY conname
    `)).rows;
    const fkDefs = fks.map((x) => x.def).join(' ');
    assert.ok(fkDefs.includes("REFERENCES studio_run_nodes(run_id, studio_node_id)"), 'composite FKs to run nodes present');
    assert.ok(fkDefs.includes("REFERENCES studio_runs(id)"), 'FK to studio_runs present');
    assert.equal(fks.length, 3, 'exactly 3 FKs on edges (source + target + run)');
    // events: run FK + indexes
    const evtIdx = (await pg.query(`SELECT indexname FROM pg_indexes WHERE tablename='studio_run_events'`)).rows.map((x) => x.indexname);
    assert.ok(evtIdx.includes('ix_studio_run_events_run'), 'events run index present');
    // CHECK constraints on statuses
    const checks = (await pg.query(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'studio_runs'::regclass AND contype='c'
    `)).rows.map((x) => x.def).join(' ');
    assert.ok(checks.includes("'COMPLETED'") && checks.includes("'CANCELLED'"), 'run status CHECK present');
    const nodeChecks = (await pg.query(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'studio_run_nodes'::regclass AND contype='c'
    `)).rows.map((x) => x.def).join(' ');
    assert.ok(nodeChecks.includes("'LEASED'") && nodeChecks.includes("'SKIPPED'"), 'node status CHECK present');
  } finally { await pg.end(); await dropDb(dbName); }
});

test('migration 0015: FKs, idempotency uniqueness, and ON DELETE semantics', { concurrency: 1 }, async () => {
  const { dbName, pg } = await bootstrap();
  try {
    const p = await seedParents(pg);
    const runId = `run-${crypto.randomUUID()}`;
    await pg.query(
      `INSERT INTO studio_runs (id, workspace_id, project_id, canvas_id, canvas_revision, canvas_schema_version, status, run_mode, compiled_graph_json, requested_by, idempotency_key)
       VALUES ($1,$2,$3,$4,1,1,'QUEUED','ALL','{}'::jsonb,$5,'key-1')`,
      [runId, p.ws, p.proj, p.canvas, p.user]
    );
    // duplicate (canvas_id, idempotency_key) rejected
    let dup = null;
    try {
      await pg.query(
        `INSERT INTO studio_runs (id, workspace_id, project_id, canvas_id, canvas_revision, canvas_schema_version, status, run_mode, compiled_graph_json, requested_by, idempotency_key)
         VALUES ($1,$2,$3,$4,1,1,'QUEUED','ALL','{}'::jsonb,$5,'key-1')`,
        [`run-${crypto.randomUUID()}`, p.ws, p.proj, p.canvas, p.user]
      );
    } catch (e) { dup = e.code; }
    assert.equal(dup, '23505', 'duplicate idempotency key on same canvas rejected (23505)');
    // same key on a DIFFERENT canvas is allowed (scope = canvas + key)
    const p2canvas = `canvas-${crypto.randomUUID()}`;
    await pg.query(`INSERT INTO studio_canvases (id, project_id, workspace_id, name, revision, schema_version, is_primary, created_by, updated_by) VALUES ($1,$2,$3,'C2',1,1,FALSE,$4,$4)`, [p2canvas, p.proj, p.ws, p.user]);
    await pg.query(
      `INSERT INTO studio_runs (id, workspace_id, project_id, canvas_id, canvas_revision, canvas_schema_version, status, run_mode, compiled_graph_json, requested_by, idempotency_key)
       VALUES ($1,$2,$3,$4,1,1,'QUEUED','ALL','{}'::jsonb,$5,'key-1')`,
      [`run-${crypto.randomUUID()}`, p.ws, p.proj, p2canvas, p.user]
    );
    // node row + edge rows
    const n1 = `srn-${crypto.randomUUID()}`;
    await pg.query(`INSERT INTO studio_run_nodes (id, run_id, studio_node_id, node_type, execution_kind, status, dependency_count, remaining_dependency_count, max_attempts) VALUES ($1,$2,'node-1','prompt','SOURCE','READY',0,0,3)`, [n1, runId]);
    const n2 = `srn-${crypto.randomUUID()}`;
    await pg.query(`INSERT INTO studio_run_nodes (id, run_id, studio_node_id, node_type, execution_kind, status, dependency_count, remaining_dependency_count, max_attempts) VALUES ($1,$2,'node-2','output','OUTPUT','BLOCKED',1,1,3)`, [n2, runId]);
    // duplicate (run_id, studio_node_id) rejected
    let nodeDup = null;
    try {
      await pg.query(`INSERT INTO studio_run_nodes (id, run_id, studio_node_id, node_type, execution_kind, status, dependency_count, remaining_dependency_count, max_attempts) VALUES ($1,$2,'node-1','prompt','SOURCE','READY',0,0,3)`, [`srn-${crypto.randomUUID()}`, runId]);
    } catch (e) { nodeDup = e.code; }
    assert.equal(nodeDup, '23505', 'duplicate (run_id, studio_node_id) rejected (23505)');
    await pg.query(`INSERT INTO studio_run_node_edges (run_id, source_node_id, target_node_id) VALUES ($1,'node-1','node-2')`, [runId]);
    // duplicate edge rejected
    let edgeDup = null;
    try { await pg.query(`INSERT INTO studio_run_node_edges (run_id, source_node_id, target_node_id) VALUES ($1,'node-1','node-2')`, [runId]); } catch (e) { edgeDup = e.code; }
    assert.equal(edgeDup, '23505', 'duplicate edge rejected (23505)');
    // FK: a run node with unknown run_id rejected
    let fkNode = null;
    try { await pg.query(`INSERT INTO studio_run_nodes (id, run_id, studio_node_id, node_type, execution_kind, status, dependency_count, remaining_dependency_count, max_attempts) VALUES ($1,'run-missing','x','prompt','SOURCE','READY',0,0,3)`, [`srn-${crypto.randomUUID()}`]); } catch (e) { fkNode = e.code; }
    assert.equal(fkNode, '23503', 'run node FK to studio_runs enforced (23503)');
    // event FK
    let fkEvt = null;
    try { await pg.query(`INSERT INTO studio_run_events (run_id, event_type, payload) VALUES ('run-missing','x','{}'::jsonb)`); } catch (e) { fkEvt = e.code; }
    assert.equal(fkEvt, '23503', 'event FK to studio_runs enforced (23503)');
    // ON DELETE CASCADE: deleting the run removes nodes/edges/events
    await pg.query(`INSERT INTO studio_run_events (run_id, run_node_id, event_type, payload) VALUES ($1,$2,'studio.run_node.started','{}'::jsonb)`, [runId, n1]);
    await pg.query(`DELETE FROM studio_runs WHERE id=$1`, [runId]);
    const remainNodes = (await pg.query(`SELECT COUNT(*)::int c FROM studio_run_nodes WHERE run_id=$1`, [runId])).rows[0].c;
    const remainEdges = (await pg.query(`SELECT COUNT(*)::int c FROM studio_run_node_edges WHERE run_id=$1`, [runId])).rows[0].c;
    const remainEvents = (await pg.query(`SELECT COUNT(*)::int c FROM studio_run_events WHERE run_id=$1`, [runId])).rows[0].c;
    assert.equal(remainNodes, 0, 'run nodes cascade-deleted');
    assert.equal(remainEdges, 0, 'run edges cascade-deleted');
    assert.equal(remainEvents, 0, 'run events cascade-deleted');
    // deleting the canvas cascades the run
    const runCountAfterCanvas = (await pg.query(`SELECT COUNT(*)::int c FROM studio_runs WHERE canvas_id=$1`, [p2canvas])).rows[0].c;
    assert.equal(runCountAfterCanvas, 1);
    await pg.query(`DELETE FROM studio_canvases WHERE id=$1`, [p2canvas]);
    const runCount2 = (await pg.query(`SELECT COUNT(*)::int c FROM studio_runs WHERE canvas_id=$1`, [p2canvas])).rows[0].c;
    assert.equal(runCount2, 0, 'runs cascade-delete when the canvas is deleted');
    // requested_by is RESTRICT: cannot delete the acting user while a run references them
    let restrict = null;
    try { await pg.query(`DELETE FROM users WHERE id=$1`, [p.user]); } catch (e) { restrict = e.code; }
    assert.equal(restrict, '23503', 'requested_by FK is RESTRICT (23503)');
  } finally { await pg.end(); await dropDb(dbName); }
});
