# Studio Generation Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Studio image/video generation nodes execute through the existing legacy generation, billing, and durable media pipeline instead of remaining `BLOCKED` behind the unfinished executor boundary.

**Architecture:** Add a production-only Studio generation bridge that resolves the selected logical model, reserves credits with a deterministic `runId + nodeId` idempotency key, submits through `dispatcher.generateAsync`, heartbeats the Studio lease while polling, and converts the completed legacy task into durable media-id-only node output. Wire the bridge into both the API's run creation engine and the dedicated Studio worker; requeue old bridge-blocked runs only when the worker has the bridge. Keep test executors and non-generation deterministic nodes unchanged.

**Tech Stack:** CommonJS server modules, PostgreSQL/`pg`, existing `billing.cjs`, `accounting.cjs`, `dispatcher.cjs`, Node test runner, Docker Compose.

## Global Constraints

- Never double-reserve or double-commit credits; all billing keys are deterministic and database-idempotent.
- Never persist provider temporary URLs in Studio node results; output durable media IDs only.
- Do not weaken lease fencing or allow a stale worker to complete a node.
- Preserve existing test-only executor injection and deterministic source/asset/output behavior.
- Do not print credentials, tokens, `.env` values, or provider secrets in logs or test output.

---

### Task 1: Capture the production generation bridge contract

**Files:**
- Create: `server/modules/project-foundation/studioGenerationBridge.cjs`
- Test: `server/modules/project-foundation/studioGenerationBridge.test.cjs`

**Interfaces:**
- Consumes: `ctx = { runId, nodeId, nodeType, requestedBy, input, upstreamResults, heartbeat }` and injected `{ pg, dispatcher, billing, accounting, modelResolver, pollIntervalMs, maxWaitMs, sleep }`.
- Produces: `createStudioGenerationBridge(deps).createExecutor(ctx)` returning `{ kind: 'generation-bridge', execute }`; `buildGenerationRequest(ctx)` and `durableResultFromTask(task, meta)` pure helpers for focused tests.

- [x] **Step 1: Write failing tests for request normalization and durable output.**

```js
test('buildGenerationRequest maps image node parameters and upstream text', () => {
  const request = buildGenerationRequest({
    nodeType: 'image-generation',
    input: { parameters: { logicalModelId: 'm-img', aspectRatio: '16:9', resolution: '1280x720', negativePrompt: 'blur' } },
    upstreamResults: { prompt: { result: { text: 'a cat' } } },
  });
  assert.deepEqual(request, {
    model: 'm-img', prompt: 'a cat', ratio: '16:9', resolution: '1280x720',
    contentType: 'image', count: 1, negative: 'blur', referenceImages: [],
  });
});

test('durableResultFromTask keeps media IDs and omits URLs', () => {
  const result = durableResultFromTask({
    status: 'done',
    taskId: 'gt-1',
    result: { images: [{ mediaId: 'media-1', ossUrl: 'https://cdn.example/temporary' }] },
  }, { cost: 2, nodeType: 'image-generation' });
  assert.deepEqual(result, {
    nodeType: 'image-generation', executionKind: 'GENERATION', contentType: 'image',
    taskId: 'gt-1', cost: 2, mediaIds: ['media-1'], imageAssetIds: ['media-1'], assetIds: ['media-1'],
  });
  assert.equal(JSON.stringify(result).includes('cdn.example'), false);
});
```

- [x] **Step 2: Run the focused test and verify it fails because the bridge module is absent.**

Run: `node --test server/modules/project-foundation/studioGenerationBridge.test.cjs`

Expected: FAIL with `Cannot find module './studioGenerationBridge.cjs'`.

- [x] **Step 3: Implement pure request/result helpers and explicit error codes.**

Implement model/parameter extraction for `image-generation`, `image-to-video`, and `text-to-video`; use upstream `text`, `script`, `imageAssetId`, and `videoAssetId` values; reject missing model/prompt/input with `STUDIO_GENERATION_INPUT_INVALID`; and only copy `mediaId`/`videoMedia.mediaId` from a completed legacy task into the durable result.

- [x] **Step 4: Run the focused test and verify it passes.**

Run: `node --test server/modules/project-foundation/studioGenerationBridge.test.cjs`

Expected: PASS with all bridge contract tests passing.

### Task 2: Implement billing-idempotent legacy-task execution and lease heartbeats

**Files:**
- Modify: `server/modules/project-foundation/studioGenerationBridge.cjs`
- Modify: `server/modules/project-foundation/studioRunExecutors.cjs`
- Modify: `server/modules/project-foundation/studioRunEngine.cjs`
- Test: `server/modules/project-foundation/studioGenerationBridge.test.cjs`
- Test: `server/tests/integration/studio-run-engine.test.cjs`

**Interfaces:**
- Consumes: Task 1 bridge helpers and existing `dispatcher.generateAsync/getTaskStatus`, `billing.resolvePayment/reserveCredits/releaseCredits`, `accounting.getModelPrice`, and `modelResolver.resolveModelIdentity`.
- Produces: generation executor resolution for production nodes, `ctx.requestedBy`, `ctx.heartbeat`, and safe recovery of pre-bridge `BLOCKED` runs.

- [x] **Step 1: Add failing bridge lifecycle tests.**

Cover: existing running task reuse without another reserve; first submission reserves once with `studio:${runId}:${nodeId}`; dispatcher error releases the reservation; polling heartbeats before lease expiry; failed task throws its persisted error; and done task output contains durable media IDs only.

- [x] **Step 2: Run bridge lifecycle tests to verify the new behavior fails.**

Run: `node --test server/modules/project-foundation/studioGenerationBridge.test.cjs`

Expected: FAIL because production generation resolution still returns `EXECUTOR_NOT_AVAILABLE` and the bridge lifecycle is unimplemented.

- [x] **Step 3: Implement the bridge lifecycle.**

Resolve the canonical model and price, determine reward/recharge pool exactly as `/api/generate` does, reserve with the deterministic key, call `dispatcher.generateAsync`, then poll `getTaskStatus` until `done` or `failed`. Reuse an existing task for retries and release only when a submission cannot be kept. Heartbeat through `ctx.heartbeat()` at a bounded interval while waiting. Treat `waiting`/`running` as nonterminal and honor a configurable bounded maximum wait.

- [x] **Step 4: Wire generation executor resolution without affecting injected test executors.**

Make `createStudioExecutorRegistry({ generationBridge })` report `hasGenerationBridge`, route generation node types to `generationBridge.createExecutor(ctx)`, and retain the explicit `generation-bridge-pending` result when no bridge is supplied. Add `generationBridge` to engine dependencies and pass `requestedBy`/`projectId` plus a fenced heartbeat callback from `buildExecContext`.

- [x] **Step 5: Make bridge-backed runs queue and recover safely.**

When a bridge is configured, do not create generation-only runs as `BLOCKED`; leave them `QUEUED` with `executor_unavailable=false`. Add a worker-only recovery query for old `BLOCKED` runs whose nodes are still nonterminal and generation-backed, converting them to `QUEUED` before leasing. Do not requeue runs when no bridge is configured.

- [x] **Step 6: Run focused engine and bridge tests.**

Run: `node --test server/modules/project-foundation/studioGenerationBridge.test.cjs server/tests/integration/studio-run-engine.test.cjs`

Expected: PASS; legacy no-bridge safety tests still observe `BLOCKED`, while bridge-backed runs reach node execution.

### Task 3: Wire API/worker runtime and production Compose service

**Files:**
- Modify: `server/server.js`
- Modify: `server/studio-worker.cjs`
- Modify: `docker-compose.prod.yml`
- Test: `server/tests/integration/studio-worker.test.cjs`

**Interfaces:**
- Consumes: `createStudioGenerationBridge`, the existing PG pool adapters, and Task 2 engine registry wiring.
- Produces: API run creation with the bridge, a dedicated production worker that calls the bridge, and a restart-safe `studio-worker` Compose service.

- [x] **Step 1: Add runtime wiring tests/checks for the worker entrypoint and Compose service.**

Assert the Compose service command is `node server/studio-worker.cjs`, the worker receives the same PG/Redis/runtime environment as the app, and the process-level worker test can start, lease a deterministic run, and shut down gracefully.

- [x] **Step 2: Implement API and worker bridge construction.**

Inject the shared bridge dependencies without importing `server.js` from the worker, keep the API engine stateless/read-write only, and keep generation execution exclusively in `studio-worker.cjs`.

- [x] **Step 3: Add the production `studio-worker` service.**

Use the same image/build and required environment as `app`, depend on healthy Redis, run `node server/studio-worker.cjs`, and do not expose an HTTP port. Keep worker replicas independently scalable and restartable.

- [x] **Step 4: Run worker integration and Compose config checks.**

Run: `node --test server/tests/integration/studio-worker.test.cjs`

Expected: PASS, including started/shutdown behavior and bridge-backed scheduling checks.

### Task 4: Full verification, review, push, and deployment

**Files:**
- Modify: any files from Tasks 1-3 only.

**Interfaces:**
- Consumes: completed bridge implementation and deployment wiring.
- Produces: verified commit pushed to the requested GitHub repository and production services rebuilt with the Studio worker.

- [x] **Step 1: Run server syntax, focused tests, full frontend tests, typecheck, and production build.**

Run: `npm run check:syntax`, `node --test server/modules/project-foundation/studioGenerationBridge.test.cjs server/tests/integration/studio-run-engine.test.cjs server/tests/integration/studio-worker.test.cjs`, `npm test`, `npm run typecheck`, and `npm run build`.

Expected: each command exits 0 with no failed tests.

- [x] **Step 2: Inspect the final diff and request an independent code review.**

Review billing idempotency, URL redaction/durability, lease fencing, old-run recovery, and Compose environment parity before committing.

- [x] **Step 3: Commit and push the verified branch.**

Use a focused commit such as `fix(studio): execute generation nodes through legacy pipeline`, then push the current branch to its configured GitHub remote without printing the token.

- [x] **Step 4: Deploy on the provided production server.**

Update the checked-out source, rebuild/recreate `app`, `redis` dependencies as needed, and start/recreate `studio-worker`; verify all services are healthy and the old blocked Run transitions from `BLOCKED` to `RUNNING`/terminal.

- [x] **Step 5: Verify production without exposing secrets.**

Query only run/node status, failure codes, task status, and durable media IDs; do not output provider URLs, environment variables, passwords, tokens, or JWT secrets.
