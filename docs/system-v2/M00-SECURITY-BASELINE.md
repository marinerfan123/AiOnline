# M00 Security Baseline

Scope: frontend M00 additions only. Backend business logic untouched.

## 1. No secrets in V2 build

- Vite only inlines `VITE_*` env vars; the repo contains no `.env`
  (only `.env.example`). Build output was grep-audited for
  API_TOKEN / password patterns — clean (verification log).
- The V2 client (`src/shared/api/client.ts`) talks same-origin `/api/*`
  with `credentials: 'include'` — no key material in bundle.

## 2. Legacy auth unchanged

- httpOnly session cookie mechanism untouched; M00 adds zero code to
  `src/services/auth*` or login flows.
- `RequireAuthV2` reuses the SAME `useAuth` store as legacy — single
  source of truth, no second session implementation.

## 3. Admin backend authorization unchanged

- M00 performs no backend changes. Admin middleware remains the final
  authority. `RequireAdminV2` / `<Can action="requireAdmin">` are UX-layer
  only and explicitly documented as non-security-boundaries.

## 4. V2 route guard behavior

- `/__v2/*` requires `V2_APP_SHELL` flag (prod default OFF → renders a
  static "preview disabled" card, no shell, no data fetch).
- When flag ON: unauthenticated users redirect to `/login` (UX).
  If a user somehow reaches V2 endpoints unauthenticated, the backend
  returns 401 as in legacy — guard is defense-in-depth, not the boundary.

## 5. Error display

- `src/shared/api/errors.ts` maps error codes to safe user-facing strings
  only. Server stack traces / internals are never rendered.
- V2 error handling adds no new `console.error(serverPayload)` paths.

## 6. Feature flags

- Flags gate UX only, never replace authz checks.
- Production build: all V2 flags default OFF AND localStorage overrides
  are hard-disabled (`featureFlags.ts localValue()` returns null in PROD),
  so a user cannot self-enable V2 in prod via console.
- Build-time `VITE_FF_*` env overrides exist for controlled UAT; the
  production deploy procedure does not set them.

## 7. XSS / input

- V2 primitives render data via React text nodes only; no
  `dangerouslySetInnerHTML` in M00 additions.

## Verification checklist (executed, see session log)

- [x] `grep -riE "api_token|password|secret" dist/build2/assets/*.js` → clean
- [x] tsc + build PASS
- [x] /__v2 with flag OFF in prod-mode build → disabled card (playwright)
- [x] unauthenticated /__v2 (flag ON) → redirects to /login (playwright)
