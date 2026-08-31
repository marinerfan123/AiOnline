# Swarm Round Fix Report

Date: 2026-09-01

Branch: `p1/swarm-autopilot`

Verdict: ready for re-audit

## Authorized fixes completed

- P0 `server/server.js`: removed the public `/api/token` route. Browser API clients no longer fetch or retain the system bearer token and use the existing httpOnly `sid` session cookie.
- P0 `server/db.cjs`: production import now fails immediately when `PG_PASSWORD` is absent; the known fallback remains limited to non-production development/test execution.
- P1 `server/realtime.cjs`: capped SSE streams at `SSE_MAX_CONNECTIONS_PER_USER` (default 5), deterministically replacing the oldest stream and removing its listener/connection registration.
- P1 `AssetPicker.tsx`: project changes clear both rendered-picker cursor state and headless selected state; query keys already include `projectId`.
- P1 `useStudioCanvasPersistence.ts`: project generations invalidate late loads/saves and reset revision, dirty, conflict, snapshot, timer, and in-flight state.
- P1 `useStudioCanvasPersistence.ts`: autosaves are single-flight, subsequent edits flush using the returned revision, and failed patches are restored without overwriting newer buffered edits.

## Validation

- `node --test server/authorized-security-fixes.test.cjs` — pass.
- Focused Vitest suite (`apiClient`, `assetClient`, `studioCanvasPersistence`, `authorizedPersistenceRaces`) — 4 files, 20 tests passed.
- `npm run typecheck` — pass.
- `npm run build` — pass (existing chunk-size advisory only).
- Direct `node --check` over all `server/**/*.js` and `server/**/*.cjs` — pass.
- `git diff --check` — pass.
- `npm run check:syntax` could not execute its internal `/bin/sh` subprocess under the managed sandbox (`EPERM`); the equivalent direct syntax sweep above passed.

No rejected findings were changed. No production/shared database was accessed or mutated. G0 and migration 0016 were preserved, and W6-08 was not started.
