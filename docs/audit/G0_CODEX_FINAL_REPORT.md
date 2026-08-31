# G0 Codex Final Report

## Final implementation SHA

`7548175ef599cd158a9bb1da7b243fc77d7bc0b0`

This is the complete G0-03/04/05 implementation commit. The audit report is
committed immediately afterward as documentation-only provenance.

## G0-03 — Scope Firewall

- `docs/scope/S1-0-product-scope-manifest.md`
- `scripts/scope-firewall.test.cjs`
- `src/App.tsx`
- `src/__tests__/v2/featureFlags.test.ts`
- `src/components/ProductSwitcher.tsx`
- `src/components/navigationDockConfigs.ts`
- `src/config/adminRegistry.ts`
- `src/pages/LandingPage/LandingPage.tsx`
- `src/pages/ScopeDeniedPage.tsx`
- `src/shared/config/featureFlags.ts`

Shop/Marketplace, Agent Lab, and generic routing/skill surfaces are default-off,
removed from default navigation, and guarded on direct access. Core workspace,
library, characters, and studio routes remain registered.

## G0-04 — Migration governance

- `docs/migrations/governance.md`
- `docs/migrations/rollback-policy.md`
- `server/db/migration-allocator.cjs`
- `server/db/migration-governance.test.cjs`
- `server/db/migration-inventory.cjs`
- `server/db/migration-preflight.cjs`

Inventory records historical gap `0015`, immutable head `0016`, and next P1
allocation `0017`. Reservation writes use an atomic directory lock and atomic
rename. Preflight fails closed for missing reservations, duplicates, gaps,
transaction control, destructive changes without a forward-fix/restore plan,
and reports lock-risk warnings. The documented limitation requires local
filesystem atomicity and manual confirmation before clearing a stale lock.

## G0-05 — Golden Path skeleton

- `harness/aggregator.cjs`
- `harness/entry.cjs`
- `harness/results-schema.json`
- `harness/runners/gp01-short-drama.cjs`
- `harness/runners/gp02-commercial.cjs`
- `harness/runners/gp03-ecommerce.cjs`
- `scripts/golden-path.test.cjs`

Aggregate result from the final temporary-directory CLI run:

- GP01: `NOT_READY`, 8 steps
- GP02: `NOT_READY`, 7 steps
- GP03: `NOT_READY`, 6 steps
- Summary: `pass=0 fail=0 not_ready=3 overall=NOT_READY`
- `GOLDEN_PATH_GP01`, `SMOKE_GP02`, `SMOKE_GP03`: `NOT_READY`
- `BROWSER_E2E`, `BACKUP_RESTORE_TEST`: `NOT_READY`
- Six unknown count metrics: `null`, permitted by the JSON schema
- Evidence paths and footprint: nonempty; full steps retained

## Shared support

- `.gitattributes` documents existing CRLF whitespace semantics so the required
  baseline diff check is deterministic.
- `package.json` exposes the three focused verification commands. Dependency
  versions and `package-lock.json` were not changed.

## Exact verification outcomes

- `npm run test:migration-governance` — PASS, 6/6 tests, including 4-writer concurrency and negative cases.
- `npm run golden-path:verify` — PASS, 7/7 tests.
- `npm run test:scope-firewall` — PASS, 3/3 static route/navigation tests.
- `npx vitest run src/__tests__/v2/featureFlags.test.ts --reporter=verbose` — PASS, 11/11 tests.
- `npm run typecheck` — PASS.
- `node scripts/golden-path.cjs --evidence-dir /tmp/moling-gp-final.SLq0s0` — expected exit 2 (`NOT_READY`), correct 0/0/3 aggregate.
- `git diff --check 6ef2d15ba25a59b755327aefa6883a02d8718ad8` — PASS.
- `git hash-object server/db/migrations/0016_studio_run_engine.sql` — `2552acd26fcded7da4c85d56cdf50ddefbb5bec2`.
- `git rev-parse 6ef2d15ba25a59b755327aefa6883a02d8718ad8:server/db/migrations/0016_studio_run_engine.sql` — same blob `2552acd26fcded7da4c85d56cdf50ddefbb5bec2`; byte-identical confirmed.
- `git diff --name-only -- harness/evidence package-lock.json` after final CLI run — empty; no tracked evidence dirt.

## Blockers and safety confirmation

No code or environment blockers remain. No migration was executed against any
database. Production/shared DB, SSH, production configuration, the main
checkout, sibling worktrees, and W6-08 were untouched. No push, merge, reset,
or clean operation was performed.
