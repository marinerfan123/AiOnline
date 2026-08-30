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
const { testExecutor } = require('../../modules/project-foundation/studioRunTestExecutors.cjs');

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
const edgeDef = (id, source, target, sourceHandle = 'text', targetHandle = 'text') => ({ edgeId: id, sourceNodeId: source, sourceHandle, targetNodeId: target, targetHandle, edgeType: 'smoothstep', data: { portType: 'TEXT' } });

async function newWorkspaceProject(baseUrl, user) {
  const wsRes = await authRequest(baseUrl, { method: 'GET', path: '/api/v2/workspaces' }, user.cookies);
  assert.equal(wsRes.status, 200);
  const ws = wsRes.body.workspaces[0];
  const r = await authRequest(baseUrl, { method: 'POST', path: '/api/v2/projects', body: { workspaceId: ws.id, name: 'Run API', projectType: 'studio' } }, user.cookies);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { workspace: ws, project: r.body.project };
}

test('M05-D1 Studio Run API: create/list/detail/cancel over HTTP', { concurrency: 1 }, async (t) => {
  let server, pg, dbName, user, project, workspace, canvasId;

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

  // server.baseUrl is populated inside t.before, which the Node.js test runner
  // runs before the first subtest — NOT before the parent test body returns.
  // Read it lazily per subtest to avoid reading an undefined reference.
  const getBase = () => server.baseUrl;

  await t.test('setup: user + project + canvas with prompt->output graph (rev 2)', async () => {
    const base = getBase();
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
    const base = getBase();
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
    const base = getBase();
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
    const base = getBase();
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
    const base = getBase();
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'SELECTED', canvasRevision: 2, idempotencyKey: 'api-sel', selectedNodeIds: ['ghost'] },
    }, user.cookies);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'UNKNOWN_NODE_ID');
  });

  await t.test('SELECTED mode on output node -> 202 with the upstream closure', async () => {
    const base = getBase();
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'SELECTED', canvasRevision: 2, idempotencyKey: 'api-sel2', selectedNodeIds: ['ao1'] },
    }, user.cookies);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.run.nodeCount, 2, 'output + its upstream prompt');
  });

  await t.test('GET list runs -> includes both runs, paginated', async () => {
    const base = getBase();
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/runs` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.runs.length >= 2);
    assert.equal(r.body.pagination.total, r.body.runs.length);
    assert.ok(r.body.runs.some((x) => x.id === runId));
  });

  await t.test('GET run detail -> nodes + counts; foreign run is 404', async () => {
    const base = getBase();
    const r = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/runs/${runId}` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.run.id, runId);
    assert.equal(r.body.nodes.length, 2);
    const missing = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${project.id}/studio/runs/run-${crypto.randomUUID()}` }, user.cookies);
    assert.equal(missing.status, 404);
  });

  // Clean up any non-terminal runs from earlier subtests so the cancel test
  // doesn't accidentally lease from them.
  await t.test('cleanup: drive all early runs to terminal', async () => {
    const eng = makeEngine(pg, { workerId: 'cleanup', executors: { prompt: testExecutor(), 'image-generation': testExecutor({ delayMs: 50 }) } });
    for (let i = 0; i < 20; i++) {
      await eng.workerTick({ concurrency: 2, batch: 8, retryBackoffMs: [1] });
      await eng.reapExpiredNodes({ limit: 50 });
      const active = (await pg.query(`SELECT COUNT(*)::int c FROM studio_runs WHERE project_id=$1 AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`, [project.id])).rows[0].c;
      if (!active) break;
    }
  });

  await t.test('POST cancel -> 200; run cancels; no new lease possible', async () => {
    const base = getBase();
    // Create a FRESH project+canvas so this run has zero shared nodes with
    // earlier test runs.
    const freshWsRes = await authRequest(base, { method: 'GET', path: '/api/v2/workspaces' }, user.cookies);
    const freshWs = freshWsRes.body.workspaces[0];
    const freshProj = (await authRequest(base, {
      method: 'POST', path: '/api/v2/projects',
      body: { workspaceId: freshWs.id, name: 'Cancel Test', projectType: 'studio' },
    }, user.cookies)).body.project;
    const freshCanvas = (await authRequest(base, {
      method: 'POST', path: `/api/v2/projects/${freshProj.id}/studio/canvas`,
      body: { name: 'Primary' },
    }, user.cookies)).body.canvas;
    // Add prompt + image-gen + output. Image-gen has no production executor
    // (M05-E bridge boundary), so after the daemon ticks, prompt=SUCCEEDED,
    // image-gen=WAITING, output=BLOCKED. The run stays non-terminal.
    await authRequest(base, {
      method: 'PATCH',
      path: `/api/v2/projects/${freshProj.id}/studio/canvas`,
      body: {
        baseRevision: 1,
        clientMutationId: `mut-${crypto.randomBytes(4).toString('hex')}`,
        upsertNodes: [promptNode('fp1'), outputNode('fo1'), {
          nodeId: 'fi1', nodeType: 'image-generation', nodeSchemaVersion: 1,
          position: { x: 2, y: 2 }, size: { width: 260, height: 120 }, zIndex: 1,
          data: { nodeKind: 'image-generation', nodeType: 'image-generation', schemaVersion: 1, title: 'I', status: 'READY', parameters: { logicalModelId: 'lm-1', aspectRatio: '1:1', resolution: '1024x1024' } },
        }],
        upsertEdges: [edgeDef('fe1', 'fp1', 'fi1'), edgeDef('fe2', 'fi1', 'fo1', 'image', 'image')],
      },
    }, user.cookies);
    const cr = await authRequest(base, {
      method: 'POST', path: `/api/v2/projects/${freshProj.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 2, idempotencyKey: `api-cancel-${Date.now()}` },
    }, user.cookies);
    assert.equal(cr.status, 202, JSON.stringify(cr.body));
    const cancelRunId = cr.body.run.id;
    // Immediately cancel (no wait): the prompt may or may not have started,
    // but the run must be non-terminal (QUEUED/RUNNING/WAITING) so cancel succeeds.
    const r = await authRequest(base, { method: 'POST', path: `/api/v2/projects/${freshProj.id}/studio/runs/${cancelRunId}/cancel` }, user.cookies);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const runRow = (await pg.query('SELECT status, cancel_requested_at FROM studio_runs WHERE id=$1', [cancelRunId])).rows[0];
    assert.ok(runRow.cancel_requested_at, 'durable cancel_requested_at set');
    // After cancel: if the run was CANCELLED already, great. If it's still
    // RUNNING (prompt was actively executing), wait for aggregate to fire.
    if (runRow.status !== 'CANCELLED') {
      const worker = makeEngine(pg, { workerId: 'cancel-wait-probe', executors: { prompt: testExecutor(), 'image-generation': testExecutor({ delayMs: 50 }) } });
      for (let i = 0; i < 10; i++) {
        await worker.workerTick({ concurrency: 2, batch: 8, retryBackoffMs: [1] });
        await worker.reapExpiredNodes({ limit: 50 });
        const rr = (await pg.query('SELECT status FROM studio_runs WHERE id=$1', [cancelRunId])).rows[0];
        if (rr && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(rr.status)) break;
      }
    }
    const finalRow = (await pg.query('SELECT status FROM studio_runs WHERE id=$1', [cancelRunId])).rows[0];
    assert.equal(finalRow.status, 'CANCELLED', 'run aggregates to CANCELLED once all nodes terminal');
    // A new lease attempt must return nothing (cancel flag blocks leasing).
    const eng = makeEngine(pg, { workerId: 'api-test-w-cancel' });
    assert.equal(await eng.leaseReadyNode({}), null, 'no new lease after cancel request');
    const detail = await authRequest(base, { method: 'GET', path: `/api/v2/projects/${freshProj.id}/studio/runs/${cancelRunId}` }, user.cookies);
    assert.equal(detail.body.run.cancelRequestedAt != null, true);
  });

  await t.test('unauthenticated run create -> 401', async () => {
    const base = getBase();
    const r = await authRequest(base, {
      method: 'POST',
      path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 2, idempotencyKey: 'api-unauth' },
    }, {});
    assert.equal(r.status, 401);
  });

  await t.test('a second project owner cannot create runs on the first project -> 403', async () => {
    const base = getBase();
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
    // Create a FRESH canvas (revision 1) so run-node rows start as READY.
    // The first test already modified the original canvas, so any canvas-based
    // run created there may have parked/completed nodes that prevent the
    // dedicated-worker probe from leasing.
    const freshCanvasRes = (await authRequest(base, {
      method: 'POST', path: `/api/v2/projects/${project.id}/studio/canvas`,
      body: { name: 'Worker Probe Canvas' },
    }, user.cookies)).body.canvas;
    // Add prompt + image-gen + output; revisions: 1 (empty) -> 2 (nodes)
    await authRequest(base, {
      method: 'PATCH', path: `/api/v2/projects/${project.id}/studio/canvas`,
      body: {
        baseRevision: 1, clientMutationId: `wmut-${crypto.randomBytes(4).toString('hex')}`,
        upsertNodes: [promptNode('wp1'), outputNode('wo1'), {
          nodeId: 'wing', nodeType: 'image-generation', nodeSchemaVersion: 1,
          position: { x: 2, y: 2 }, size: { width: 260, height: 120 }, zIndex: 1,
          data: { nodeKind: 'image-generation', nodeType: 'image-generation', schemaVersion: 1, title: 'I', status: 'READY', parameters: { logicalModelId: 'lm-1', aspectRatio: '1:1', resolution: '1024x1024' } },
        }],
        upsertEdges: [edgeDef('we1', 'wp1', 'wing'), edgeDef('we2', 'wing', 'wo1', 'image', 'image')],
      },
    }, user.cookies);
    const created = await authRequest(base, {
      method: 'POST', path: `/api/v2/projects/${project.id}/studio/runs`,
      body: { runMode: 'ALL', canvasRevision: 2, idempotencyKey: `w-1-${Date.now()}` },
    }, user.cookies);
    // 202 = run accepted but not yet terminal; 201 = immediately COMPLETED (wrong).
    assert.ok([202, 201].includes(created.status), JSON.stringify(created.body));
    const runId = created.body.run.id;
    // Give any (incorrectly started) API-embedded worker a chance to act.
    await new Promise((r) => setTimeout(r, 1500));
    let row = (await pg.query('SELECT status, node_status_counts FROM studio_runs WHERE id=$1', [runId])).rows[0];
    assert.equal(row.status, 'QUEUED', 'production API must NOT run the studio worker by default');
    assert.equal((await pg.query(`SELECT COUNT(*)::int c FROM studio_run_nodes WHERE run_id=$1 AND status='RUNNING'`, [runId])).rows[0].c, 0);
    // Now a DEDICATED worker (same engine module) progresses it — proving the
    // separation, not the absence of functionality.
    // Inject a 200ms-delay test executor on image-gen so each tick is
    // non-trivial; call workerTick in a loop until the run reaches a terminal
    // state (processes prompt, then image-gen, then output).
    const worker = makeEngine(pg, { workerId: 'dedicated-worker-probe', executors: { 'image-generation': testExecutor({ delayMs: 200 }), prompt: testExecutor() } });
    for (let i = 0; i < 10; i++) {
      await worker.workerTick({ concurrency: 2, batch: 8, retryBackoffMs: [1] });
      await worker.reapExpiredNodes({ limit: 50 });
      row = (await pg.query('SELECT status FROM studio_runs WHERE id=$1', [runId])).rows[0];
      if (row && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) break;
    }
    row = (await pg.query('SELECT status FROM studio_runs WHERE id=$1', [runId])).rows[0];
    assert.equal(row.status, 'COMPLETED', 'dedicated worker must progress the run to completion');
  });
});
