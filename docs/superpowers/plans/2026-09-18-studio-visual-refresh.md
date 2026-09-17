# Studio Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Studio infinite canvas visibly modern and layered while preserving the existing node, run, persistence, and test contracts.

**Architecture:** Keep React Flow as the canvas engine and keep the Zustand store/API untouched. Add a dedicated visual hierarchy through semantic Studio shell classes, floating glass panels, a calmer canvas grid, richer node cards, and responsive rails; use CSS for most visual treatment so behavior remains isolated from presentation.

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, scoped CSS, `@xyflow/react`, Lucide icons, Vitest.

## Global Constraints

- Preserve existing `data-test` attributes and public component props.
- Do not change graph state, run/persistence behavior, node registry semantics, or API contracts.
- Keep the canvas usable at desktop widths and collapse nonessential rail content below 1180px.
- Use the existing dark Moling palette, with visible accent colors for selection, status, and primary actions.
- Verify with focused tests, typecheck, production build, and an online static-resource check before claiming deployment.

---

### Task 1: Establish the Studio visual shell

**Files:**
- Modify: `src/features/studio-v2/StudioPage.tsx`
- Modify: `src/features/studio-v2/TopToolbar.tsx`
- Modify: `src/features/studio-v2/NodeLibrary.tsx`
- Modify: `src/features/studio-v2/Inspector.tsx`
- Modify: `src/features/studio-v2/studio.css`
- Test: `src/features/studio-v2/StudioPage.test.tsx`

**Interfaces:**
- Consumes: Existing `StudioLayout` composition and all current toolbar/rail props.
- Produces: `.studio-shell`, `.studio-topbar`, `.studio-rail`, `.studio-canvas-stage`, `.studio-inspector` hooks with unchanged behavior and test IDs.

- [x] **Step 1: Add semantic shell classes without changing component wiring.**
  Keep `TopToolbar`, `NodeLibrary`, `StudioCanvas`, `StudioComposer`, `AssetLibraryDrawer`, `CanvasConflictBanner`, `Inspector`, and `BottomDock` in the same order. Add classes/data attributes that describe the visual regions and make the center canvas an explicitly layered stage.

- [x] **Step 2: Add the visual toolbar hierarchy.**
  Turn the thin header into a translucent command bar with a compact brand mark, project breadcrumb, project type pill, save-status indicator, and asset library action. Keep the existing links, save status labels, retry, reload, and toggle callbacks intact.

- [x] **Step 3: Add visual rail headers and grouping.**
  Give the node library and inspector a panel header, section labels, and card-like inner groups while retaining search, collapse, selection, and action controls. Do not remove or rename any `data-test` hooks.

- [x] **Step 4: Style the shell and responsive behavior.**
  In `studio.css`, add scoped styles for glass surfaces, rounded rails, separators, accent highlights, focus states, scrollbar treatment, and the compact layout breakpoint. Use CSS variables and existing `ml2` tokens rather than hardcoded page-wide colors.

- [x] **Step 5: Add a shell smoke assertion.**
  Extend the existing mocked `StudioPage` test to assert that the root exposes the new shell class while the existing `BottomDock` project/script wiring remains unchanged.

- [x] **Step 6: Run focused Studio tests.**
  Run `npm test -- --run src/features/studio-v2/StudioPage.test.tsx` and expect all existing and new assertions to pass.

### Task 2: Make the canvas and nodes visually distinct

**Files:**
- Modify: `src/features/studio-v2/StudioCanvas.tsx`
- Modify: `src/features/studio-v2/StudioNode.tsx`
- Modify: `src/features/studio-v2/studio.css`
- Test: `src/features/studio-v2/StudioNode.test.tsx`

**Interfaces:**
- Consumes: Existing React Flow callbacks, node registry, node selection, and command palette.
- Produces: A floating canvas command surface, layered grid/ambient lighting, visible zoom/minimap surfaces, and node cards with type/status hierarchy.

- [x] **Step 1: Add canvas stage chrome around existing controls.**
  Keep all React Flow handlers and commands unchanged. Add a stage label/status chip and class hooks around the existing command toolbar, interaction hint, empty state, minimap, and controls so CSS can distinguish floating chrome from the graph surface.

- [x] **Step 2: Replace the flat grid treatment with layered infinite-canvas styling.**
  Keep `BackgroundVariant.Lines` for pan/zoom-native rendering, but add a low-contrast radial ambient background, a fine grid overlay, and a stronger center stage separation. Ensure overlays use `pointer-events: none` except existing controls.

- [x] **Step 3: Refresh node card presentation.**
  Keep handles, previews, status labels, lock behavior, and node-specific content unchanged. Add type-color classes/data attributes and CSS for a title bar, status badge, preview well, selected glow, hover elevation, and readable empty placeholders.

- [x] **Step 4: Update empty-state composition.**
  Keep all current buttons and callbacks, but present the empty state as a welcome card with a small workflow badge, two primary template choices, and lightweight node shortcuts.

- [x] **Step 5: Add a visual node smoke assertion.**
  Extend the existing StudioNode tests to assert the node card still renders with its test hook and exposes the presentation data attribute for a known node kind.

- [x] **Step 6: Run focused canvas/node tests.**
  Run `npm test -- --run src/features/studio-v2/StudioCanvas.test.tsx src/features/studio-v2/StudioNode.test.tsx` (or the available matching Studio test files) and resolve any regressions without changing behavior.

### Task 3: Verify, publish, and confirm the visible deployment

**Files:**
- Modify: `docs/superpowers/plans/2026-09-18-studio-visual-refresh.md`

- [x] **Step 1: Run the full frontend verification.**
  Run `npm test`, `npm run typecheck`, `npm run lint:eslint`, and `npm run build`; record the observed pass/failure counts before deployment.

- [x] **Step 2: Inspect the built bundle for the new visual hooks.**
  Confirm the production output contains `studio-shell`, `studio-canvas-stage`, and the refreshed node presentation class/data attributes, ensuring deployment cannot silently serve the previous bundle.

- [ ] **Step 3: Commit and push the implementation branch.**
  Commit only the visual refresh and plan changes with a focused message, then push `codex/ai-control-model-catalog` to the configured GitHub repository.

- [ ] **Step 4: Deploy the verified build to the configured server.**
  Reuse the repository's established low-memory deployment path, rebuild/restart the Studio-serving services, and avoid changing secrets or unrelated services.

- [ ] **Step 5: Verify the online deployment.**
  Check HTTP health, fetch the production HTML/static asset manifest, and confirm the new bundle/class tokens are present. If an authenticated browser session is available, open the project Studio and take a screenshot; otherwise report the authenticated-session limitation explicitly.
