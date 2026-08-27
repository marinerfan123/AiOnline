# M00 Version Audit

Date: 2026-08-27 (UTC)
Method: `bash scripts/audit-versions.sh` — read-only npm registry check,
compared against local package.json ranges. Policy: latest dist-tag,
stable only (no beta/rc/canary). Major-version jumps require separate
review (not part of M00).

## Results

| package | local range | registry latest | decision |
|---|---|---|---|
| react | ^19.2.4 | 19.2.8 | keep local (patch resolves within ^19) |
| react-dom | ^19.2.4 | 19.2.8 | keep |
| react-router-dom | ^7.18.2 | 7.18.2 | current |
| typescript | ~5.9 | 7.0.2 (registry tag) | KEEP ~5.9 — TS 7 (native) is a major toolchain jump; project pinned, out of M00 scope |
| vite | ^8 | 8.2.2 | current major, ok |
| @tanstack/react-query | ^5.102.6 | 5.102.6 | current |
| zustand | ^5.0.15 | 5.0.15 | current |
| zod | ^4.3.6 | 4.4.3 | keep (major 4 stable; patch bump optional, not M00) |
| vaul | ^1.1.2 | 1.1.2 | current |
| @radix-ui/react-slot | ^1.3.0 | 1.3.3 | keep (^ resolves) |
| @radix-ui/react-select | ^2.1.14 | 2.3.7 | keep (^ resolves) |
| @radix-ui/react-dialog | ^1.1.14 | 1.1.23 | keep |
| @radix-ui/react-tooltip | ^1.1.18 | 1.2.16 | keep (^ resolves) |
| openapi-typescript | ^7.13.0 | 7.13.0 | current |
| storybook / @storybook/react-vite | ^10.5.10 | 10.5.10 | current |
| @playwright/test | ^1.62.1 | 1.62.1 | current |

Notes:
- All M00 additions (react-query, zustand, openapi-typescript, storybook,
  @playwright/test) installed at registry-stable majors matching the
  project's React 19 / Vite 8 / TS 5.9 baseline.
- No beta/rc/canary packages introduced.
- Raw audit output snapshot: see commit history of this file's generation
  (script is re-runnable: `bash scripts/audit-versions.sh`).

## Build size baseline (M00)

Captured from `npm run build` (vite 8, outDir dist/build2), 2026-08-27 verify:

| chunk | raw | gzip |
|---|---|---|
| assets/index-*.js (legacy entry) | 1,480.70 kB | 401.91 kB |
| assets/V2App-*.js (lazy V2 shell chunk) | 158.57 kB | 48.75 kB |
| assets/index-*.css | 259.07 kB | 35.42 kB |
| assets/V2App-*.css | 3.27 kB | 1.10 kB |

V2 shell is a lazy chunk — NOT in the legacy entry bundle (React.lazy in
App.tsx). Legacy bundle size is unchanged by M00.
Storybook build: `npm run storybook:build` → storybook-static (verified PASS).
Playwright smoke: `E2E_EMAIL=… E2E_PASSWORD=… npx playwright test`
(config: playwright.config.ts, webServer vite :5199, proxy → API_PROXY_TARGET
default :3001). Authenticated scenario self-skips without env credentials.
