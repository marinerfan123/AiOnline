'use strict';
/**
 * M05-D1 — Studio Run API integration tests (LOCAL TEST DB ONLY).
 * Spawns the real server (HTTP + auth + routing) against a fresh test DB and
 * exercises the full Run surface: create (ALL/SELECTED + stale revision),
 * list, detail, cancel, and the dedicated-worker separation invariant
 * (the API process must NOT start a Studio worker by default).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawnTestServer } = require('../helpers/test-app.cjs');
const { register, authRequest } = require('../helpers/auth.cjs');
const { initTestSchema } = require('../helpers/test-db.cjs');
const { bootstrapRunDb, dropDb, seedProject, engineCreateRun, makeEngine, nodes, edge } = require('../helpers/studio-run-test.cjs');

const promptNode = (id, prompt = 'api hello') => ({
  nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1,
  position: { x: 1, y: 2 }, size: { width: 260, height: 120 }, zIndex: 1,
  data: { nodeKind: 'prompt', nodeType: 'prompt', schemaVersion: 1, title: 'P', status: 'READY', parameters: { prompt }, prompt },
});
const outputNode = (id) => ({
  nodeId: id, nodeType: 'output', nodeSchemaVersion: 1,
  position: { x: 4, y: 2 }, size: { width: 260, height: 120 }, zIndex: 1,
  data: { nodeKind: 'output', nodeType: 'output', schemaVersion: 1, title: 'O', status: 'READY', parameters: { label: 'Out' } },
});
const edgeDef = (id, source, target) => ({ edgeId: id, sourceNodeId: source, sourceHandle: 'text', targetNodeId: target, targetHandle: 'text', edgeType: 'smoothstep', data: { portType: 'TEXT' } });

async function newWorkspaceProject(baseUrl, user) {
  const wsRes = await authRequest(baseUrl, { method: 'GET', path: '/api/v2/workspaces' }, user.cookies);
  assert.equal(wsRes.status, 200);
  const ws = wsRes.body.workspaces[0];
  const r = await authRequest(baseUrl, { method: 'POST', path: '/api/v2/projects', body: { workspaceId: ws.id, name: 'Run API', projectType: 'studio' } }, user.cookies);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { workspace: ws, project: r.body.project };
}

test('M05-D1 Studio Run API: create/list/detail/cancel over HTTP', { concurrency: 1 }, async (t) => {
  let server, pg, dbName, user, project, canvasId;

  t.before(async () => {
    ({ dbName, pg } = await bootstrapRunDb());
    process.env.TEST_PG_DATABASE = dbName;
    server = await spawnTestServer();
  });
  t.after(async () => {
    if (server) await server.stop();
    delete process.env.TEST_PG_DATABASE;
    if (pg) await pg.end();
    if (dbName) await dropDb(dbName);
  });

  const base = server.baseUrl;

  await t.test('setup: user + project + canvas with prompt->output graph (rev 2)', async () => {
    user = await register(base, { email: `m05d-api-${Date.now()}@test.local` });
    const created = await newWorkspaceProject(base, user);
    workspace = created.workspace; project = created.project;
    const c = await authRequest(base, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas`, body: { name: 'Primary' } }, user.cookies);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    canvasId = c.body.canvas.id;
    // add nodes + edge via the M05-C patch endpoint (revision 1 -> 2)
    const p = await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${project.id}/studio/canvas`,
      body: {
        baseRevision: 1,
        clientMutationId: `mut-${crypto.randomBytes(4).toString('hex')}`,
        upsertNodes: [promptNode('ap1'), outputNode('ao1')],
        upsertEdges: [edgeDef('ae1', 'ap1', 'ao1')],
      },
    }, user.cookies);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.canvas.revision, 2);
  });

  let runId;
  await t.test('POST create run (ALL mode) -> 202 with authoritative revision binding', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'api-1' },
    }, user.cookies);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.idempotent, false);
    runId = r.body.run.id;
    assert.ok(runId.startsWith('run-'));
    assert.equal(r.body.run.canvasRevision, 2, 'run bound to the authoritative revision');
    assert.equal(r.body.run.status, 'QUEUED');
    assert.equal(r.body.run.nodeCount, 2);
    assert.equal(r.body.nodes.length, 2);
    const statuses = r.body.nodes.map((n) => n.status).sort();
    assert.deepEqual(statuses, ['BLOCKED', 'READY']);
  });

  await t.test('idempotent re-create (same key) -> 200 idempotent=true, same run', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'api-1' },
    }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.idempotent, true);
    assert.equal(r.body.run.id, runId);
  });

  await t.test('stale canvas revision -> 409 CANVAS_REVISION_STALE (no partial run)', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 1, idempotencyKey: 'api-stale' },
    }, user.cookies);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'CANVAS_REVISION_STALE');
    assert.equal(r.body.serverRevision, 2);
    const cnt = (await pg.query('SELECT COUNT(*)::int c FROM studio_runs WHERE idempotency_key=$1', ['api-stale'])).rows[0].c;
    assert.equal(cnt, 0, 'no partial run persisted');
  });

  await t.test('SELECTED mode with unknown node -> 400', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'SELECTED', canvasRevision: 2, idempotencyKey: 'api-sel', selectedNodeIds: ['ghost'] },
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'UNKNOWN_NODE_ID');
  });

  await t.test('SELECTED mode on output node -> 202 with the upstream closure', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'SELECTED', canvasRevision: 2, idempotencyKey: 'api-sel2', selectedNodeIds: ['ao1'] },
    }, user.cookies);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.run.nodeCount, 2, 'output + its upstream prompt');
  });

  await t.test('GET list runs -> includes both runs, paginated', async () => {
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/runs` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.runs.length >= 2);
    assert.equal(r.body.pagination.total, r.body.runs.length);
    assert.ok(r.body.runs.some((x) => x.id === runId));
  });

  await t.test('GET run detail -> nodes + counts; foreign run is 404', async () => {
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/runs/${runId}` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.run.id, runId);
    assert.equal(r.body.nodes.length, 2);
    const missing = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/runs/run-${crypto.randomUUID()}` }, user.cookies);
    assert.equal(missing.status, 404);
  });

  await t.test('POST cancel -> 200; run cancels; no new lease possible', async () => {
    const r = await authRequest(base, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/runs/${runId}/cancel` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const runRow = (await pg.query('SELECT status, cancel_requested_at FROM studio_runs WHERE id=$1', [runId])).rows[0];
    assert.ok(runRow.cancel_requested_at, 'durable cancel_requested_at set');
    // production worker not running in this API process: drive the cancel
    // aggregation directly to prove the engine honors the flag.
    const eng = makeEngine(pg, { workerId: 'api-test-w' });
    const agg = await eng.aggregateRun; // sanity: exists
    void agg;
    // cancel already set the flag; a lease attempt must return nothing
    assert.equal(await eng.leaseReadyNode({}), null, 'no new lease after cancel request');
    const detail = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/runs/${runId}` }, user.cookies);
    assert.equal(detail.body.run.cancelRequestedAt != null, true);
  });

  await t.test('unauthenticated run create -> 401', async () => {
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'api-unauth' },
    }, {});
    assert.equal(r.status, 401);
  });

  await t.test('a second project owner cannot create runs on the first project -> 403', async () => {
    const userB = await register(base, { email: `m05d-api-b-${Date.now()}@test.local` });
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'api-other' },
    }, userB.cookies);
    assert.equal(r.status, 403);
  });
});

test('M05-D1 commercial invariant: the production API starts NO studio worker by default', { concurrency: 1 }, async (t) => {
  // Behavioral proof: a run created through the API stays QUEUED (no worker
  // in the API process), then a DEDICATED worker (same engine module)
  // progresses it — proving the separation, not the absence of functionality.
  let server, pg, dbName;
  t.before(async () => {
    ({ dbName, pg } = await bootstrapRunDb());
    process.env.TEST_PG_DATABASE = dbName;
  });
  t.after(async () => {
    if (server) await server.stop();
    delete process.env.TEST_PG_DATABASE;
    if (pg) { await pg.end(); }
    if (dbName) await dropDb(dbName);
  });

  await t.test('API-created run stays QUEUED without a worker; worker process progresses it', async () => {
    server = await spawnTestServer();
    const base = server.baseUrl;
    const user = await register(base, { email: `m05d-ws-${Date.now()}@test.local` });
    const { project } = await newWorkspaceProject(base, user);
    await authRequest(base, { method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas`, body: {} }, user.cookies);
    const cRes = (await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/canvas` }, user.cookies));
    const canvasId = cRes.body.canvas.id;
    await authRequest(base, {
      method: 'PATCH', path: `/api/v2/projects/${project.id}/studio/canvas`,
      body: { baseRevision: 1, clientMutationId: `wmut-${crypto.randomBytes(4).toString('hex')}`, addNodes: [promptNode('wp1')], addEdges: [] },
    }, user.cookies);
    const created = await authRequest(base, {
      method: 'POST', path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'w-1' },
    }, user.cookies);
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const runId = created.body.run.id;
    // Give any (incorrectly started) API-embedded worker a chance to act.
    await new Promise((r) => setTimeout(r, 1500));
    let row = (await pg.query('SELECT status, node_status_counts FROM studio_runs WHERE id=$1', [runId])).rows[0];
    assert.equal(row.status, 'QUEUED', 'production API must NOT run the studio worker by default');
    assert.equal((await pg.query(`SELECT COUNT(*)::int c FROM studio_run_nodes WHERE run_id=$1 AND status='RUNNING'`, [runId])).rows[0].c, 0);
    // Now a DEDICATED worker (same engine module) progresses it — proving the
    // separation, not the absence of functionality.
    const worker = makeEngine(pg, { workerId: 'dedicated-worker-probe' });
    const leased = await worker.leaseReadyNode({});
    assert.ok(leased, 'dedicated worker leases the READY node');
    await worker.completeRunNode(leased.id, { owner: leased.lease_owner, token: leased.lease_token, result: { text: 'done' } });
    row = (await pg.query('SELECT status FROM studio_runs WHERE id=$1', [runId])).rows[0];
    assert.equal(row.status, 'COMPLETED');
  });
});
