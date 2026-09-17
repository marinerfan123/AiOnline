# Studio Inline Prompt Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Studio generation nodes runnable when the prompt is entered directly in the composer, while preserving strict graph validation for missing non-text inputs.

**Architecture:** Treat a non-empty generation node `data.prompt` or `data.parameters.prompt` as a durable inline TEXT input. The browser validator, Inspector run gate, and server DAG compiler will share the same compatibility rule; explicit prompt-node edges remain the preferred graph representation. Add regression coverage for the compiler, validation, and Inspector behavior, then deploy the verified build.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, Node.js `node:test`, Express, PostgreSQL-backed Studio canvas/run APIs, Docker Compose.

## Global Constraints

- Do not weaken required validation for image/video/reference inputs.
- Do not print or commit credentials, tokens, API keys, or `.env` contents.
- Preserve existing worktree changes and do not use destructive Git commands.
- Verify tests, typecheck, build, and the production API symptom before claiming completion.

---

### Task 1: Define the inline text compatibility rule

**Files:**
- Modify: `src/features/studio-v2/validation.ts`
- Modify: `server/modules/project-foundation/studioRunGraph.cjs`
- Test: `src/features/studio-v2/validation.test.ts`
- Test: `server/tests/integration/studio-run-compiler.test.cjs`

**Interfaces:**
- Produces `hasInlineTextInput(node)` for browser validation and an equivalent server-local check for persisted node rows.
- A required `text` port on a generation node is satisfied only by a connected edge or a non-blank inline prompt; required image/reference ports remain edge-only.

- [x] **Step 1: Add failing browser tests** for a generation node with `data.prompt` and for a generation node without any prompt.
- [x] **Step 2: Add a failing compiler test** proving an inline prompt compiles and an empty prompt still returns `REQUIRED_PORT_MISSING`.
- [x] **Step 3: Run the focused tests** and confirm the new inline-prompt cases fail before implementation.
- [x] **Step 4: Implement the shared browser helper and server compiler fallback** without changing explicit edge behavior.
- [x] **Step 5: Run the focused tests** and confirm the new and existing cases pass.

### Task 2: Gate the UI run action on actual readiness

**Files:**
- Modify: `src/features/studio-v2/Inspector.tsx`
- Modify: `src/features/studio-v2/Inspector.run.test.tsx`

**Interfaces:**
- The Inspector Run button uses `computeReadiness(...).executionReady`, so it cannot issue a request known to fail compilation.
- Missing prompt/model state is shown inline; a valid inline prompt can run without an explicit prompt node.

- [x] **Step 1: Update Inspector tests** for disabled missing-input state and enabled inline-prompt state with a valid model catalog item.
- [x] **Step 2: Run the Inspector test file** and confirm the new expectations fail before implementation.
- [x] **Step 3: Use readiness for `isRunnable`** and mark inline text as satisfied in the port summary.
- [x] **Step 4: Run the Inspector and validation tests** and confirm they pass.

### Task 3: Full verification and production rollout

**Files:**
- Modify: `docs/superpowers/plans/2026-09-17-studio-inline-prompt-run.md` only if execution notes are needed.

**Interfaces:**
- No secrets enter the repository or build artifacts.
- Production deployment uses the existing `/opt/moling` Docker Compose workflow and the tested Git commit.

- [x] **Step 1: Run the complete relevant test suite, TypeScript typecheck, and production build.**
- [ ] **Step 2: Review the diff and commit the fix on `codex/ai-control-model-catalog`.**
- [ ] **Step 3: Push the commit to the configured GitHub branch without exposing the token.**
- [ ] **Step 4: Deploy the pushed commit to production using the existing server workflow.**
- [ ] **Step 5: Re-run the authenticated production estimate probe against the affected canvas and verify `REQUIRED_PORT_MISSING` is gone; report any remaining executor limitation separately.**
