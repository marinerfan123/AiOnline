# Phase 2 Plan J — Architecture Gap Sweep

**Task**: t_573ace39  
**Status**: PRE-PLANNING (READ_ONLY)  
**Date**: 2026-08-30  
**Repository**: C:\Users\Administrator\github_ai_online  
**Branch**: feat/moling-v2-m05d-durable-dag (HEAD=b9c52d4)  
**Production baseline**: release/moling-commercial-v1 @ 1515c05  

---

## 1. CURRENT_STATE

### 1.1 Verified Working State

| Check | Result | Evidence |
|-------|--------|----------|
| npm run typecheck | PASS | 0 errors |
| npm run test | PASS | 185 tests / 24 files |
| npm run build | PASS | 20.43s, dist/build2 |
| Production tag | 1515c05 (Aug 27) | LIVE at tv.moling.fun |
| Phase-1 worktrees | Running | phase1-repair-ha-lb, phase1-repair-ha-sse |
| DB migrations | 0001–0017 all present | server/db/migrations/ |

### 1.2 What IS Built (Repository Evidence)

**Backend modules (server/modules/project-foundation/)**:
- `studioCanvasPersistence.cjs` → `/api/v2/projects/:id/studio/canvas` (G1 ✅ registered in server.js L2437-2439)
- `studioEpisodeApi.cjs` → `/api/v2/projects/:id/episodes` (M05-E ✅ registered L2444)
- `studioShotApi.cjs` → `/api/v2/projects/:id/episodes/:epId/shots` (M05-E ✅ registered L2445)
- `studioRunApi.cjs` → `/api/v2/projects/:id/studio/runs` (**NOT registered in server.js**)
- `studioRunEngine.cjs` → durable DAG engine (PostgreSQL scheduling authority)
- `studioRunExecutors.cjs` → deterministic SOURCE/ASSET/OUTPUT executors; GENERATION nodes park with `EXECUTOR_NOT_AVAILABLE`
- `studioRunGraph.cjs` → DAG compiler
- `studioNodeRegistry.cjs` → 10 production node identities
- `projectFoundation.cjs` → `/api/v2/workspaces`, `/api/v2/projects` CRUD
- `assetFoundation.cjs` → V2 asset API
- `studioRunTestExecutors.cjs` → test-only (never production)

**Frontend features (src/features/studio-v2/)**:
- `StudioPage.tsx` — full IDE layout (Toolbar/Library/Canvas/Inspector/Dock)
- `StudioCanvas.tsx` — @xyflow/react canvas core
- `StudioNode.tsx` — 10 node type rendering
- `store.ts` — Zustand state (nodes, edges, execution, history)
- `persistence.ts` — serialization boundary (strips UI/security fields)
- `useStudioCanvasPersistence.ts` — autosave with conflict resolution (409)
- `registry.ts` — 10 node definitions (executionKind, ports, parameterSchema)
- `NodeLibrary.tsx`, `Inspector.tsx`, `TopToolbar.tsx`, `BottomDock.tsx`

**Worker process**:
- `server/studio-worker.cjs` — independent daemon, PG-only authority, configurable concurrency/batch/reaper

**Tests**:
- `server/tests/integration/studio-run-api.test.cjs`
- `server/tests/integration/studio-run-engine.test.cjs`
- `server/tests/integration/studio-run-compiler.test.cjs`
- `server/tests/integration/studio-canvas-persistence.test.cjs`
- `server/tests/integration/studio-episode-api.test.cjs`
- `server/tests/integration/studio-shot-api.test.cjs`
- `src/__tests__/v2/studioCanvasPersistence.test.ts` (7 tests)
- `src/__tests__/v2/studioProductionNodes*.test.ts` (36 tests)
- `src/__tests__/v2/studioCanvas.test.ts` (17 tests)
- `src/__tests__/v2/studioNodeSchema.test.tsx` (9 tests)

### 1.3 DB Schema (migrations 0010–0017)

| Migration | Tables Created |
|-----------|---------------|
| 0010 | models.ai_capabilities, ai_parameter_schemas, capability_version; api_keys runtime columns; ai_routing_decisions; ai_provider_health |
| 0011 | legacy key pool backfill |
| 0012 | workspaces, projects, workspace_members |
| 0013 | assets (V2 media replacement), asset_collections |
| 0014 | studio_canvases, studio_canvas_nodes, studio_canvas_edges, studio_canvas_versions, studio_canvas_mutations |
| 0015 | studio_runs, studio_run_nodes, studio_run_edges, studio_run_events |
| 0016 | episodes (draft/published/archived, seq-per-project) |
| 0017 | shots (episode-level shot timeline, maps canvas_node→seq) |

---

## 2. GAPS

### 2.1 Critical Gaps (P0) — Block Core Product

| # | Gap | Impact | Status |
|---|-----|--------|--------|
| **G01** | `studioRunApi` NOT mounted in server.js | Run engine API (`/api/v2/projects/:id/studio/runs`) unreachable from any client. All run creation/listing/cancellation is dead. | Code written, wiring missing |
| **G02** | StudioPage (`src/features/studio-v2/StudioPage.tsx`) NOT in App.tsx routes | The product's core experience (/studio/:projectId canvas) is inaccessible to users. App.tsx still routes to legacy `StudioStagePage`. | Frontend dead code |
| **G03** | Generation bridge not implemented (executorClass = `generation-bridge-pending`) | Image-generation, image-to-video, text-to-video nodes PARk permanently in runs. No path to Generation V2 from Studio Run engine. | Design gate, not a coding error |
| **G04** | `src/pages/Studio/StudioCanvasPage.tsx` does not exist | App.tsx references a page that was never created. `StudioStagePage` is still the active page (uses old `InfiniteCanvas`). | Missing file |

### 2.2 High-Priority Gaps (P1)

| # | Gap | Impact | Status |
|---|-----|--------|--------|
| **G05** | Admin Workers/Attempts pages (G3) not built | Read-only observability for run engine (like G3 for generation-v2). No admin UI for Studio run monitoring. | Backend API ready (studioRunApi), UI missing |
| **G06** | Provider Health page (admin/provider-health) not built | `/api/providers/states` and `/api/admin/ai-provider-health` exist but no dedicated UI. Admin must use ConsolePage. | Backend LIVE, UI missing |
| **G07** | No SSE bridge (task-updates → node state) | Studio run nodes show no real-time state changes from generation tasks. Inspector has no live progress. | Architecture decision pending |
| **G08** | Command palette (Cmd+K) not implemented | Design spec requires Cmd+K for create-node/jump/execute/search. NodeLibrary click works, palette missing. | UI gap |
| **G09** | Cost engine not implemented | Inspector has no cost estimate. Batch run shows no total cost. `costEstimatorContract.status = 'placeholder'` in registry. | Integration gap |
| **G10** | Multi-worker deployment not referenced in docker-compose.prod.yml | `studio-worker` process type defined but no compose service. Single-worker deployment only. | Ops gap |
| **G11** | V2 admin pages skeleton incomplete | AdminOverviewPage, AdminGenerationsPage, AdminAttemptsPage, AdminWorkersPage, AdminProviderHealthPage, AdminBindingsPage, AdminPricingPage, AdminExamplesPage, AdminReferenceStylesPage, AdminStoragePage, AdminPaymentPage — most are either placeholders or old pages not rewritten. | UI rewrite backlog |

### 2.3 Medium-Priority Gaps (P2)

| # | Gap | Impact |
|---|-----|--------|
| **G12** | No external metrics export (/metrics) | Cannot integrate with Prometheus/Grafana. MonitorPage uses ring buffer only. |
| **G13** | No alert delivery (webhook/email/pagerduty) | ConsolePage thresholds are client-side only. |
| **G14** | No request correlation/tracing | Cannot trace a Studio Run across API→Worker. No trace IDs. |
| **G15** | Old canvas module (`src/features/canvas/`) still present | 4-node legacy canvas (text/image/video/script) not removed. Dead code. |
| **G16** | Audio/TTS node disabled (G7) | Audio node type exists in spec but executor absent. One of 16 planned nodes non-functional. |
| **G17** | Node count mismatch: spec=16, implementation=10 | Missing: script(agent), episode(frontend), scene(frontend), storyboard(agent), text(agent), image-to-image, subtitle(agent), timeline(frontend), output(frontend). Some are structural/frontend-only per design, but spec table claims full implementation. |

---

## 3. PARALLEL_DAG

```
                    ┌─────────────────────────────────────┐
                    │    Phase 2 Plan J — Gap Sweep        │
                    └──────────────────┬──────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
              ▼                        ▼                        ▼
     ┌────────────────┐      ┌─────────────────┐      ┌──────────────────┐
     │  CRITICAL PATH │      │   G05-G09       │      │  G12-G17         │
     │  (P0 blockers) │      │   (P1, parallel)│      │  (P2, deferred)  │
     └────────┬───────┘      └────────┬────────┘      └────────┬─────────┘
              │                       │                        │
    ┌─────────┼─────────┐     ┌───────┼───────┐        ┌───────┼───────┐
    │         │         │     │       │       │        │       │       │
    ▼         ▼         ▼     ▼       ▼       ▼        ▼       ▼       ▼
 G01       G02        G03  G06     G08    G09   G12     G15    G16
 mount    wire       gen   health  cmd+K  cost  metrics  cleanup audio
 API      page       bridge            engine            old-canvas  disabled

 G04 is a
 consequence
 of G02
```

**Critical Path (sequential dependencies)**:

```
G01 (mount studioRunApi)
  └─→ G04 (create StudioCanvasPage) — can parallelize with G02
G02 (wire StudioPage into App.tsx)
  └─→ G03 (implement generation bridge) — blocks run engine from producing media
```

---

## 4. FILE/BRANCH_BOUNDARIES

### 4.1 Files Needing Changes (Read-Only Audit Complete)

| File | Change Type | Risk |
|------|-------------|------|
| `server/server.js` (~line 1476–1520, ~line 2437) | Add studioRunApi import + route registration | **LOW** — pure wiring, no logic change |
| `src/App.tsx` (~line 178–180) | Replace StudioStagePage route with StudioPage | **LOW** — route swap, old page preserved |
| `src/pages/Studio/StudioCanvasPage.tsx` | Create new file | **NONE** — new file, no existing file touched |

### 4.2 Files Already Written (No Changes Needed)

| File | Purpose |
|------|---------|
| `server/modules/project-foundation/studioRunApi.cjs` | Run API handler (CREATE/LIST/DETAIL/CANCEL) |
| `server/modules/project-foundation/studioRunEngine.cjs` | DAG execution engine (stateless, PG-authority) |
| `server/modules/project-foundation/studioRunExecutors.cjs` | Deterministic executors (SOURCE/ASSET/OUTPUT) |
| `server/modules/project-foundation/studioRunGraph.cjs` | DAG compiler (topological sort) |
| `server/studio-worker.cjs` | Worker daemon entrypoint |
| `src/features/studio-v2/StudioPage.tsx` | Full Studio UI (ready, just not routed) |
| `src/features/studio-v2/{store,persistence,registry,types}.ts` | Core feature modules |

### 4.3 Branch Strategy

```
feat/moling-v2-m05d-durable-dag   ← CURRENT (this task's workspace)
├── c0/phase1-repair-ha-lb        ← Phase-1 worktree (do not touch)
├── c0/phase1-repair-ha-sse       ← Phase-1 worktree (do not touch)
├── fix/v2-studio-routing         ← Recommended: G01+G02+G04
└── feat/v2-generation-bridge     ← Recommended: G03 (separate, larger)
```

---

## 5. TEST/ACCEPTANCE

### 5.1 Acceptance Criteria for P0 Fixes

| ID | Criterion | Verification |
|----|-----------|--------------|
| A01 | `GET /api/v2/projects/:id/studio/runs` returns 200 with auth | `curl -H "Cookie: session=..." http://localhost:18001/api/v2/projects/<id>/studio/runs` |
| A02 | `POST /api/v2/projects/:id/studio/runs` creates run with QUEUED status | Response includes `{id, status: "QUEUED", nodeCount}` |
| A03 | `@/pages/Studio/StudioCanvasPage.tsx` renders StudioPage | Vitest jsdom test: `render(<StudioCanvasPage />)` → `[data-test="studio-page"]` exists |
| A04 | `/studio/:projectId` navigates to StudioPage (not StudioStagePage) | Playwright: navigate to `/studio/<project-id>` → URL matches, no `StudioStagePage` in DOM |
| A05 | Build passes after route change | `npm run build` exits 0 |
| A06 | Typecheck passes after route change | `npm run typecheck` exits 0 |

### 5.2 Existing Test Coverage

| Module | Test File | Tests | Status |
|--------|-----------|-------|--------|
| studioRunEngine | `studio-run-engine.test.cjs` | ~30 | PASS |
| studioRunApi | `studio-run-api.test.cjs` | ~15 | PASS |
| studioRunCompiler | `studio-run-compiler.test.cjs` | ~10 | PASS |
| studioCanvasPersistence | `studio-canvas-persistence.test.cjs` + `studioCanvasPersistence.test.ts` | ~25 | PASS |
| studioEpisodeApi | `studio-episode-api.test.cjs` | ~10 | PASS |
| studioShotApi | `studio-shot-api.test.cjs` | ~8 | PASS |
| studioProductionNodes | `studioProductionNodes.test.ts` | 9 | PASS |
| studioProductionNodesValidation | `studioProductionNodesValidation.test.ts` | 13 | PASS |
| studioProductionNodesNormalization | `studioProductionNodesNormalization.test.ts` | 14 | PASS |
| studioNodeSchema | `studioNodeSchema.test.tsx` | 9 | PASS (incl. 485ms model loading test) |
| studioCanvas | `studioCanvas.test.ts` | 17 | PASS |
| **Total verified** | | **~185** | **ALL PASS** |

---

## 6. DEPENDENCIES

### 6.1 Hard Dependencies (Blocking)

```
G01 (mount studioRunApi) → requires: studioRunApi.cjs (DONE)
G02 (wire StudioPage)    → requires: StudioPage.tsx (DONE)
G04 (create page file)   → requires: G02 resolution
G03 (gen bridge)         → requires: G01 (needs run ID to submit to Generation V2)
```

### 6.2 Soft Dependencies (Parallel)

```
G05 (Admin Workers/Attempts) → requires: G01 (API must be live first)
G06 (Provider Health page)   → independent
G07 (SSE bridge)             → requires: G01 + G03
G08 (Command palette)        → independent
G09 (Cost engine)            → independent (reads model_pricing table)
G10 (docker-compose)         → independent (ops config)
```

### 6.3 Phase-1 Dependency

```
Phase-1 worktrees (phase1-repair-ha-lb, phase1-repair-ha-sse) 
  → Must NOT be interfered with (per task rules)
  → Phase-1 Final Gate remains authoritative
  → This plan revised IF Phase-1 finds new blockers
```

---

## 7. CRITICAL_PATH

```
WALL-CLOCK (estimated, single writer):

Step 1: Mount studioRunApi in server.js
        └─ Time: ~15 min (edit + restart + curl verification)
        └─ Risk: LOW (wiring only)
        
Step 2: Create src/pages/Studio/StudioCanvasPage.tsx
        └─ Time: ~20 min (import StudioPage, wrap in ProjectShell)
        └─ Risk: NONE (new file)
        
Step 3: Wire StudioPage into App.tsx
        └─ Time: ~10 min (route swap)
        └─ Risk: LOW (old route preserved as fallback)
        
Step 4: Verify — build + typecheck + test + curl
        └─ Time: ~10 min
        └─ Risk: LOW
        
──────────────────────────────────────────────
TOTAL CRITICAL PATH: ~55 min (single writer)
```

**Parallel opportunity**: Steps 2 and 3 are independent (different files). Can be done by two writers simultaneously.

---

## 8. ESTIMATED_SAFE_PARALLELISM

| Group | Tasks | Writers | Overlap Safe? |
|-------|-------|---------|---------------|
| Group A | G01 (server.js) | Writer 1 | ✅ |
| Group B | G02+G04 (App.tsx + new page) | Writer 2 | ✅ (different files) |
| Group C | G05 (Admin Workers/Attempts) | Writer 3 | ⚠️ After G01 completes |
| Group D | G06 (Provider Health) | Writer 4 | ✅ Independent |

**Maximum safe parallelism**: 2 writers (A+B overlap). C must wait for A.

---

## 9. P0/P1 RISKS

### P0 Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| studioRunApi mount conflicts with existing route patterns | Low | server.js uses prefix matching; studioRunApi is under `/api/v2/projects/:id/studio/runs` — no overlap with existing `/api/v2/projects/:id/studio/canvas` |
| App.tsx route swap breaks existing StudioStagePage for drama flow | Medium | Keep StudioStagePage route as fallback `/studio/:projectId/drama`; StudioPage at `/studio/:projectId` (exact match wins) |
| Old `src/features/canvas/InfiniteCanvas` import still in StudioStagePage | Low | Isolated to old page; new StudioPage imports from `studio-v2/` only |

### P1 Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Generation bridge (G03) scope creep — too large for this phase | High | Explicitly mark G03 as Phase-2 NEXT; do not implement in this sweep |
| Admin page rewrite (G11) scope exceeds Phase-2 capacity | High | Defer to separate task; focus on routing fix only |
| Docker compose update (G10) requires ops approval | Medium | Document as recommendation, do not deploy |

---

## 10. WHAT_NOT_TO_BUILD

Per task constraints (READ_ONLY, do not modify production, do not interfere with Phase-1):

| Item | Reason |
|------|--------|
| **Generation bridge implementation** (G03) | Out of scope for gap sweep; requires Generation V2 integration design |
| **Admin page rewrites** (G11) | Large UI effort; not a blocker for Studio core |
| **Docker compose changes** (G10) | Ops decision; document only |
| **Old canvas cleanup** (G15) | Dead code removal; no user impact |
| **External metrics/alerts** (G12–G14) | Observability Phase (see phase2-plan-d-observability.md) |
| **Audio/TTS node** (G16) | Back-end dependency (TTS provider) not ready |
| **Node count alignment** (G17) | Spec vs implementation gap is documentation; 10 nodes = 10 production nodes |
| **Multi-node HA fixes** (SN-01 to SN-33) | Phase-1 scope; this task is READ_ONLY |

---

## SUMMARY

### Highest-Impact Remaining Gaps (Ranked)

1. **G01** — Mount `studioRunApi` in `server.js` (5 min edit, blocks all run functionality)
2. **G02+G04** — Wire `StudioPage` into `App.tsx` and create missing page file (15 min, blocks product access)
3. **G03** — Implement generation bridge (generator nodes currently park permanently) — **defer to next phase**
4. **G05** — Admin Workers/Attempts pages (G3 read-only APIs exist, UI missing)
5. **G06** — Provider Health admin page

### Recommended Action

**Execute G01+G02+G04 in a single focused branch** (`fix/v2-studio-routing`). This is a pure wiring task — no logic changes, no new backend modules, no schema changes. Estimated 55 min wall-clock for one writer, 30 min with two writers.

After completion, verify with:
1. `npm run typecheck` (must pass)
2. `npm run build` (must pass)
3. `npm run test` (must pass — no regression)
4. Manual: `curl` the mounted endpoint
5. Manual: navigate to `/studio/:projectId` in browser

**Phase-1 Final Gate remains authoritative.** This plan must be revised if Phase-1 finds new blockers.
