# Phase-2 Plan H: Frontend Commercial Workflow
**Task ID**: t_d1e27814
**Status**: Phase-2 PRE-PLANNING ONLY · READ_ONLY
**Date**: 2026-08-30
**Author**: molingw017 (analysis)

---

## 1. CURRENT_STATE

### 1.1 Frontend Routes (src/app/router/V2App.tsx)
| Route | Component | State |
|-------|-----------|-------|
| `/__v2` | Dashboard | ✅ Functional (health check, credit slot, theme) |
| `/__v2/admin/providers` | V2AdminProvidersPage | ✅ Complete |
| `/__v2/admin/providers/:id` | V2AdminProviderDetailPage | ✅ Complete |
| `/__v2/projects` | ProjectsPage | ✅ Complete |
| `/__v2/projects/new` | CreateProjectPage | ✅ Complete |
| `/__v2/projects/:projectId` | ProjectOverviewPage | ✅ Complete |
| `/__v2/projects/:projectId/assets` | ProjectAssetsPage | ✅ Complete |
| `/__v2/projects/:projectId/studio` | StudioPage | ✅ M05-A/B/C + M05-D1 stub (runs tab → "reserved") |
| `/__v2/create` | Placeholder | 🟡 Phase C |
| `/__v2/assets` | Placeholder | 🟡 Phase D |
| `/__v2/characters` | Placeholder | 🟡 Phase D |
| `/__v2/models` | Placeholder | 🟡 Phase C |
| `/__v2/tasks` | Placeholder | 🟡 Phase C |
| `/__v2/billing` | Placeholder | 🔴 Phase C |
| `/__v2/settings` | Placeholder | 🔴 Phase C |
| `/__v2/studio` (top-level) | Placeholder (V2_STUDIO flag) | 🔴 Phase E |

### 1.2 API Clients (src/shared/api/contract/)
| Client | Coverage | Status |
|--------|----------|--------|
| `client.ts` (v2) | /healthz, /readiness, /me | ✅ MVP proof |
| `project-client.ts` | Workspaces, Projects CRUD | ✅ Full |
| `asset-client.ts` | Asset CRUD, list, detail | ✅ Full |
| `studio-canvas-client.ts` | Canvas get/create/patch/versions | ✅ Full (M05-C) |
| `ai-control-client.ts` | Models, providers, keys CRUD | ✅ Full (M02-B) |
| **`studio-run-client.ts`** | Run create/list/get/cancel | ❌ MISSING — no frontend client |

### 1.3 Backend Modules (server/modules/project-foundation/)
| Module | Endpoints | Tests |
|--------|-----------|-------|
| `projectFoundation.cjs` | Workspace CRUD, Project CRUD, membership | ✅ integration tests |
| `assetFoundation.cjs` | Asset CRUD, S3/OSS write | ✅ integration tests |
| `studioCanvasPersistence.cjs` | Canvas get/patch/versions/restore | ✅ studio-canvas-persistence.test.cjs |
| `studioRunApi.cjs` | Run CREATE/LIST/GET/CANCEL | ✅ studio-run-api.test.cjs |
| `studioRunEngine.cjs` | DAG compile + lease + execute + cancel | ✅ studio-run-engine.test.cjs |
| `studioRunGraph.cjs` | Kahn topo sort, cycle detection | ✅ studio-run-compiler.test.cjs |
| `studioRunExecutors.cjs` | Deterministic executors (SOURCE/ASSET/OUTPUT) | ✅ test executors in studioRunTestExecutors.cjs |

### 1.4 Studio Frontend (src/features/studio-v2/)
| File | Lines | Status |
|------|-------|--------|
| `types.ts` | 230 | ✅ Production types (10 node kinds, port types, param schema) |
| `registry.ts` | 380 | ✅ Full node definition registry |
| `store.ts` | 547 | ✅ Zustand store, undo/redo, drag, frame grouping |
| `StudioPage.tsx` | 65 | ✅ Layout shell |
| `StudioCanvas.tsx` | 285 | ✅ ReactFlow wrapper + error boundary |
| `StudioNode.tsx` | - | ✅ Node renderer |
| `NodeLibrary.tsx` | 124 | ✅ Left rail, search + section collapse |
| `Inspector.tsx` | 243 | ✅ Right rail, validation, model catalog query |
| `ParameterInspector.tsx` | - | ✅ Schema-driven parameter controls |
| `TopToolbar.tsx` | 60 | ✅ Breadcrumb + save status |
| `BottomDock.tsx` | 45 | ✅ Tabs: Shots/Timeline/Runs/Version (Runs→reserved) |
| `useStudioCanvasPersistence.ts` | 110 | ✅ Auto-save with conflict handling |
| `validation.ts` | - | ✅ validateNode, computeReadiness |
| `persistence.ts` | - | ✅ Serialize/deserialize helpers |

### 1.5 Existing Legacy Routes (src/App.tsx — non-V2)
| Route | Page |
|-------|------|
| `/recharge` | RechargePage |
| `/shop` | ShopLayout (Cart, Checkout, Orders, ProductDetail, Seller) |
| `/account` | AccountPage (credit balance, recharge orders) |
| `/workspace/:id` | Workspace pages |

---

## 2. GAPS

### 2.1 Studio → Run Integration (Critical)
- **No frontend Run API client** (`studio-run-client.ts` missing). Canvas has versions but no "Run" concept on frontend.
- **BottomDock "Runs" tab** shows "M05-D Studio Run Engine — reserved". Needs real Run list + detail page.
- **No Run trigger button** on StudioPage or TopToolbar. User has no way to initiate a run from UI.
- **No cost estimation display** on nodes. `ParameterInspector.tsx` line 248 says "Cost estimate unavailable until Run Engine".
- **Generation executor missing**: M05-D1 executors return `EXECUTOR_NOT_AVAILABLE` for generation nodes. M05-E bridge needed.

### 2.2 Billing Module (Complete Void)
- `/__v2/billing` is a Placeholder. No API client, no page, no transaction history UI.
- **Backend billing endpoints**: `billing.cjs` (transactional), `payments.cjs` (payment processing) exist but no V2 frontend client.
- **Credit display** on AppShellV2 topbar shows `appStore.creditBalance` (null/mocked). No live fetch from `/api/auth/me`.
- **No charge attempt before run**: Studio run creation has no credit check.

### 2.3 Settings Module (Complete Void)
- `/__v2/settings` is a Placeholder. No page or API client.
- Likely needs: notification prefs, theme (already in appStore), privacy, account management.

### 2.4 Tasks Module (Complete Void)
- `/__v2/tasks` is a Placeholder.
- Backend has `studio_run_events` table (emitted in studioRunApi.cjs:88). No frontend query client.
- Need: task list page, task detail page, status tracking.

### 2.5 Model/Characters/Assets V2 Pages
- All placeholders. Assets has backend client (`asset-client.ts`) but no V2 page.
- Characters: no backend module yet (planned M06).
- Models: backend has `ai-control-client.ts` (model catalog), but no V2 models browse page.

### 2.6 Data Flow Gaps
1. **Credit balance never fetched**: `appStore.creditBalance` is set manually (see V2App.tsx:86 mock +100). Should subscribe to `/api/auth/me` updates.
2. **Studio run results never displayed**: Even if run completes, no UI to show results (output nodes have no display hook).
3. **No websocket/SSE for run progress**: `realtime.cjs` exists but not wired to Studio.

---

## 3. PARALLEL_DAG

```
                    ┌─────────────────────────────────────────┐
                    │  BASE: Backend APIs (already done)       │
                    │  - studioCanvasPersistence.cjs ✅        │
                    │  - studioRunApi.cjs ✅                   │
                    │  - billing.cjs / payments.cjs ✅         │
                    │  - ai-control-client.ts (models) ✅      │
                    └──────────────┬──────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
    ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
    │ BLOCK A:         │  │ BLOCK B:         │  │ BLOCK C:         │
    │ Studio Run UI    │  │ Billing Page     │  │ Settings Page    │
    │                  │  │                  │  │                  │
    │ 1. studio-run-   │  │ 1. billing-      │  │ 1. settings      │
    │    client.ts     │  │    client.ts     │  │    page.tsx      │
    │ 2. RunsTab       │  │ 2. BillingPage   │  │ 2. wiring        │
    │    component     │  │    in V2App.tsx  │  │    in V2App.tsx  │
    │ 3. RunDetail     │  │ 3. transaction   │  │                  │
    │    page          │  │    history UI    │  │                  │
    │ 4. Trigger btn   │  │                  │  │                  │
    │    on TopToolbar │  │                  │  │                  │
    └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
             │                     │                     │
             └─────────────────────┼─────────────────────┘
                                   ▼
                    ┌─────────────────────────────────┐
                    │  INTEGRATION: Wire them together  │
                    │                                   │
                    │  - Credit check before Run create │
                    │  - Show credit in TopToolbar live │
                    │  - Run result → Asset link        │
                    └─────────────────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────┐
                    │  PHASE C+: Filler modules         │
                    │  - Tasks (query run events)       │
                    │  - Models (browse catalog page)   │
                    │  - Characters (M06 backend first) │
                    │  - Assets V2 page                 │
                    └─────────────────────────────────┘
```

**Key Dependency**: Block A (Studio Run UI) must complete before Integration step, because the credit check wiring depends on knowing the Run API contract from the frontend.

---

## 4. FILE/BRANCH_BOUNDARIES

### 4.1 Files to CREATE (new, no conflicts)
| File | Block | Purpose |
|------|-------|---------|
| `src/shared/api/contract/studio-run-client.ts` | A | Run API client (wrap studioRunApi.cjs endpoints) |
| `src/features/studio-v2/RunsTab.tsx` | A | BottomDock runs tab content |
| `src/features/studio-v2/RunDetailPanel.tsx` | A | Side panel or modal for run details |
| `src/pages/Billing/BillingPage.tsx` | B | Billing page (transactions, top-up history) |
| `src/shared/api/contract/billing-client.ts` | B | Billing API client |
| `src/pages/Settings/SettingsPage.tsx` | C | Settings page skeleton |
| `src/shared/api/contract/settings-client.ts` | C | Settings API client (placeholder) |
| `src/pages/Tasks/TasksPage.tsx` | C+ | Task list (query studio_run_events) |
| `src/pages/Models/ModelsPage.tsx` | C+ | Model catalog browse page |
| `src/pages/Assets/AssetsPage.tsx` | C+ | V2 assets page (reuse asset-client.ts) |

### 4.2 Files to MODIFY
| File | Block | Change |
|------|-------|--------|
| `src/app/router/V2App.tsx` | A+B+C | Replace Placeholders with real pages |
| `src/app/config/nav.ts` | A+B | Add flags/runs tab badge |
| `src/features/studio-v2/StudioPage.tsx` | A | Add "Run" trigger button to TopToolbar |
| `src/features/studio-v2/BottomDock.tsx` | A | Wire RunsTab, add run status polling |
| `src/features/studio-v2/TopToolbar.tsx` | A | Add "Run" button + cost estimate display |
| `src/shared/state/appStore.ts` | Integration | Add creditBalance refetch on auth change |
| `src/app/shell/AppShellV2.tsx` | Integration | Subscribe credit display to live /me |

### 4.3 Branch Strategy
- **Primary branch**: `feat/moling-v2-m05d-durable-dag` (current)
- **Phase-1 worktrees** exist for HA/lb repairs — do NOT touch
- Each block (A/B/C) can be a separate branch off primary for parallel work:
  - `feat/v2-studio-runs` (Block A)
  - `feat/v2-billing` (Block B)
  - `feat/v2-settings` (Block C)
- Merge order: A → Integration → B → C → C+

---

## 5. TEST/ACCEPTANCE

### 5.1 Block A: Studio Run UI
| Test | Method | Pass Criteria |
|------|--------|---------------|
| Run API client unit test | vitest | All methods type-check, call correct endpoints |
| RunsTab renders | Playwright e2e | Tab switches, shows empty state, loads run list |
| Run trigger button | Playwright e2e | Click → creates run → shows loading → shows result |
| Cost estimate in inspector | Manual + unit | Generation nodes show "X credits" when model selected |
| Run cancellation | Playwright e2e | Cancel button → API returns ok → UI updates status |
| Conflict handling | Manual | 409 conflict → shows reload prompt → reload works |

### 5.2 Block B: Billing
| Test | Method | Pass Criteria |
|------|--------|---------------|
| Billing page loads | Playwright e2e | `/__v2/billing` renders without error |
| Transaction list | Playwright e2e | Shows past transactions with amount/description |
| Credit balance live | Playwright e2e | Topbar shows correct balance from /me |
| Recharge redirect | Playwright e2e | "Top up" button → navigates to `/recharge` |

### 5.3 Block C: Settings
| Test | Method | Pass Criteria |
|------|--------|---------------|
| Settings page loads | Playwright e2e | Renders without crash |
| Theme toggle persists | Manual | Changes theme, survives page reload |

### 5.4 Integration
| Test | Method | Pass Criteria |
|------|--------|---------------|
| Run without credits → 402 | Manual | Blocked with clear message |
| Run with credits → 202 | Manual | Run created, status QUEUED |
| Full flow: create canvas → add nodes → run → view result | Playwright e2e | End-to-end succeeds |
| App starts, loads V2 shell, no console errors | Manual | Clean dev startup |

---

## 6. DEPENDENCIES

| Depends On | Dependency Type | Details |
|------------|----------------|---------|
| `studioRunApi.cjs` | HARD | Backend Run API must be stable before frontend client |
| `studioRunEngine.cjs` | HARD | Engine must support generation executor bridge (M05-E) |
| `billing.cjs` | HARD | Credit deduction endpoint must exist |
| `payments.cjs` | HARD | Top-up/payment processing must exist |
| `ai-control-client.ts` | SOFT | Model catalog already wired into Inspector |
| `studioCanvasPersistence.cjs` | HARD | Canvas must persist before run can reference it |
| Phase-1 Final Gate | HARD | This plan must be revised if Phase-1 finds blockers |
| `V2_STUDIO` flag | CONFIG | Studio route gated by feature flag |
| `V2_APP_SHELL` flag | CONFIG | Entire V2 shell gated |

---

## 7. CRITICAL_PATH

```
studioRunApi.cjs (✅ done)
    ↓
studio-run-client.ts (new, Block A) — 0.5d
    ↓
RunsTab + RunDetailPanel (new, Block A) — 1d
    ↓
Trigger button on TopToolbar (modify, Block A) — 0.5d
    ↓
Credit check wiring (modify, Integration) — 0.5d
    ↓
TopToolbar live credit display (modify, Integration) — 0.5d
```

**Critical path total: ~3 days** (single-threaded)

**Parallelizable off-critical-path work:**
- Block B (Billing): 1.5d — independent of Block A
- Block C (Settings): 0.5d — independent of A+B
- C+ modules (Tasks, Models, Assets pages): 2d — depends on A completion for task history

---

## 8. ESTIMATED_SAFE_PARALLELISM

| Parallelism Level | Blocks | Rationale |
|-------------------|--------|-----------|
| **Level 1 (1 writer)** | Block A alone | Studio runs touches store + routing + new client — high coupling |
| **Level 2 (2 writers)** | Block A + Block B | A touches studio/*, B touches billing/* — no file overlap |
| **Level 3 (3 writers)** | A + B + C | All touch different files; C is lightweight |
| **Level 4 (unsafe)** | Add C+ modules | Tasks page reads from same run events as Block A — potential merge conflict |

**Recommended: Level 2** (A and B in parallel, C after A merges, C+ after Integration)

---

## 9. P0/P1 RISKS

### P0 Risks (Block Progress)
| Risk | Impact | Mitigation |
|------|--------|------------|
| **M05-E generation bridge not ready** | Run engine returns EXECUTOR_NOT_AVAILABLE for all generation nodes → runs complete with no output | Plan A includes stub UI for "pending generation" status; do not block Run UI on generation |
| **Billing credit deduction API missing** | No way to charge credits before run → users run for free | Check `billing.cjs` before starting Block A; if missing, add minimal endpoint first |
| **Phase-1 Final Gate finds blockers** | This entire plan needs revision | Monitor phase1-repair-ha-lb worktree status; pause if new issues emerge |

### P1 Risks (Quality Degradation)
| Risk | Impact | Mitigation |
|------|--------|------------|
| **studio-run-client.ts duplicates legacy api.ts patterns** | Inconsistent error handling, two client styles | Follow existing pattern from `studio-canvas-client.ts` exactly |
| **Run status polling floods server** | High-frequency polling on BottomDock | Use polling interval ≥ 5s; debounce; only poll when tab is active |
| **Credit display flickers on auth change** | Poor UX | Cache /me response; only update on explicit refresh or navigation |
| **Placeholder routes left behind** | Dead links in nav | Clear delete all Placeholder routes when replacing with real pages |

---

## 10. WHAT_NOT_TO_BUILD

### Explicitly Out of Scope (Phase 2)
- ❌ **Real generation execution** (M05-E) — generation bridge is a separate phase
- ❌ **Video compositing/timeline** (M05-D timeline tab) — reserved for future
- ❌ **Shot management** (M05-D shots tab) — reserved for future
- ❌ **Admin run management** — not in this plan; use backend directly
- ❌ **WebSocket/SSE for live run updates** — polling is sufficient for V1
- ❌ **Payment gateway integration** — reuse existing `/recharge` flow
- ❌ **Character module** — M06 backend not ready
- ❌ **V2 top-level `/__v2/studio` route** — keep nested under `/projects/:id/studio`
- ❌ **Design system expansions** — V2 UI components are sufficient
- ❌ **Multi-canvas support** — single primary canvas per project only
- ❌ **Real-time collaboration** — not in scope for commercial v1

### Deprecated/Not Rebuilt
- ❌ Legacy `/studio` routes (non-V2) — kept for backward compatibility, not touched
- ❌ Old `GenerationBar.tsx` — V2 Studio has its own flow, legacy bar untouched

---

## Summary

**Core deliverable**: A cohesive commercial Studio workflow where users can:
1. Open a project's Studio canvas
2. Build a node graph (already works)
3. See cost estimates on generation nodes
4. Trigger a run from the UI
5. View run progress and results
6. See credits deducted (or blocked if insufficient)
7. Navigate to a Billing page for transaction history

**Estimated wall-clock**: 5-7 days with 2 parallel writers (Blocks A+B).
**Critical path**: ~3 days single-threaded.
**Biggest risk**: M05-E generation bridge readiness — decouple by building UI that handles "pending" executor status gracefully.
