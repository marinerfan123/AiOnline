# CHECKPOINT — Moling Commercial v1 (LIVE)

Last updated: 2026-08-27 08:40 UTC (cutover completed, observation window running)

## Status

| Item | State |
|---|---|
| Certified RC | fd35af24 (tag `rc/moling-commercial-v1-certified`, unchanged) |
| Final release | 1515c054 (tag `release/moling-commercial-v1`, MOVED from aaacdac) |
| Production | LIVE on commercial v1 at 8.148.68.47 (tv.moling.fun) |
| Old app (moling-app-1) | STOPPED, preserved for rollback |
| P0 defects | 0 (payment_settings + api_keys label fixed via 0007/0008/0009) |
| P1 defects | 0 |

## Release commits (post-RC)

- aaacdac fix(db): move legacy runtime DDL into versioned migrations 0007+0008
- 1515c05 fix(db): 0009 align api_keys with certified key-pool runtime schema
  + deploy/docker-compose.v1.yml parallel-stack compose

## Migration chain (now 9)

0001 baseline_legacy_schema → 0002 generation_v2_schema → 0003
generation_v2_runtime_schema_parity → 0004 billing_transactional_integrity →
0005 legacy_image_client_request_id → 0006 create_api_keys_table →
0007 recharge_payment_tables → 0008 legacy_runtime_tables →
0009 api_keys_pool_parity

## Production cutover record (2026-08-27)

Host: 8.148.68.47 (2 CPU / 1.8 GB RAM / 40 GB disk)
Backup: /opt/moling-backups/pre-commercial-v1-20260827-041433/ (pg_dump -Fc 352K,
sha256 e81efe9c..., .env 600, nginx confs, containers.json, ROLLBACK.md)

Pre-migration recon (one-time, NOT a numbered migration):
- 8 divergent tables renamed to *_pre_v1 (old inline-DDL schema differed from
  migration chain): generation_{items,batches,credit_holds,item_attempts,
  outbox,worker_heartbeats}_v2, agent_calls, api_keys
  (held only orphaned shadow-worker rows: 5 queued V2 items, 0 completed)
- 2 legacy credit_transactions rows: ref 'signup-bonus' → 'signup-bonus:<user_id>'
  (unblocks 0004 unique index; balances untouched)
- Recon SQL saved in backup dir as migration_recon.sql

Migration: 0001→0009 applied to prod huabu as user moling, exit 0.
Validated first on a faithful pg_restore replica of prod (0001-0008), then
0009 after key-pool P0 found in new-stack startup logs.

New stack (compose /opt/moling-v1/docker-compose.v1.yml, image moling-app-v1:rc
sha 19c63d4c): moling-v1-api-01 :18001, moling-v1-api-02 :18002,
moling-v1-worker-01/02 (entry.cjs, evidence-gated, no skip). Reuses existing
prod postgres+redis via external moling_default network. Old app container
kept (stopped) on :3001.

Cutover sequence: API first (workers off) → readiness 200×2 → pre-cutover
smoke (1 real Agnes gen, done in 10s, provider_url persisted, billing 0 by
model config) → nginx upstream tv.moling.fun → 18001/18002 (nginx -t OK,
graceful reload) → old app docker stop → workers up → heartbeats in PG →
post-cutover smoke (public domain, gen done 10s) → SSE /api/generate/stream
verified → 30min observation.

Rollback (see backup ROLLBACK.md): restore nginx conf from backup, nginx -t +
reload, start old stack (docker start moling-app-1 — old code has NO
schema_migrations hard-exit and its DDL is all IF NOT EXISTS, so it boots
against the migrated DB). DB migrations NOT reversed (forward-only).

## Known non-blockers

- Legacy generation_tasks: 526 failed / 304 done (old zombie tasks, pre-release)
- Old app log noise (waiting-area retries) — irrelevant, stack stopped
- Host has no system node (containers only) — use docker exec / python3
- pg_restore of -Fc dumps requires pg_restore (not psql pipe); role ownership
  matters (migrate as moling, the DB owner)

## UAT note for user

Production URL is now the final UAT environment: https://tv.moling.fun
Admin: existing account (admin seed from .env) — sessions survive cutover
(same JWT_SECRET). No auto-created admin.
