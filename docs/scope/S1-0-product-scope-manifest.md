# S1-0 · 1.0 Product Scope Manifest

**Product:** 墨灵 AI — AI-Native Commercial Video Production OS
**Worktree:** WSL P1 G0 recovery
**Seed commit:** `6ef2d15ba25a59b755327aefa6883a02d8718ad8`
**Date:** 2026-09-01

## Product Lock (immutable)

AI-Native Commercial Video Production OS / AI 原生商业影像生产操作系统

All work on this branch MUST preserve the lock. Any attempt to expand into
Shop / Marketplace / Agent Lab / Generic Workflow territory must be gated.

## In-Scope (1.0)

| Layer | What | Where |
|---|---|---|
| Core shell | V2 platform preview ( `/__v2/*` ) | feature flag `V2_APP_SHELL` |
| Project foundation | `src/features/project-foundation/` | always on |
| Studio V2 | canvas + production nodes | feature flags `V2_STUDIO`, `V2_ASSETS` |
| AI Control | video generation v2 orchestration | feature flag `V2_AI_CONTROL` |
| Admin backbone | auth, permissions, telemetry, state | always on |

## Out-of-Scope (firewalled)

| Surface | Route | Gate | Re-enable |
|---|---|---|---|
| Shop / AI 市集 (M6) | `/shop` | `SHOP_ENABLED` feature flag (default OFF) | `VITE_FF_SHOP_ENABLED=1` |
| Generic workflow surfaces | `/admin/routing`, `/admin/skills` | `GENERIC_WORKFLOW_ENABLED` (default OFF) | explicit operator flag |
| Agent Lab | `/admin/agents` | `AGENT_LAB_ENABLED` (default OFF) | explicit operator flag |

## Firewall Mechanism

**Pattern:** `featureFlags.ts` single-source-of-truth with three-resolution order:
1. Build-time env (`VITE_FF_*`)
2. localStorage override (dev/UAT only)
3. Hard-coded default

**Prod guarantee:** `localStorage` layer is hard-disabled when `PROD=true`.
A console-injected override cannot flip any flag in production.

**Scope firewall (S1):** `FF.SHOP_ENABLED` defaults to `false` regardless of
environment, so the Shop route renders `ScopeDeniedPage` in both dev and prod.
To re-enable, the operator must:
- Set build env `VITE_FF_SHOP_ENABLED=1` (for a custom build), or
- Run with a non-prod `PROD` flag and set localStorage `ml2-ff-SHOP_ENABLED=1`.

## Firewall Sites (files touched)

| File | Change |
|---|---|
| `src/shared/config/featureFlags.ts` | Added `SHOP_ENABLED` to `FF`, `resolveFlag`, `getFeatureFlags` |
| `src/pages/ScopeDeniedPage.tsx` | New: shows "module not in scope" with back-to-workspace link |
| `src/App.tsx` | `/shop` route conditional on `SHOP_ENABLED`; imports `ScopeDeniedPage` |
| `src/components/navigationDockConfigs.ts` | Global nav `global-shop` item hidden when flag OFF |
| `src/components/ProductSwitcher.tsx` | Shop entry removed from pill nav |
| `src/pages/LandingPage/LandingPage.tsx` | Shop CTA button hidden when flag OFF |

## Tests

| Test file | Coverage |
|---|---|
| `src/__tests__/v2/featureFlags.test.ts` | `SHOP_ENABLED` default OFF in all environments; localStorage no-op in prod |

## Verification commands

```bash
npm run test            # unit tests
npm run lint            # eslint
npm run typecheck       # TypeScript
npm run build           # Vite build
```

## No-production-changes

- No `.env` mutation
- No DB migration
- No production Docker / compose change
- All changes are additive and reversible via feature flag
