# M02-A — AI Control Plane Foundation

Status: implemented in this repo, tests green. No production behavior change:
the live runtime (dispatcher / modelhub) remains the **execution authority**;
this module is the upstream **configuration / resolution / audit** layer that
M02-B…E build on.

## Authority map (as found in real code, 2026-08)

| Domain            | Authority (single source of truth)                                   |
|-------------------|------------------------------------------------------------------------|
| Provider          | `providers` table (id, name, base_url, protocol, enabled, capacity)    |
| Model (logical)   | `models` table (model_id = logical identity; one row per logical model)|
| Capability        | `models.ai_capabilities` JSONB (registry ON the logical model row)     |
| Parameter schema  | `models.ai_parameter_schemas` JSONB (+ `capability_version`)           |
| Binding (route)   | `provider_model_bindings` table (logical model × provider line)        |
| Credential        | `api_keys` table — single business authority for pool keys             |
| Legacy credential | `providers.api_key` — fallback only (pool empty → legacy key)          |
| Routing policy    | modelhub `routeBindings` (scored admission) + M02 `toRoutingDecision` (audit projection) |
| Pricing           | `provider_model_costs` (cost, per-line) / `model_pricing` + `models.credit_cost` (sell) |
| Health            | `ai_provider_health` snapshot (derived, 5-state; engine lands in M02-D)|

### Why the admin UI could show Key Pool = 0 while Agnes generations still worked

`dispatcher.cjs` credential selection (real code, ~line 649):

```js
const effectiveApiKey = selKey ? selKey.apiKey
                     : (poolExists ? '' : (p.provider.api_key || ''));
```

- Pool membership is synced from `api_keys` (`syncKeyPool`, per request,
  `provider_id` match). If no `api_keys` rows exist for that provider,
  `poolExists = false` and the dispatcher **falls back to `providers.api_key`**
  (the legacy column, which is populated for the Agnes production provider).
- `imageGenerate` has the same fallback:
  `apiKeyOverride (len≥6) ? apiKeyOverride : provider.api_key`.
- So "Key Pool = 0" in the UI is truthful (0 rows in `api_keys`) while
  generation succeeds via the **second credential authority**
  (`providers.api_key`).

Multiple credential authorities: **YES** (pool + legacy column). They are not
conflicting sources for the same key; legacy is a strict fallback. The
M02-A repository exposes both (masked only):
`credential.has_legacy_key` / `credential.masked_legacy_key` per provider, and
the masked `key_pool` from `api_keys`.

No env-var / .env / JSON-config credential source exists in
`server/providers/`, `server/modelhub/`, or the dispatcher (verified by grep):
credentials come only from `api_keys` and `providers.api_key`.

## What M02-A ships

- `server/db/migrations/0010_ai_control_plane_foundation.sql` —
  forward-only, idempotent (IF NOT EXISTS everywhere):
  `models` capability columns, `api_keys` runtime-projection columns
  (rpm/concurrency/cooldown/last_*/health CHECK 5-state),
  `ai_routing_decisions` audit table, `ai_provider_health` snapshot table.
  Does not alter or drop any legacy / Generation-V2 column.
- `server/modules/ai-control/`
  - `domain/capability.cjs` — capability registry (closed enums, built-in
    validator + optional zod), binding can only **narrow** capabilities.
  - `domain/status.cjs` — provider raw status → closed JOB_STATES; unknown
    intermediate → PROCESSING (never fabricates terminal).
  - `domain/keypool.cjs` — masked fingerprint, key metadata projection,
    `redactCredentialFields` (secret never leaves).
  - `domain/health.cjs` — 5-state derived health (DISABLED > UNHEALTHY >
    DEGRADED > HEALTHY > UNKNOWN), pure `deriveHealth(signals)`.
  - `domain/pricing.cjs` — 4-layer boundary (provider cost / platform sell /
    credits / margin); `quoteForUser` strips cost+margin.
  - `domain/routing.cjs` — `toRoutingDecision`: auditable projection of
    modelhub `routeBindings` output (routing_decision_id, selected,
    fallback_candidates, rejected, weights, seed).
  - `domain/binding.cjs` — binding validation + row projection
    (`legacy_fallback` flag).
  - `contracts/adapter.cjs` — adapter contract (9 required methods,
    fail-fast registry). Credential is **injected**, never held by adapters.
  - `adapters/agnes.cjs` — first adapter compatibility proof: reuses the
    certified `buildAgnesVars` / `resolveAgnesEndpoint` from
    `server/providers/video/agnes.cjs` (same input → same wire body),
    injectable transport (tests = fake upstream, zero cost).
  - `repositories/aiControlRepository.cjs` — DB read/write projections;
    secret stripped at the repository boundary.
  - `services/aiControlService.cjs` — API projection boundary
    (admin vs user vs internal); double redaction on key responses.
- `contracts/openapi/moling-v2-ai-control.yaml` + generated
  `src/shared/api/contract/ai-control.d.ts`
  (`npm run contract:generate:ai-control`, openapi-typescript 7.13, 3.1).
- Tests (node:test): `domain/*.test.cjs`, `adapters/agnes.test.cjs`,
  `ai-control.test.cjs` (service/repository/masking),
  `generation-v2-compat.test.cjs` (compat proof vs certified
  `loadDispatchPairs`), `server/db/migration.test.cjs` M17–M19
  (fresh / idempotent / 0009→0010 forward upgrade).

## Security invariants (tested)

1. Full API key never enters: API responses, OpenAPI examples, logs,
   traces, errors, test snapshots. Only `••••last4` + sha256[:12] fingerprint.
2. Provider cost / margin: admin projection only (`quoteForUser` strips).
3. Binding parameters (endpoint / param_template): admin only on detail view.
4. Adapter contract: credential injected at submit/poll time; adapter never
   selects or stores keys.

## M02-A explicitly does NOT do (scope gate)

- No Generation-V2 workflow changes (compat test proves read-side parity).
- No routes wired into the HTTP server yet (service is dependency-injected;
  wiring + admin UI is M02-B).
- No health **engine** (only the model + table; M02-D).
- No credential migration/rotation tooling (M02-B key-pool UI).
