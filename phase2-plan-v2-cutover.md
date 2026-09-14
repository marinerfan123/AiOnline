Phase 2 Plan A - Generation V2 Cutover
=======================================

1. CURRENT_STATE
================

V1 (Production Path):
- server/dispatcher.cjs:2095 lines. Single monolithic file.
- flow: /api/generate -> dispatcher.generateAsync() -> dispatchOne() -> attemptOnAccount() -> videoGenerate() -> [video pollLoop or sync wait] -> realtime.emitTaskUpdate + assetFinalize.finalizeUrl + billing.commitCredits.
- Billing: billing.cjs reserve/commit/release via credit_transactions table.
- Asset finalization: assetFinalize.cjs downloads provider URL, uploads to OSS, writes media table.
- Upload queue: uploadQueue.cjs background async upload loop.
- CPU throttle: cpuMonitor.cjs, 80% threshold returns 503.
- Rate limiting: rateLimitRedis.cjs shared across workers.
- Schema tables: generation_tasks, generation_attempts, credit_transactions, media.
- 0 active V2 items in production PG (confirmed).

V2 (Shadow/Separate Worker Path):
- Entry: server/modules/generation-v2/entry.cjs (standalone process, started separately).
- Schema: 6 tables in PG (generation_batches_v2, generation_items_v2, generation_item_attempts_v2, generation_credit_holds_v2, generation_outbox_v2, generation_worker_heartbeats_v2).
- Migrations: 0002, 0003, 0004 cover V2 schema.
- Intake: intake.cjs creates batch+items+holds+outbox in single transaction. Idempotent by (user_id, idempotency_key).
- Shadow: server.js line 3399 calls writeShadowBatch() after V1 dispatch succeeds — non-blocking mirror for audit.
- Production gate: production-gate.cjs checks 8 criteria (unit tests, migration, PG integration, shadow audit consistency, chaos tests, load P95<=300ms, secrets, dependencies, observability).
- Evidence file: /tmp/v2-evidence.json — currently all-passing (17/17 shadow consistent, unitPass/migration/pgIntegration/chaos/load/secrets/dependencies/observability all true).
- Worker ticks: generationTick, uploadTick, reconcileTick, outboxTick, reaperTick (every 1s).
- Provider routing: provider-status-router.cjs normalizes query results into pending/success/failed/not_found/unknown.
- Credit system: generation_credit_holds_v2 (separate from V1 billing.cjs); settleHold commits/releases holds.
- V2 is NOT wired into server.js generate endpoint yet. Pure shadow-audit path active.

Test Status:
- npm test: 185 tests, 24 files, all PASS.
- V2 test files: 40 test files under server/modules/generation-v2/*.test.cjs.
- No V2 tests failing.

2. GAPS
=======

Gap A — Entry Point Wiring (CRITICAL):
  server.js does not import or start the V2 worker daemon. The /api/generate route uses only V1 dispatcher.generateAsync(). The V2 entry point (entry.cjs) is a separate process never launched by the main server.

Gap B — Intake Integration (CRITICAL):
  No call to intake.createBatchWithItems() exists in server/server.js. The V2 flow has no path from HTTP request to batch creation.

Gap C — Dual-path Convergence:
  V1 and V2 use separate credit systems (credit_transactions vs generation_credit_holds_v2). When both run, we need to decide: shadow-only (no real billing in V2), or V2 double-billing? The current shadow implementation does NOT bill — it only mirrors structure for audit. For cutover, we need to decide if V2 replaces V1 billing or runs parallel.

Gap D — Realtime Notification Routing:
  V2 outbox tick publishes via production-adapters.publish() -> realtime.emitTaskUpdate(). V1 uses direct call. Need to verify V2 SSE events match V1 event shape exactly.

Gap E — Frontend Awareness:
  Need to confirm frontend can handle V2 task IDs (batch_id format vs v1 taskId). Currently frontend polls based on V1 task lifecycle. V2 cutover must preserve same API response shape so frontend is unaffected.

Gap F — Shadow Audit -> Cutover Decision:
  shadowAudit in production-gate only verifies structural consistency, not behavioral equivalence. Need "parallel-run" evidence where V1 and V2 results are compared side-by-side over N requests.

Gap G — Key Pool Routing:
  V2 uses provider-key-pool from ai-control module. V1 uses its own provider selection (dispatcher.cjs lines 718-837). Cutover requires V2 to use the same key-pool logic as production, not a separate one.

Gap H — Concurrency Limits:
  V2 has V2_GENERATION_CONCURRENCY (default 10) and V2_UPLOAD_CONCURRENCY (default 4). V1 uses global 50-slot pool (dispatcher.cjs:1927). These must be aligned or documented as different constraints.

3. PARALLEL_DAG
===============

Phase 2 is PRE-PLANNING. The actual cutover work, when ready, decomposes as follows:

Phase 2A — Intake Wiring (1 writer, ~1 day)
  Modify server.js /api/generate to:
    - After V1 generateAsync() completes, optionally call intake.createBatchWithItems()
    - Route: V1 dispatches first, then V2 mirrors (not parallel dispatch — sequential to avoid double-billing)
    - Branch: feat/moling-v2-m05d-durable-dag (current branch)

Phase 2B — Cutover Flag + Feature Toggle (1 writer, ~0.5 day)
  Add GENERATION_V2_CUTOVER_ENABLED env flag
  When true: V2 intake runs before or after V1 (configurable), V2 worker processes same batches
  When false: pure shadow mode (current behavior)
  File: server/server.js + server/modules/generation-v2/startup-config.cjs

Phase 2C — Dual-path Convergence (1 writer, ~1 day)
  - Align V1/V2 credit systems: either V2 inherits V1 billing or V2's hold system replaces it
  - Ensure OSS upload completes in both paths with identical media table entries
  - Verify SSE event shapes match

Phase 2D — Parallel Run Evidence (1 writer + automation, ~2-3 days)
  - Build a "dual-run" mode where both V1 and V2 process the same request
  - Compare outcomes: same provider_url? same cost? same media_id?
  - Log discrepancies for manual review
  - Accumulate N=100+ successful parallel runs before gate passage

Phase 2E — Gradual Traffic Shift (1 writer, ~1 day)
  - Start with 1% shadow traffic (already works)
  - Ramp to 10%, 50%, 100% real V2 processing
  - Monitor: error_rate, p95_latency, ledger_mismatch, queue_age

Phase 2F — V1 Decommission (1 writer, ~0.5 day)
  - After 24h stable V2, remove V1 code paths from /api/generate
  - Keep V1 dispatcher for resume/recovery (still used by legacy tasks)

DEPS: 2A -> 2B -> 2C -> 2D -> 2E -> 2F
Within 2D: dual-run instrumentation can be built in parallel with 2C (different files).

4. FILE/BRANCH_BOUNDARIES
=========================

Single-writer worktrees recommended:
- Worktree 1 (Intake Wiring): server/server.js (generate handler), server/modules/generation-v2/intake.cjs
- Worktree 2 (Feature Toggle): server/server.js (env config), server/modules/generation-v2/startup-config.cjs
- Worktree 3 (Convergence): server/modules/generation-v2/upload-finalize.cjs, server/modules/generation-v2/ledger.cjs, server/assetFinalize.cjs
- Worktree 4 (Dual-Run Evidence): server/modules/generation-v2/dual-run.cjs (new), server/modules/generation-v2/dual-run.test.cjs (new)
- Worktree 5 (Traffic Shift): server/server.js (route handler conditional), server/modules/generation-v2/canary.cjs

Branch strategy: feat/moling-v2-m05d-durable-dag already exists. Additional feature branches forked from this for each worktree.

Files NOT to touch during Phase 2:
- server/dispatcher.cjs (keep V1 intact for fallback)
- server/billing.cjs (V1 billing untouched until cutover complete)
- server/oss.cjs (shared, don't refactor)
- Any migration files (schema is stable)
- server/providers/ (provider adapters unchanged)

5. TEST/ACCEPTANCE
==================

Acceptance Criteria for each phase:
- Phase 2A: npm test passes; manual curl to /api/generate produces V2 batch in DB; V1 still works
- Phase 2B: GENERATION_V2_CUTOVER_ENABLED=true starts V2 worker; false does not
- Phase 2C: V1+V2 parallel run produces identical media records; ledger mismatch = 0
- Phase 2D: 100+ dual-run comparisons, 0 unreconciled discrepancies, p95_submit_ms <= 300
- Phase 2E: 1% traffic shows error_rate < 0.1%, same as V1 baseline
- Phase 2F: All existing tests pass; no V1-generated tasks fail mid-flight

Regression guards:
- Every cutover step must preserve: idempotency (same request = same result), credit accounting accuracy, SSE delivery reliability
- Shadow audit must remain green after each step (shadowAudit.consistent == shadowAudit.sampled)

6. DEPENDENCIES
==============

External:
- Phase 1 repair tasks must complete (referred from parent tasks on kanban)
- Production evidence file (/tmp/v2-evidence.json) must be refreshed after any schema change
- PG migration 0002-0004 must be applied to production before cutover (already done per evidence)

Internal:
- ai-control module (provider/key-pool management) must be stable — tested separately in c0/q2-provider-audit-v2
- modelhub bindings (loadDispatchPairs) must work with V2 routing
- Redis must support lease fencing at expected load (tested in chaos suite)

7. CRITICAL_PATH
================

Critical path (longest sequence, blocks all else):
2A (intake wiring) -> 2C (convergence) -> 2D (dual-run evidence, 2-3 days) -> 2E (traffic shift) -> 2F (V1 decommission)

Estimated: ~5-6 working days minimum.
Parallelizable: 2B (feature toggle) and 2D instrumentation can overlap with 2A/2C.
Non-critical: 2F can be delayed indefinitely; V1 fallback is always available.

8. ESTIMATED_SAFE_PARALLELISM
=============================

Safe: 2-3 concurrent writers on separate worktrees.
- Writer A: intake wiring (server.js generate handler)
- Writer B: feature toggle (startup-config.cjs)
- Writer C: dual-run instrumentation (new files, no overlap with A or B)

Convergence (2C) must be single-writer — touches shared assetFinalize + ledger files.
Traffic shift (2E) must be single-writer — touches server.js route handler.

Risk of merge conflicts: HIGH between server.js changes (2A, 2B, 2E all touch it).
Mitigation: 2A and 2B should be completed and merged BEFORE starting 2E.

9. P0/P1 RISKS
==============

P0 — Double Billing:
  If V2 intake runs AND V1 billing runs on the same request, user is charged twice.
  Mitigation: Use a transactional lock or atomic flag; V1 completes billing before V2 intake starts.

P0 — Stuck Leases on Cutover:
  Active V1 tasks mid-generation when V2 is enabled will not be picked up by V2 worker (different schema).
  Mitigation: Drain all V1 tasks before enabling V2 cutover, or implement a migration hook in entry.cjs.

P1 — Provider URL Divergence:
  V2 reconciliation queries provider status via provider-status-router.cjs. If this returns different results than V1's inline polling, assets may be marked failed in V2 but succeeded in V1.
  Mitigation: Run side-by-side for 48h minimum before enabling V2-only.

P1 — SSE Event Shape Mismatch:
  Frontend expects specific event payload from V1. V2 outbox events may differ.
  Mitigation: Add event-shape assertion in dual-run test (Phase 2D).

P1 — OSS Upload Race:
  V1 assetFinalize and V2 upload-worker both download from same provider URL. Under high concurrency, provider may rate-limit.
  Mitigation: V2 upload concurrency capped at 4 (vs V1's unbounded). Monitor provider 429 rates.

10. WHAT_NOT_TO_BUILD
=====================

Do NOT build:
- New provider adapters (reuse existing videoRouter from dispatcher.cjs via production-adapters.cjs)
- New billing system (reuse V1 billing.cjs for V1 path; V2 hold system only for V2 path)
- New OSS client (reuse server/oss.cjs)
- New database migrations (schema is stable at 0002-0004)
- New frontend components (API contract must remain identical)
- Parallel V1+V2 dispatch on same request (double-billing risk)
- Any change to server/dispatcher.cjs core logic (keep V1 as-is for fallback)
