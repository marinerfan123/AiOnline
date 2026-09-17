# Studio First-Tier Canvas Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the complete `/studio/:projectId` workbench around first-tier infinite-canvas conventions instead of an old three-column IDE shell.

**Architecture:** Keep React Flow, the Zustand graph store, and all existing run/persistence clients as the behavior layer. Recompose the surrounding shell into a compact global rail, an immersive project canvas, progressive-disclosure node and inspector panels, a contextual command bar, and a bottom utility dock; add visual tokens and responsive rules in the Studio stylesheet so the interaction contract remains stable.

**Reference principles:** Miro/FigJam-style spatial hierarchy, tldraw-style compact tool chrome, and modern node editors' progressive disclosure: canvas first, tools floating around it, panels collapsible, and no duplicated project navigation competing with the graph.

**Tech Stack:** React 19, TypeScript, React Flow, Zustand, Lucide, Tailwind utilities, scoped CSS, Vitest.

## Global Constraints

- Preserve node graph state, React Flow callbacks, run/persistence/collaboration behavior, and all existing `data-test` selectors.
- `/studio/:projectId` must remain the only route behavior changed; ordinary project pages keep their current `ProjectShell` layout.
- Do not show controls for unsupported behavior; every visible action must call an existing handler or an existing command.
- Default desktop state: compact global navigation, open node library, open inspector only when a node is selected, and a collapsed bottom dock.
- Verify at 1440px desktop, 1180px compact desktop, and 768px mobile widths with no horizontal overflow.

---

### Task 1: Make Studio immersive and reclaim the canvas

**Files:**
- Modify: `src/components/layouts/StudioLayout.tsx`
- Modify: `src/features/project-foundation/ProjectShell.tsx`
- Modify: `src/features/studio-v2/StudioPage.tsx`
- Modify: `src/features/studio-v2/studio.css`
- Test: `src/features/studio-v2/StudioPage.test.tsx`
- Test: `src/__tests__/v2/projectShell.test.tsx`

**Interfaces:**
- Consumes: Existing `NavigationDock`, `ProjectShell`, `ProjectContext`, and Studio composition.
- Produces: `studio-app-shell`, `studio-project-shell`, and `studio-immersive` hooks; `ProjectShell` gains an optional `immersive` prop defaulting to `false`.

- [x] **Step 1: Add the immersive project-shell prop.**
  Extend `ProjectShell` and its inner component with `immersive?: boolean`, preserve the current header when false, and render the existing project content without the project header when true. Keep `ProjectProvider`, loading/error states, and `data-test="project-shell-content"` unchanged.

- [x] **Step 2: Compact the Studio global navigation only.**
  Add local expanded state in `StudioLayout`, pass `expanded={false}` initially and `onExpandedChange` to `NavigationDock`, and add semantic shell classes. Do not modify `NavigationDock` defaults or other layouts.

- [x] **Step 3: Use the immersive shell for Studio.**
  Render `ProjectShell bareContent immersive` from `StudioPage`, keeping project identity in the Studio top bar and preserving all existing child props.

- [x] **Step 4: Style the app shell as a quiet utility rail.**
  Add scoped rules for the compact global rail, canvas-first content column, mobile menu bar, and no-scroll full-height behavior. The canvas must gain the space previously consumed by duplicated project navigation.

- [x] **Step 5: Add regression assertions.**
  Assert Studio uses immersive mode in the StudioPage mock and assert the default ProjectShell test still renders its header when `immersive` is omitted.

- [x] **Step 6: Run shell-focused tests.**
  Run `npm test -- --run src/features/studio-v2/StudioPage.test.tsx src/__tests__/v2/projectShell.test.tsx`.

### Task 2: Replace the permanent three-column rails with progressive disclosure

**Files:**
- Modify: `src/features/studio-v2/NodeLibrary.tsx`
- Modify: `src/features/studio-v2/Inspector.tsx`
- Modify: `src/features/studio-v2/BottomDock.tsx`
- Modify: `src/features/studio-v2/studio.css`
- Test: `src/features/studio-v2/BottomDock.test.tsx`

**Interfaces:**
- Consumes: Existing add/search/collapse handlers, selected-node store state, BottomDock query panels.
- Produces: Toggleable library/inspector rails and a floating utility dock with unchanged tab IDs and panel content.

- [x] **Step 1: Add a collapsible node library mode.**
  Preserve search, category collapse, drag/drop, click-to-add, and `data-test` hooks. Add a local expanded state, a header toggle, and a compact icon-only mode that still exposes each node item via its existing title and click/drag behavior.

- [x] **Step 2: Add a collapsible inspector mode.**
  Preserve selected-node forms, validation, run button, and shot inspector. Add a local compact mode with a clear expand control; default to expanded only when a node is selected and keep the canvas readable when nothing is selected.

- [x] **Step 3: Reframe BottomDock as a floating utility tray.**
  Keep `dock-tab-*`, `dock-close`, version actions, run list, history, and storyboard panels. Change only the wrapper classes so the collapsed strip floats above the canvas edge, while expanded content becomes a rounded tray with a clear active-tab header.

- [x] **Step 4: Add focus/keyboard affordances.**
  Ensure each new toggle has an accessible label/title and visible focus ring; do not intercept text input keyboard behavior.

- [x] **Step 5: Run rail/dock tests.**
  Run `npm test -- --run src/features/studio-v2/BottomDock.test.tsx src/features/studio-v2/Inspector.run.test.tsx src/features/studio-v2/StudioPage.test.tsx`.

### Task 3: Rebuild the canvas command hierarchy

**Files:**
- Modify: `src/features/studio-v2/StudioCanvas.tsx`
- Modify: `src/features/studio-v2/TopToolbar.tsx`
- Modify: `src/features/studio-v2/PresenceBar.tsx`
- Modify: `src/features/studio-v2/studio.css`
- Test: `src/features/studio-v2/CanvasCommandPalette.test.tsx`

**Interfaces:**
- Consumes: Existing canvas commands, fit/undo/redo actions, presence peers, and command palette.
- Produces: A compact top context bar, separated view/navigation controls, clear selection state, and consistent floating surfaces.

- [x] **Step 1: Create a canvas-first header.**
  Make the top toolbar a single project context bar with breadcrumb/back affordance, save state, collaborator presence, asset library, and a primary “运行选中” affordance only when an existing run action is available; do not invent a new backend action.

- [x] **Step 2: Separate editing actions from view actions.**
  Keep undo/redo/copy/delete together and fit/locate/reset together, using separators and icon labels. Keep command palette and all keyboard shortcuts intact.

- [x] **Step 3: Add a compact canvas status layer.**
  Present node/edge count, zoom/fit state, and interaction hints as low-contrast floating status chips; keep the graph and node cards as the highest-contrast content.

- [x] **Step 4: Improve empty and selection states.**
  Keep all existing starter workflow buttons but give the empty state a clear primary template, recent-action hints, and a neutral “drop or press /” prompt without fake data.

- [x] **Step 5: Run command/canvas tests.**
  Run `npm test -- --run src/features/studio-v2/CanvasCommandPalette.test.tsx src/__tests__/v2/studioCanvas.test.ts src/features/studio-v2/StudioNode.test.tsx`.

### Task 4: Establish the first-tier visual system

**Files:**
- Modify: `src/features/studio-v2/StudioNode.tsx`
- Modify: `src/features/studio-v2/studio.css`
- Test: `src/features/studio-v2/StudioNode.test.tsx`

- [x] **Step 1: Define canvas tokens.**
  Add a restrained neutral canvas, one accent color, semantic status colors, elevation levels, border alpha values, and spacing rules. Avoid repeating unrelated gradients on every surface.

- [x] **Step 2: Refine node cards by information hierarchy.**
  Keep registry-driven content and handles. Style the header, type icon, title, status, preview well, connected-port indicators, locked state, hover, and selected state so a graph reads at a glance.

- [x] **Step 3: Add responsive rules.**
  At 1180px compact the library/inspector; at 920px collapse them to icon rails or overlays; at mobile width keep the canvas usable with the existing mobile navigation drawer and no clipped bottom dock.

- [x] **Step 4: Add visual contract tests.**
  Assert semantic shell and node data attributes exist without changing functional selectors.

- [x] **Step 5: Run full frontend verification.**
  Run `npm test`, `npm run typecheck`, `npm run lint:eslint`, and `npm run build`.

### Task 5: Publish and verify the actual online experience

**Files:**
- Modify: `docs/superpowers/plans/2026-09-18-studio-first-tier-redesign.md`

- [x] **Step 1: Inspect the production bundle.**
  Confirm the generated JS/CSS contains the new shell, rail, canvas, and node presentation markers.

- [x] **Step 2: Commit and push the redesign branch.**
  Commit the implementation and plan, then push `codex/ai-control-model-catalog`.

- [x] **Step 3: Deploy the verified bundle.**
  Reuse the low-memory image-overlay deployment path used previously, recreate only `app` and `studio-worker`, and preserve the database, Redis, secrets, and unrelated services.

- [x] **Step 4: Verify online state.**
  Confirm the app health endpoint, public Studio HTML, actual Studio JS/CSS resources, container status, and new marker tokens. Report the authenticated-browser limitation if a project screenshot cannot be taken without user login.

**Deployment evidence (2026-09-18):**

- `npm test -- --run`: 79 files and 589 tests passed.
- `npm run typecheck`, `npm run lint:eslint`, and `npm run build`: passed; ESLint reports 0 errors and 21 pre-existing warnings.
- `app` and `studio-worker` were recreated from `www-moling-fun-app:latest`; PostgreSQL and Redis were preserved.
- `https://www.moling.fun/api/healthz`: HTTP 200 with `status: ok`, PostgreSQL, and Redis healthy.
- Production bundle contains `studio-app-shell`, `studio-canvas-tool-rail`, and `studio-bottom-dock` markers.
