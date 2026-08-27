# M02-B — Provider + Key Pool Management

Status: implemented. Builds on M02-A (`a53a5b4`); QG-001 green baseline
(`1ebcde8`) is the parent. No production deploy; no push.

## What ships

### Backend (server-side authority)
- `server/modules/ai-control/services/providerService.cjs`
  - Provider CRUD: create / update (optimistic lock, `revision`) /
    enable-disable / masked detail view with summaries (bindings, models).
  - Key pool: add (single/batch, **dedupe-correct counting**), metadata update
    (label/status/weight/rpm/concurrency), delete, cooldown set/clear.
  - `classifyCredentialSource()` — **POOL / LEGACY_FALLBACK / NONE** (B5):
    the runtime prefers `api_keys` pool; `providers.api_key` is an explicit,
    visible legacy fallback. The UI must say "遗留回退生效", not imply the
    provider has no credential.
  - Every key mutation calls injected `onPoolChanged(providerId, rows)` →
    server.js wires `dispatcher.syncKeyPool` (same runtime sync as the legacy
    routes; no behavior change to admission).
- `server/modules/ai-control/routes/aiControlRoutes.cjs`
  - `/api/v2/ai-control/providers…` HTTP surface. Admin-only (session +
    admin role), mounted in server.js before the legacy `/api/admin/*`
    delegation. Final `redactCredentialFields` pass on every response.
- `server/db/migrations/0011_legacy_key_pool_backfill.sql`
  - Forward-only, idempotent, INSERT-only, dedupe-safe (NOT EXISTS +
    ON CONFLICT DO NOTHING). Promotes each provider's legacy `api_key`
    into the pool labeled `legacy-backfill`. **`providers.api_key` is never
    modified or dropped** — fallback stays intact until a controlled cutover.
  - Rollback: `DELETE FROM api_keys WHERE label='legacy-backfill';`
- `server/scripts/legacy-key-backfill.cjs`
  - Manual rollout tool: `--dry-run` masked report (provider, source, masked
    fingerprint only) / apply. Mirrors 0011 SQL exactly.

### Contracts
- `contracts/openapi/moling-v2-ai-control.yaml` — provider create/update/enable,
  key pool list/add/update/delete/cooldown, `CredentialSource`, `KeysAdd*`,
  `KeyPoolView`. **No read response schema carries the full secret**
  (MaskedKey only). Regenerated `src/shared/api/contract/ai-control.d.ts`
  via `npm run contract:generate:ai-control`.

### Frontend (V2 admin, M00 design system)
- `src/shared/api/contract/ai-control-client.ts` — typed `v2ai` client
  (shared ApiClient, cookie session), `AiControlApiError` with stable `.status`.
- `src/features/admin-v2/V2AdminProviders.tsx` — list: search/filter/enable/
  disable/create; credential-source badge per provider.
- `src/features/admin-v2/V2AdminProviderDetail.tsx` — detail + key pool:
  credential source panel (POOL / 遗留回退生效 / 无可用凭据), key table
  (masked fingerprint, label, status, weight, RPM, concurrency, health,
  last used/error), add dialog (single/batch, password input), edit dialog,
  cooldown toggle, delete confirm; empty/error/loading states.
- Routes: `/__v2/admin/providers`, `/__v2/admin/providers/:id`
  (RequireAdminV2); nav item "Providers".

### Tests
- `server/tests/integration/ai-control-provider.test.cjs` — 18 e2e cases on a
  FRESH dedicated test DB (real server + PG): 401/403, create/get/list/search,
  masked reads, add/batch/dedupe, metadata update, cooldown, optimistic lock
  409, enable/disable, LEGACY_FALLBACK→POOL transition, delete 404,
  placeholder-secret handling, no-full-secret assertions.
- `server/modules/ai-control/services/providerService.test.cjs` — 8 unit cases
  (classification matrix, placeholder rules, masking).
- `server/db/migration.test.cjs` M20 — 0011 fresh/forward/idempotent/dedupe +
  legacy column preserved. (M19 expectation updated: forward from 0009 now
  applies 0010+0011.)
- `src/__tests__/v2/aiControlClient.test.ts` — 6 client cases (URL shapes,
  error normalization).
- `e2e/m02b-provider-keypool.spec.ts` — Playwright smoke (unauth redirect +
  authenticated resolved state, skipped without E2E creds).

## Production rollout procedure (0011)

1. Deploy code (migration auto-applies on boot via `node server/db/migrate.cjs`
   — or run it explicitly). 0011 is idempotent and INSERT-only.
2. Before/after, run the masked report:
   `node server/scripts/legacy-key-backfill.cjs --dry-run`
   Expect "to backfill: N" to drop to 0 after the migration.
3. Verify per-provider UI shows 密钥池 (POOL) where a legacy key existed.
4. Fallback removal is a SEPARATE, later, controlled cutover (after the
   pool is proven under traffic). M02-B does not remove it.

## Explicit non-goals (M02-C/D/E)
- Model Catalog UI (M02-C), full Routing/Pricing engine (M02-D),
  remaining admin + health engine (M02-E), Generation V2 workflow changes,
  Studio/Canvas/Drama/Asset/Commerce/Growth, production deploy, push.
