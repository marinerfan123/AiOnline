# Studio Infinite Canvas Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Studio infinite canvas closer to current Miro, FigJam, tldraw, Excalidraw, and Canva whiteboard interaction patterns without changing the durable Run or persistence contracts.

**Architecture:** Keep React Flow as the camera, hit-testing, and connection engine. Add missing canvas actions to the existing Zustand store, expose them through the Inspector and a canvas-local command palette, and create starter graphs through the same registry/typed-edge path used by existing workflows. All new behavior remains local and undoable until the existing autosave subscription persists the resulting graph.

**Tech Stack:** React 19, TypeScript, @xyflow/react, Zustand, Vitest, Testing Library, lucide-react, Tailwind classes.

## Global Constraints

- Preserve the existing Studio Run API, model catalog, autosave/CAS, collaboration presence, and durable asset-id rules.
- Do not print or commit credentials, tokens, provider URLs, signed URLs, or `.env` contents.
- Use the Node Registry for node definitions and typed connection construction; do not create a second node catalog.
- Keep keyboard shortcuts guarded inside text inputs and content-editable fields.
- Verify focused tests, full tests, typecheck, lint, and production build before pushing or deploying.

---

### Task 1: Add selection distribution and starter workflow variants

**Files:**
- Modify: `src/features/studio-v2/store.ts`
- Modify: `src/features/studio-v2/Inspector.tsx`
- Modify: `src/features/studio-v2/StudioCanvas.tsx`
- Test: `src/__tests__/v2/studioCanvas.test.ts`
- Test: `src/__tests__/v2/studioInteractionGaps.test.tsx`

**Interfaces:**
- Add `distributeSelection(axis: 'horizontal' | 'vertical')` to the store and space selected non-frame nodes evenly between their outermost positions without changing the outermost nodes.
- Expand `createStarterWorkflow` to accept `image` and `video`, where `video` creates `Prompt -> Text-to-Video -> Output` with registry-derived ports and one undo entry.
- Inspector exposes horizontal/vertical distribution next to existing alignment actions.
- The empty state exposes both starter templates while keeping the existing image template behavior unchanged.

- [x] Step 1: Add store tests for horizontal and vertical distribution, no-op behavior for fewer than three nodes, and the video starter graph.
- [x] Step 2: Run the focused store tests and confirm the new assertions fail before implementation.
- [x] Step 3: Implement the store action and typed starter graph using `getNodeDef` and `buildEdge`.
- [x] Step 4: Add Inspector buttons and empty-state template buttons with stable `data-test` selectors.
- [x] Step 5: Run focused store, Inspector, and canvas interaction tests (52 tests passed).

### Task 2: Add a discoverable canvas command palette

**Files:**
- Create: `src/features/studio-v2/CanvasCommandPalette.tsx`
- Modify: `src/features/studio-v2/StudioCanvas.tsx`
- Test: `src/features/studio-v2/CanvasCommandPalette.test.tsx`
- Test: `src/__tests__/v2/studioInteractionGaps.test.tsx`

**Interfaces:**
- `CanvasCommandPalette` accepts `open`, `onClose`, and command callbacks; it renders a searchable list of node creation, view, and selection commands.
- Ctrl/Cmd+K toggles the palette; Escape closes it; typing filters commands; Enter invokes the highlighted command; text inputs never open it.
- Commands add nodes through `studioCanvasActions.addAtViewportCenter`, call React Flow `fitView`, and call existing store actions rather than duplicating graph logic.

- [x] Step 1: Add a component test for filtering, keyboard selection, Escape, and callback invocation.
- [x] Step 2: Run the focused palette test and confirm it fails before the component exists.
- [x] Step 3: Implement the palette with focus management, a bounded command list, and accessible labels.
- [x] Step 4: Wire CanvasCore keyboard handling and view/store callbacks; add a visible toolbar trigger.
- [x] Step 5: Extend interaction tests for Ctrl/Cmd+K and the text-field guard.

### Task 3: Improve canvas discoverability and verify the release

**Files:**
- Modify: `src/features/studio-v2/StudioCanvas.tsx`
- Modify: `src/features/studio-v2/studio.css`
- Modify: `docs/superpowers/plans/2026-09-18-studio-infinite-canvas-upgrade.md`

**Interfaces:**
- The canvas hint documents Space+drag, middle-button drag, wheel zoom, double-click add, and Ctrl/Cmd+K.
- The top canvas toolbar exposes undo/redo, copy/delete, command palette, fit-all, and fit-selected without altering existing data-test selectors.
- The completion notes record research sources and verification results without embedding remote page payloads or secrets.

- [x] Step 1: Add the command-palette trigger and fit-selected action to the existing toolbar.
- [x] Step 2: Update scoped canvas styles for the modal, toolbar, and focus states.
- [x] Step 3: Run all Studio tests, typecheck, lint, and production build (all passed; ESLint reports 21 pre-existing warnings).
- [ ] Step 4: Review the diff with a fresh code reviewer and fix all Critical/Important findings.
- [ ] Step 5: Commit, push the tested branch, deploy through the existing server workflow, and verify the public Studio route plus the affected Run status behavior.

## Research Notes

- Interaction patterns were compared against Miro, FigJam, tldraw, Excalidraw, and Canva Whiteboard: space-drag/middle-button pan, wheel zoom, command search, multi-selection alignment/distribution, starter templates, fit-selected, undo/redo, grouping, autosave, and collaboration presence.
- The implementation keeps React Flow as the camera and connection engine and routes new graph mutations through the existing Zustand store, registry, typed edges, and autosave path.

## Verification Notes

- Focused Studio tests: 5 files, 52 passed.
- Full frontend tests: 79 files, 584 passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run lint:eslint`: passed with 0 errors and 21 warnings.
- `npm run check:syntax`: 519 files, 519 passed, 0 failed.
