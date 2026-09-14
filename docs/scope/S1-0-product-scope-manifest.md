# S1-0 · 1.0 Product Scope Manifest

**Product:** 墨灵 AI — AI-Native Commercial Video Production OS
**Branch:** `feat/moling-v2-m05d-durable-dag`
**Work item:** G0-03  — Enforce 1.0 scope firewall (no destructive deletion)

## Product Lock (immutable)

AI-Native Commercial Video Production OS / AI 原生商业影像生产操作系统.
On the 1.0 product lock, public navigation shows only the core product flow.
Marketplace-like surfaces (Shop / AI 市集) and the complete V2 Factory UI are
feature-flagged OFF for the public; their code is preserved (never deleted).

## In-Scope / Already Flagged (1.0 core flow)

| Surface | Route | Gate |
|---|---|---|
| V2 core shell / Factory preview | `/__v2/*` | `V2_APP_SHELL` (default OFF in prod build) |
| Studio V2 (canvas + production nodes) | `/__v2/studio`, `/__v2/projects` | `V2_STUDIO`, `V2_ASSETS` (default OFF in prod build) |
| AI Control (video generation v2) | — | `V2_AI_CONTROL` |
| Admin backbone, auth, permissions, state | — | always on |

## Out-of-Scope (firewalled, code preserved)

| Surface | Route | Gate | Re-enable |
|---|---|---|---|
| Shop / AI 市集 (M6, marketplace/skill) | `/shop` | `SHOP_ENABLED` feature flag (default OFF) | `VITE_FF_SHOP_ENABLED=1` |

## Firewall Mechanism

`featureFlags.ts` is the single source of truth. Resolution order (first wins):
1. Build-time env (`VITE_FF_*`)
2. localStorage override (dev/UAT only)
3. Hard-coded default

**Scope firewall:** `FF.SHOP_ENABLED` defaults to `false` regardless of env, so
the `/shop` route renders `ScopeDeniedPage` in dev and prod. The Shop page code
and the e-commerce Project Type (`mode: 'ecommerce'` in
`server/modules/project-foundation/projectTypeModes.cjs`) are preserved.

## Firewall Sites (files touched)

| File | Change |
|---|---|
| `src/shared/config/featureFlags.ts` | Added `SHOP_ENABLED` to `FF`, `resolveFlag`, `getFeatureFlags` |
| `src/pages/ScopeDeniedPage.tsx` | New: renders "module not in 1.0 scope" with back-to-workspace link |
| `src/App.tsx` | `/shop` route conditional on `SHOP_ENABLED`; imports `ScopeDeniedPage` |
| `src/components/navigationDockConfigs.ts` | Global nav `global-shop` item hidden when flag OFF |
| `src/components/ProductSwitcher.tsx` | Shop entry removed from pill nav |
| `src/pages/LandingPage/LandingPage.tsx` | Shop CTA button hidden when flag OFF |
| `src/__tests__/v2/featureFlags.test.ts` | `SHOP_ENABLED` default-OFF coverage + no-op in prod |

## Verification commands

```bash
npm run test       # vitest (241 tests incl. SHOP_ENABLED)
npx tsc -p tsconfig.app.json --noEmit   # typecheck (passes)
```

## No-production-changes

- No `.env` mutation, no DB migration, no Docker/compose change.
- `server/shop.cjs` untouched (no server-side flag exists to respect; the
  firewall is enforced client-side at the route + navigation layer).
- All changes are additive and reversible via the `SHOP_ENABLED` feature flag.
