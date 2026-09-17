# Studio Run Status Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the Studio Inspector's Run status synchronized with the durable server status so a transient `BLOCKED` or `QUEUED` response cannot remain visible after the worker completes the run.

**Architecture:** The Zustand run action will poll the existing `studioRunClient.getRun` endpoint after creation, update `lastRun` on each status change, and stop on terminal status or a bounded timeout. The API remains the source of truth; no new endpoint or database mutation is required.

**Tech Stack:** React, TypeScript, Zustand, Vitest, existing Studio Run API.

## Global Constraints

- Preserve the deterministic idempotency key and existing single-flight guard.
- Do not expose provider URLs, prompts, tokens, or secrets in client state or logs.
- Treat `COMPLETED`, `FAILED`, and `CANCELLED` as terminal; keep `BLOCKED` pollable because the worker may requeue legacy runs.

### Task 1: Add the polling regression test

**Files:**
- Modify: `src/features/studio-v2/store.test.ts` or the existing Studio store test file that covers `runNode`.
- Modify: `src/features/studio-v2/store.ts` only after the failing test is confirmed.

**Interfaces:**
- Consume `studioRunClient.runNode` and `studioRunClient.getRun`.
- Produce a store transition from the create response status to the authoritative terminal detail status.

- [x] **Step 1: Add a test where creation returns `BLOCKED`, detail returns `COMPLETED`, and the store ends with `lastRun.status === 'COMPLETED'`.**
- [x] **Step 2: Run the focused store test and confirm it fails because the current action never calls `getRun`.**
- [x] **Step 3: Implement bounded polling with the existing API client and terminal-status predicate.**
- [x] **Step 4: Run the focused store test and confirm it passes.**

### Task 2: Verify and package the fix

**Files:**
- Modify: `src/features/studio-v2/store.ts` and its focused test only.

- [x] **Step 1: Run the full frontend test suite.**
- [x] **Step 2: Run typecheck and production build.**
- [ ] **Step 3: Inspect the diff for unrelated changes and commit the focused fix.**

### Task 3: Deploy and validate production

**Files:**
- No additional source files; deploy the verified commit to `/opt/www-moling-fun/source` and recreate the app container.

- [ ] **Step 1: Push the commit to the GitHub branch used by the deployment.**
- [ ] **Step 2: Recreate `app` while keeping PostgreSQL, Redis, and `studio-worker` running.**
- [ ] **Step 3: Verify container health, public `/studio` status, and the target Run's durable database status.**
- [ ] **Step 4: Confirm worker logs contain no new startup or execution errors.**
