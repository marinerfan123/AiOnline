# STAGING DEPLOYMENT PACKAGE

## Environment
- **Type**: SINGLE_HOST_MULTI_INSTANCE (Docker compose) or DEDICATED_MULTI_HOST
- **OS**: Linux (Ubuntu 22.04+ recommended)
- **Docker**: 24+ with compose plugin
- **Minimum**: 4 CPU / 8 GB RAM / 20 GB disk

## Source
- **Repository**: C:\Users\Administrator\github_ai_online
- **Branch**: feat/commercial-distributed-staging
- **HEAD**: 85d29c0844cc5145e2610d2d201b735bd2d1ef04
- **Certified tag**: baseline/moling-commercial-correctness-certified @ 4e455ee
- **Real staging tag**: baseline/moling-real-staging-ready @ 4e455ee

## Migration chain
0001 -> 0002 -> 0003 -> 0004 -> 0005 (757 lines total SQL)

## Required env vars
| Var | Purpose | Example |
|---|---|---|
| NODE_ENV | production | production |
| PORT | API listen port | 3001 |
| NODE_ID | Unique API node ID | api-01 |
| WORKER_ID | Unique worker ID | staging-worker-01 |
| PG_HOST | PostgreSQL host | localhost |
| PG_PORT | PostgreSQL port | 5432 |
| PG_DATABASE | DB name | huabu_staging |
| PG_USER | DB user | postgres |
| PG_PASSWORD | DB password | staging-secret |
| PG_POOL_MAX | Connection pool size | 10 |
| PG_SSLMODE | TLS mode | disable (staging) / prefer (prod) |
| REDIS_HOST | Redis host | localhost |
| REDIS_PORT | Redis port | 6379 |
| JWT_SECRET | Session signing key | long-random-string |
| API_TOKEN | Internal service auth | staging-token |
| CORS_ORIGIN | Allowed origin | http://localhost:8080 |
| GENERATION_V2_WORKER_ENABLED | Enable worker | true |
| GENERATION_V2_EVIDENCE_FILE | Evidence path | /run/generation-v2/evidence.json |
| V2_GENERATION_CONCURRENCY | Per-worker concurrency | 10 |
| V2_UPLOAD_CONCURRENCY | Upload concurrency | 4 |

## Required ports
| Port | Service |
|---|---|
| 8080 | Nginx LB |
| 3001 | API-01 |
| 3002 | API-02 |
| 5432 | PostgreSQL |
| 6379 | Redis |

## Rollback version
- Previous HEAD before integration: 0970fa1570d6b7a9a59ab8896e311d988131c5b7
- Rollback worktree: C:\Users\Administrator\github_ai_online-p0-fix @ a788676

## Pre-staging blockers
- DEDICATED_STAGING_HOST_REQUIRED: No confirmed dedicated Linux staging host available
- 47.77.218.212: Not confirmed as dedicated non-production staging
- 8.148.68.47: PRODUCTION — NO TOUCH
- Windows Docker Desktop: Port conflicts with test infra, PG auth issues in containerized migration runner
