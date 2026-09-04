'use strict';
/**
 * M05-C Studio Canvas Persistence integration tests.
 * LOCAL TEST DB ONLY. PostgreSQL is durable authority; Redis/process memory/local files are not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { spawnTestServer } = require('../helpers/test-app.cjs');
const { register, authRequest } = require('../helpers/auth.cjs');

const ADMIN_HOST = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const ADMIN_PORT = Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432');
const ADMIN_USER = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const ADMIN_PW = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || process.env.PGPASSWORD;

function poolConfig(database, max = 1) {
  return { host: ADMIN_HOST, port: ADMIN_PORT, user: ADMIN_USER, ...(ADMIN_PW ? { password: ADMIN_PW } : {}), database, max };
}
function adminPool() { return new Pool(poolConfig('postgres', 1)); }
async function createDb() { const admin = adminPool(); const name = `moling_m05c_test_${crypto.randomBytes(4).toString('hex')}`; await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.query(`CREATE DATABASE ${name}`); await admin.end(); return name; }
async function dropDb(name) { try { const admin = adminPool(); await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name]); await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end(); } catch (_) {} }

async function bootstrapDb() {
  const dbName = await createDb();
  const pg = new Pool(poolConfig(dbName, 8));
  // 全量迁移链 0001..head（G15 同配方）——陈旧快照缺列（如 0035 folder_id）已两度致 500。
  const migDir = path.resolve(__dirname, '..', '..', 'db', 'migrations');
  const files = fs.readdirSync(migDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    await pg.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }
  return { dbName, pg };
}

async function newProject(baseUrl, user, name = 'M05C Project') {
  const wsRes = await authRequest(baseUrl, { method: 'GET', path: '/api/v2/workspaces' }, user.cookies);
  assert.equal(wsRes.status, 200);
  const ws = wsRes.body.workspaces[0];
  const r = await authRequest(baseUrl, { method: 'POST', path: '/api/v2/projects', body: { workspaceId: ws.id, name, projectType: 'studio' } }, user.cookies);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { workspace: ws, project: r.body.project };
}

const promptNode = (id, x = 1, y = 2, prompt = 'hello') => ({
  nodeId: id,
  nodeType: 'prompt',
  nodeSchemaVersion: 1,
  position: { x, y },
  size: { width: 260, height: 120 },
  zIndex: 1,
  data: { nodeKind: 'prompt', nodeType: 'prompt', schemaVersion: 1, title: 'Prompt', status: 'READY', parameters: { prompt }, prompt },
});
const edge = (id, source, target) => ({ edgeId: id, sourceNodeId: source, sourceHandle: 'text', targetNodeId: target, targetHandle: 'text', edgeType: 'smoothstep', data: { portType: 'TEXT' } });

async function createCanvas(baseUrl, cookies, projectId) {
  return authRequest(baseUrl, { method: 'POST', path: `/api/v2/projects/${projectId}/studio/canvas`, body: { name: 'Primary Canvas' } }, cookies);
}

async function patchCanvas(baseUrl, cookies, projectId, body) {
  return authRequest(baseUrl, { method: 'PATCH', path: `/api/v2/projects/${projectId}/studio/canvas`, body }, cookies);
}

test('M05-C migration creates normalized Studio canvas persistence schema', { concurrency: 1 }, async () => {
  const { dbName, pg } = await bootstrapDb();
  try {
    for (const table of ['studio_canvases', 'studio_canvas_nodes', 'studio_canvas_edges', 'studio_canvas_versions', 'studio_canvas_mutations']) {
      const r = await pg.query(`SELECT 1 FROM information_schema.tables WHERE table_name=$1`, [table]);
      assert.equal(r.rows.length, 1, `${table} exists`);
    }
    const idx = await pg.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('studio_canvases','studio_canvas_nodes','studio_canvas_edges','studio_canvas_versions')`);
    const names = idx.rows.map((r) => r.indexname);
    assert.ok(names.includes('uq_studio_canvases_primary_project'));
    assert.ok(names.includes('uq_studio_canvas_nodes_canvas_node'));
    assert.ok(names.includes('uq_studio_canvas_edges_canvas_edge'));
  } finally { await pg.end(); await dropDb(dbName); }
});

test('M05-C Studio Canvas API persistence, concurrency, idempotency, versions, isolation', { concurrency: 1 }, async (t) => {
  let serverA, serverB, pg, dbName;
  t.before(async () => {
    ({ dbName, pg } = await bootstrapDb());
    process.env.TEST_PG_DATABASE = dbName;
    serverA = await spawnTestServer();
    serverB = await spawnTestServer();
  });
  t.after(async () => {
    if (serverA) await serverA.stop();
    if (serverB) await serverB.stop();
    delete process.env.TEST_PG_DATABASE;
    if (pg) await pg.end();
    if (dbName) await dropDb(dbName);
  });

  let userA, userB, project, workspace, canvasId;
  await t.test('create/load canvas and multi-API shared state', async () => {
    userA = await register(serverA.baseUrl, { email: `m05c-a-${Date.now()}@test.local` });
    ({ project, workspace } = await newProject(serverA.baseUrl, userA, 'M05C Shared'));
    const unauth = await authRequest(serverA.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, {});
    assert.equal(unauth.status, 401);
    const c = await createCanvas(serverA.baseUrl, userA.cookies, project.id);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    canvasId = c.body.canvas.id;
    assert.equal(c.body.canvas.revision, 1);
    assert.equal(c.body.nodes.length, 0);
    const loadB = await authRequest(serverB.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, userA.cookies);
    assert.equal(loadB.status, 200, JSON.stringify(loadB.body));
    assert.equal(loadB.body.canvas.id, canvasId);
    assert.equal(loadB.body.canvas.workspaceId, workspace.id);
  });

  await t.test('incremental patch persists nodes/edges/viewport and strips unsafe fields', async () => {
    const r = await patchCanvas(serverA.baseUrl, userA.cookies, project.id, {
      baseRevision: 1,
      clientMutationId: crypto.randomUUID(),
      upsertNodes: [{ ...promptNode('n1'), selected: true, dragging: true, measured: { width: 9 }, data: { ...promptNode('n1').data, temporaryPreviewUrl: 'https://signed.example/secret?token=x', apiKey: 'SECRET' } }],
      viewport: { x: 10, y: 20, zoom: 0.75 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.canvas.revision, 2);
    const load = await authRequest(serverB.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, userA.cookies);
    assert.equal(load.body.nodes.length, 1);
    assert.equal(load.body.nodes[0].nodeId, 'n1');
    assert.equal(load.body.nodes[0].selected, undefined);
    assert.equal(load.body.nodes[0].data.temporaryPreviewUrl, undefined);
    assert.equal(load.body.nodes[0].data.apiKey, undefined);
    assert.equal(load.body.viewport.x, 10);
  });

  await t.test('idempotent retry does not increment revision twice', async () => {
    const mid = crypto.randomUUID();
    const body = { baseRevision: 2, clientMutationId: mid, upsertNodes: [promptNode('n1', 9, 9, 'retry-safe')] };
    const first = await patchCanvas(serverA.baseUrl, userA.cookies, project.id, body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.canvas.revision, 3);
    const second = await patchCanvas(serverB.baseUrl, userA.cookies, project.id, body);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.canvas.revision, 3);
    assert.equal(second.body.idempotent, true);
  });

  await t.test('same-base concurrent patches: one succeeds and one gets 409', async () => {
    const a = patchCanvas(serverA.baseUrl, userA.cookies, project.id, { baseRevision: 3, clientMutationId: crypto.randomUUID(), upsertNodes: [promptNode('n2', 20, 20, 'A')] });
    const b = patchCanvas(serverB.baseUrl, userA.cookies, project.id, { baseRevision: 3, clientMutationId: crypto.randomUUID(), upsertNodes: [promptNode('n3', 30, 30, 'B')] });
    const out = await Promise.all([a, b]);
    assert.equal(out.filter((x) => x.status === 200).length, 1, JSON.stringify(out.map((x) => x.body)));
    const conflict = out.find((x) => x.status === 409);
    assert.ok(conflict, 'one 409 conflict');
    assert.equal(conflict.body.error, 'CONFLICT');
    assert.equal(conflict.body.serverRevision, 4);
  });

  await t.test('delete node removes dangling edges transactionally', async () => {
    const load = await authRequest(serverA.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, userA.cookies);
    const base = load.body.canvas.revision;
    const add = await patchCanvas(serverA.baseUrl, userA.cookies, project.id, { baseRevision: base, clientMutationId: crypto.randomUUID(), upsertNodes: [promptNode('n4'), promptNode('n5')], upsertEdges: [edge('e45', 'n4', 'n5')] });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const del = await patchCanvas(serverA.baseUrl, userA.cookies, project.id, { baseRevision: add.body.canvas.revision, clientMutationId: crypto.randomUUID(), deleteNodeIds: ['n4'] });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const after = await authRequest(serverA.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, userA.cookies);
    assert.equal(after.body.edges.some((e) => e.edgeId === 'e45'), false);
  });

  await t.test('versions are immutable and restore advances revision monotonically', async () => {
    const v = await authRequest(serverA.baseUrl, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas/versions`, body: { name: 'checkpoint', description: 'before change' } }, userA.cookies);
    assert.equal(v.status, 201, JSON.stringify(v.body));
    const versionId = v.body.version.id;
    const baseRev = v.body.version.revision;
    const mutate = await patchCanvas(serverA.baseUrl, userA.cookies, project.id, { baseRevision: baseRev, clientMutationId: crypto.randomUUID(), upsertNodes: [promptNode('after-version')] });
    assert.equal(mutate.status, 200, JSON.stringify(mutate.body));
    const list = await authRequest(serverB.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas/versions?limit=10` }, userA.cookies);
    assert.equal(list.status, 200);
    assert.ok(list.body.versions.some((x) => x.id === versionId && x.nodeCount >= 1));
    const restore = await authRequest(serverA.baseUrl, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas/versions/${versionId}/restore`, body: { baseRevision: mutate.body.canvas.revision } }, userA.cookies);
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal(restore.body.canvas.revision, mutate.body.canvas.revision + 1);
    assert.equal(restore.body.nodes.some((n) => n.nodeId === 'after-version'), false);
  });

  await t.test('cross-user and archived mutation policy', async () => {
    userB = await register(serverA.baseUrl, { email: `m05c-b-${Date.now()}@test.local` });
    const readB = await authRequest(serverA.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, userB.cookies);
    assert.equal(readB.status, 403);
    const patchB = await patchCanvas(serverA.baseUrl, userB.cookies, project.id, { baseRevision: 1, clientMutationId: crypto.randomUUID(), upsertNodes: [promptNode('hack')] });
    assert.equal(patchB.status, 403);
    const arch = await authRequest(serverA.baseUrl, { method: 'POST', path: `/api/v2/projects/${project.id}/archive` }, userA.cookies);
    assert.equal(arch.status, 200);
    const loadArchived = await authRequest(serverA.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, userA.cookies);
    assert.equal(loadArchived.status, 200);
    const denied = await patchCanvas(serverA.baseUrl, userA.cookies, project.id, { baseRevision: loadArchived.body.canvas.revision, clientMutationId: crypto.randomUUID(), upsertNodes: [promptNode('archived')] });
    assert.equal(denied.status, 403);
  });
});

test('M05-C instance restart safety', { concurrency: 1 }, async () => {
  const { dbName, pg } = await bootstrapDb();
  let serverA, serverB;
  try {
    process.env.TEST_PG_DATABASE = dbName;
    serverA = await spawnTestServer();
    const user = await register(serverA.baseUrl, { email: `m05c-restart-${Date.now()}@test.local` });
    const { project } = await newProject(serverA.baseUrl, user, 'Restart Safe');
    const c = await createCanvas(serverA.baseUrl, user.cookies, project.id);
    assert.equal(c.status, 201);
    const p = await patchCanvas(serverA.baseUrl, user.cookies, project.id, { baseRevision: 1, clientMutationId: crypto.randomUUID(), upsertNodes: [promptNode('survives')] });
    assert.equal(p.status, 200);
    await serverA.stop(); serverA = null;
    serverB = await spawnTestServer();
    const load = await authRequest(serverB.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, user.cookies);
    assert.equal(load.status, 200, JSON.stringify(load.body));
    assert.equal(load.body.canvas.revision, 2);
    assert.equal(load.body.nodes[0].nodeId, 'survives');
  } finally {
    if (serverA) await serverA.stop();
    if (serverB) await serverB.stop();
    delete process.env.TEST_PG_DATABASE;
    await pg.end();
    await dropDb(dbName);
  }
});


test('M05-C 1000-node persistence benchmark and 100-node batch patch', { concurrency: 1 }, async () => {
  const { dbName, pg } = await bootstrapDb();
  let server;
  try {
    process.env.TEST_PG_DATABASE = dbName;
    server = await spawnTestServer();
    const user = await register(server.baseUrl, { email: `m05c-bench-${Date.now()}@test.local` });
    const { project } = await newProject(server.baseUrl, user, '1000 Node Bench');
    const c = await createCanvas(server.baseUrl, user.cookies, project.id);
    assert.equal(c.status, 201);
    let rev = 1;
    const started = Date.now();
    for (let batch = 0; batch < 5; batch++) {
      const nodes = Array.from({ length: 200 }, (_, i) => {
        const n = batch * 200 + i;
        return promptNode(`bench-${n}`, (n % 50) * 260, Math.floor(n / 50) * 140, `prompt ${n}`);
      });
      const r = await patchCanvas(server.baseUrl, user.cookies, project.id, { baseRevision: rev, clientMutationId: crypto.randomUUID(), upsertNodes: nodes });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      rev = r.body.canvas.revision;
    }
    const hundred = Array.from({ length: 100 }, (_, i) => promptNode(`bench-${i}`, i, i, `updated ${i}`));
    const batch100 = await patchCanvas(server.baseUrl, user.cookies, project.id, { baseRevision: rev, clientMutationId: crypto.randomUUID(), upsertNodes: hundred });
    assert.equal(batch100.status, 200, JSON.stringify(batch100.body));
    rev = batch100.body.canvas.revision;
    const loadStart = Date.now();
    const load = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, user.cookies);
    const loadMs = Date.now() - loadStart;
    assert.equal(load.status, 200);
    assert.equal(load.body.nodes.length, 1000);
    assert.ok(loadMs < 5000, `1000-node load too slow: ${loadMs}ms`);
    const vStart = Date.now();
    const v = await authRequest(server.baseUrl, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas/versions`, body: { name: '1000 node checkpoint' } }, user.cookies);
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.ok(Date.now() - vStart < 8000, '1000-node snapshot should be bounded');
    const restore = await authRequest(server.baseUrl, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas/versions/${v.body.version.id}/restore`, body: { baseRevision: rev } }, user.cookies);
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal(restore.body.nodes.length, 1000);
    console.log(`[m05c-benchmark] totalMs=${Date.now() - started} loadMs=${loadMs} nodes=1000 batchPatch=100`);
  } finally {
    if (server) await server.stop();
    delete process.env.TEST_PG_DATABASE;
    await pg.end();
    await dropDb(dbName);
  }
});


test('M05-C commercial hardening: concurrent version numbering + set-based bulk restore', { concurrency: 1 }, async () => {
  const { dbName, pg } = await bootstrapDb();
  let server;
  try {
    process.env.TEST_PG_DATABASE = dbName;
    server = await spawnTestServer();
    const user = await register(server.baseUrl, { email: `m05c-hard-${Date.now()}@test.local` });
    const { project } = await newProject(server.baseUrl, user, 'Hardening');
    const c = await createCanvas(server.baseUrl, user.cookies, project.id);
    assert.equal(c.status, 201);
    const p = await patchCanvas(server.baseUrl, user.cookies, project.id, {
      baseRevision: 1, clientMutationId: crypto.randomUUID(),
      upsertNodes: Array.from({ length: 100 }, (_, i) => promptNode(`h-${i}`, i, i, `node ${i}`)),
    });
    assert.equal(p.status, 200, JSON.stringify(p.body));

    // (B) 12 concurrent Create Version: all succeed with distinct sequential numbers (row-locked, no silent overwrite).
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => authRequest(server.baseUrl, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas/versions`, body: { name: `conc-${i}` } }, user.cookies)));
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => ({ status: r.status, body: r.body }))));
    const nums = results.map((r) => r.body.version.versionNumber).sort((a, b) => a - b);
    assert.deepEqual(nums, Array.from({ length: 12 }, (_, i) => i + 1));
    const list = await authRequest(server.baseUrl, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas/versions?limit=100` }, user.cookies);
    assert.equal(list.body.versions.length, 12);

    // (A) restore is set-based: direct module proof that 100 nodes hydrate in ONE query, not 100.
    const { bulkInsertNodes } = require('../../modules/project-foundation/studioCanvasPersistence.cjs');
    const snapshot = { nodes: Array.from({ length: 100 }, (_, i) => promptNode(`s-${i}`, i, i, `snap ${i}`)), edges: [] };
    let queryCount = 0;
    const spyClient = { query: async (sql, params) => { queryCount += 1; assert.match(sql, /jsonb_to_recordset/); return { rowCount: 100 }; } };
    await bulkInsertNodes(spyClient, 'canvas-x', snapshot.nodes);
    assert.equal(queryCount, 1, 'bulk restore must issue a single set-based query for 100 nodes');

    // End-to-end: version -> mutate -> restore -> 100 nodes back with correct content.
    const v = await authRequest(server.baseUrl, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas/versions`, body: { name: 'hard checkpoint' } }, user.cookies);
    assert.equal(v.status, 201);
    const mutate = await patchCanvas(server.baseUrl, user.cookies, project.id, { baseRevision: 2, clientMutationId: crypto.randomUUID(), deleteNodeIds: ['h-0', 'h-1'] });
    assert.equal(mutate.status, 200);
    const restore = await authRequest(server.baseUrl, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas/versions/${v.body.version.id}/restore`, body: { baseRevision: mutate.body.canvas.revision } }, user.cookies);
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal(restore.body.nodes.length, 100);
    assert.equal(restore.body.nodes.some((n) => n.nodeId === 'h-0'), true);
    assert.equal(restore.body.nodes[99].data.prompt, 'node 99');
  } finally {
    if (server) await server.stop();
    delete process.env.TEST_PG_DATABASE;
    await pg.end();
    await dropDb(dbName);
  }
});
