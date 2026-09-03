'use strict';
/**
 * M05-D1 — Shared bootstrap + seeding helpers for Studio Run engine tests.
 * LOCAL TEST DB ONLY (fresh database per test file; dropped afterwards).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { initTestSchema } = require('./test-db.cjs');
const { createStudioRunEngine } = require('../../modules/project-foundation/studioRunEngine.cjs');

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

async function createDb() {
  const admin = new Pool(poolConfig('postgres', 1));
  // Name MUST contain 'test' — the app-under-test refuses to boot against a
  // DB whose name lacks it (test-db.cjs guard). (G15 audit HIGH-1 fix.)
  const name = `moling_test_m05d_${crypto.randomBytes(4).toString('hex')}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return name;
}

async function dropDb(name) {
  try {
    const admin = new Pool(poolConfig('postgres', 1));
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  } catch (_) {}
}

/** Fresh DB + all migrations through 0015. Returns { dbName, pg }. */
async function bootstrapRunDb() {
  const dbName = await createDb();
  const pg = new Pool(poolConfig(dbName));
  await initTestSchema(pg);
  for (const m of MIGRATIONS) {
    await pg.query(fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'migrations', m), 'utf8'));
  }
  return { dbName, pg };
}

async function makeUser(pg, { email, role = 'user' } = {}) {
  const id = `u-${crypto.randomUUID()}`;
  await pg.query(
    `INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits, role, status)
     VALUES ($1,$2,'Test','x',0,100,$3,'active')`,
    [id, email || `t-${crypto.randomBytes(4).toString('hex')}@test.local`, role]
  );
  return { id, email, role };
}

/**
 * Seed a workspace + project + primary canvas + nodes + edges.
 * @returns {user, workspace, project, canvas, nodes, edges}
 */
async function seedProject(pg, { withNodes, nodeRows, edgeRows, secondUser } = {}) {
  const user = await makeUser(pg, {});
  const ws = `ws-${crypto.randomUUID()}`;
  await pg.query(`INSERT INTO workspaces (id, name, owner_id) VALUES ($1,'Test WS',$2)`, [ws, user.id]);
  await pg.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws, user.id]);
  const proj = `proj-${crypto.randomUUID()}`;
  await pg.query(
    `INSERT INTO projects (id, workspace_id, owner_id, name, project_type, status) VALUES ($1,$2,$3,'Run Test','studio','active')`,
    [proj, ws, user.id]
  );
  const canvas = `canvas-${crypto.randomUUID()}`;
  await pg.query(
    `INSERT INTO studio_canvases (id, project_id, workspace_id, name, revision, schema_version, created_by, updated_by)
     VALUES ($1,$2,$3,'Primary Canvas',1,1,$4,$4)`,
    [canvas, proj, ws, user.id]
  );
  let nodes = [];
  let edges = [];
  if (nodeRows && nodeRows.length) {
    for (const n of nodeRows) {
      await pg.query(
        `INSERT INTO studio_canvas_nodes (canvas_id, node_id, node_type, node_schema_version, position_x, position_y, data_json)
         VALUES ($1,$2,$3,$4,0,0,$5)`,
        [canvas, n.nodeId, n.nodeType, n.schemaVersion || 1, JSON.stringify(n.data || {})]
      );
    }
    nodes = nodeRows.map((n) => ({ nodeId: n.nodeId, nodeType: n.nodeType, nodeSchemaVersion: n.schemaVersion || 1, data: n.data || {} }));
  }
  if (edgeRows && edgeRows.length) {
    for (const e of edgeRows) {
      await pg.query(
        `INSERT INTO studio_canvas_edges (canvas_id, edge_id, source_node_id, source_handle, target_node_id, target_handle)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [canvas, e.edgeId, e.source, e.sourceHandle || null, e.target, e.targetHandle || null]
      );
    }
    edges = edgeRows.map((e) => ({ edgeId: e.edgeId, sourceNodeId: e.source, sourceHandle: e.sourceHandle || null, targetNodeId: e.target, targetHandle: e.targetHandle || null }));
  }
  if (secondUser) {
    const u2 = await makeUser(pg, {});
    const ws2 = `ws-${crypto.randomUUID()}`;
    await pg.query(`INSERT INTO workspaces (id, name, owner_id) VALUES ($1,'WS2',$2)`, [ws2, u2.id]);
    await pg.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws2, u2.id]);
    const proj2 = `proj-${crypto.randomUUID()}`;
    await pg.query(`INSERT INTO projects (id, workspace_id, owner_id, name, project_type, status) VALUES ($1,$2,$3,'P2','studio','active')`, [proj2, ws2, u2.id]);
    return { user, second: u2, workspace: ws, secondWorkspace: ws2, project: proj, secondProject: proj2, canvas, nodes, edges };
  }
  return { user, workspace: ws, project: proj, canvas, nodes, edges };
}

/** Standard node row builders (mirror of M05-B2 identities). */
const nodes = {
  prompt: (id, prompt = 'hello world') => ({ nodeId: id, nodeType: 'prompt', data: { nodeKind: 'prompt', schemaVersion: 1, status: 'READY', parameters: { prompt }, prompt } }),
  imageGen: (id) => ({ nodeId: id, nodeType: 'image-generation', data: { nodeKind: 'image-generation', schemaVersion: 1, status: 'READY', parameters: { logicalModelId: 'lm-1', aspectRatio: '1:1', resolution: '1024x1024' } } }),
  output: (id) => ({ nodeId: id, nodeType: 'output', data: { nodeKind: 'output', schemaVersion: 1, status: 'READY', parameters: { label: 'Out' } } }),
  frame: (id) => ({ nodeId: id, nodeType: 'frame', data: { nodeKind: 'frame', schemaVersion: 1, status: 'IDLE', parameters: { frameLabel: 'F' } } }),
  reference: (id, assetId = 'asset-1') => ({ nodeId: id, nodeType: 'reference', data: { nodeKind: 'reference', schemaVersion: 1, status: 'READY', parameters: { assetId, referenceRole: 'visual', weight: 0.7 }, assetId } }),
  video: (id, assetId = 'vasset-1') => ({ nodeId: id, nodeType: 'video', data: { nodeKind: 'video', schemaVersion: 1, status: 'READY', parameters: { assetId, playbackNote: '' }, assetId } }),
  character: (id, name = 'Hero') => ({ nodeId: id, nodeType: 'character', data: { nodeKind: 'character', schemaVersion: 1, status: 'READY', parameters: { name, description: 'a hero' } } }),
  script: (id, text = 'once upon a time') => ({ nodeId: id, nodeType: 'script', data: { nodeKind: 'script', schemaVersion: 1, status: 'READY', parameters: { scriptText: text, title: 'S' } } }),
};
const edge = (edgeId, source, target, sourceHandle, targetHandle) => ({ edgeId, source, target, sourceHandle, targetHandle });

/** Build a run engine bound to the shared pool (workerId unique per caller). */
function makeEngine(pg, { workerId, executors, leaseSeconds, retryBackoffMs, onLog } = {}) {
  return createStudioRunEngine({
    pg,
    workerId: workerId || `w-${crypto.randomBytes(3).toString('hex')}`,
    executors: executors || null,
    leaseSeconds,
    retryBackoffMs,
    onLog,
  });
}

/** Create a run through the authoritative domain op (createRunFromCanvas).
 *  The engine locks the canvas row, verifies the revision, loads the exact
 *  nodes/edges of that locked revision, compiles, and persists — one tx.
 *  `revision` override simulates a STALE request (must equal live revision). */
async function engineCreateRun(pg, engine, seeded, { idempotencyKey, runMode = 'ALL', selectedNodeIds, revision } = {}) {
  const requestedRevision = revision == null ? (await pg.query('SELECT revision FROM studio_canvases WHERE id=$1', [seeded.canvas])).rows[0].revision : revision;
  return engine.createRunFromCanvas({
    project: (await pg.query('SELECT * FROM projects WHERE id=$1', [seeded.project])).rows[0],
    canvasId: seeded.canvas,
    requestedCanvasRevision: requestedRevision,
    runMode, selectedNodeIds,
    idempotencyKey: idempotencyKey || `key-${crypto.randomBytes(4).toString('hex')}`,
    requestedBy: seeded.user.id,
  });
}

/** Bump the live canvas revision (simulates user editing while a run is active). */
async function bumpCanvasRevision(pg, canvasId, baseRevision) {
  const r = await pg.query(
    'UPDATE studio_canvases SET revision = revision + 1, updated_at = NOW() WHERE id = $1 AND revision = $2 RETURNING revision',
    [canvasId, baseRevision]
  );
  return r.rows[0] ? r.rows[0].revision : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a run to a terminal state by repeatedly ticking one engine worker.
 *  Used for end-to-end deterministic graphs (prompt/output nodes have real
 *  production executors). Returns the final run row. */
async function runToCompletion(pg, engine, runId, { maxTicks = 50, tickMs = 0 } = {}) {
  let last = null;
  for (let i = 0; i < maxTicks; i++) {
    if (tickMs) await sleep(tickMs);
    // eslint-disable-next-line no-await-in-loop
    await engine.workerTick({ concurrency: 2, batch: 8, retryBackoffMs: [1] });
    // eslint-disable-next-line no-await-in-loop
    await engine.reapExpiredNodes({ limit: 50 });
    // eslint-disable-next-line no-await-in-loop
    const r = await pg.query('SELECT * FROM studio_runs WHERE id=$1', [runId]);
    last = r.rows[0];
    if (last && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(last.status)) break;
  }
  return last;
}

/** Compiled graph snapshot persisted on a run (proves revision+graph binding). */
async function runCompiledGraph(pg, runId) {
  const r = await pg.query('SELECT canvas_revision, compiled_graph_json FROM studio_runs WHERE id=$1', [runId]);
  return r.rows[0] || null;
}

/** Set a node's lease to look expired (for reaper/reclaim tests without real waits). */
async function forceLeaseExpired(pg, runNodeId) {
  await pg.query(
    'UPDATE studio_run_nodes SET lease_expires_at = NOW() - INTERVAL \'1 second\', heartbeat_at = NOW() - INTERVAL \'1 second\' WHERE id=$1',
    [runNodeId]
  );
}

/** All run-node rows for a run. */
async function runNodes(pg, runId) {
  const r = await pg.query('SELECT * FROM studio_run_nodes WHERE run_id=$1 ORDER BY studio_node_id', [runId]);
  return r.rows;
}

/** Make ONLY keepRunId eligible for leasing (all other runs -> CANCELLED).
 *  Lease is a GLOBAL sweep across eligible runs by design (a worker drains
 *  every pending run); tests that need per-run determinism isolate this way. */
async function isolateRun(pg, keepRunId) {
  await pg.query(
    `UPDATE studio_runs SET status='CANCELLED', cancel_requested_at=NOW(), updated_at=NOW()
       WHERE id <> $1 AND status IN ('QUEUED','RUNNING','WAITING','BLOCKED')`,
    [keepRunId]
  );
}

module.exports = {
  bootstrapRunDb, dropDb, createDb, poolConfig,
  makeUser, seedProject, engineCreateRun, makeEngine, bumpCanvasRevision, sleep,
  runToCompletion, runCompiledGraph, forceLeaseExpired, runNodes, isolateRun,
  nodes, edge,
  ADMIN_HOST, ADMIN_PORT, ADMIN_USER,
};
