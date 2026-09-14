# COMMERCIAL PRODUCTION ARCHITECTURE

Moling AI — Commercial Multi-Node Horizontal-Scale Architecture

## Target Topology

```
  Internet
     |
  CDN / WAF / Cloud LB
     |
  +--------+--------+
  | API-01 | API-02 |  ... API-N  (stateless, horizontally scalable)
  +--------+--------+
     |            |
     +----+-------+
          |
  +-------+-------+
  |   Shared PG   |  Managed PostgreSQL HA (Primary + Replica + Failover)
  |   Shared Redis|  Managed Redis HA (Cluster/Sentinel)
  |   OSS / COS   |  Object Storage (Aliyun OSS / Tencent COS)
  +-------+-------+
          |
  +-------+-------+
  |  Worker-01    |  ... Worker-N  (generation, upload, reconcile, outbox)
  |  Worker-02    |
  +-------+-------+
          |
     AI Providers
```

## Minimum Commercial Deployment

| Component | Count | Spec |
|-----------|-------|------|
| API nodes | 2 | Stateless Express, PG pool 10-20 each |
| Worker nodes | 2 | V2 runtime, PG pool 10 each |
| PostgreSQL | 1 primary + 1 replica | Managed HA (RDS/Aurora/CloudSQL) |
| Redis | Cluster or Sentinel | Managed HA |
| OSS/COS | 1 bucket | Provider object storage |
| Load Balancer | 1 | Cloud LB or Nginx/HAProxy |
| Logs | Centralized | CloudWatch/Prometheus/ELK |

## Growth Profile

| Scale | API | Worker | PG connections |
|-------|-----|--------|----------------|
| Start | 2 | 2 | ~60 (2×10 + 2×10 + reserve) |
| Growth | 4 | 4 | ~120 |
| Scale | 8 | 10 | ~250 |
| Large | N | 50+ | Pool managed via PgBouncer |

## Component Design

### API Nodes (Stateless, Disposable)

- Pure HTTP layer — no process-local state for correctness
- Authentication via HMAC-SHA256 JWT (shared `JWT_SECRET` env)
- API_TOKEN from env (shared across all nodes)
- Generation intake → PostgreSQL (idempotency key + `pg_advisory_xact_lock`)
- SSE events received via Redis pub/sub → local SSE clients
- `/api/healthz` — liveness probe (process alive)
- `/api/readiness` — readiness probe (PG + Redis available)
- Graceful shutdown: SIGTERM → stop accepting → drain in-flight → close pools → exit
- `NODE_ID` env for log identification

### Worker Nodes (Independent, Lease-Based)

- V2 runtime: generation, upload, reconcile, outbox, reaper ticks
- Job claiming: `FOR UPDATE SKIP LOCKED` + `lease_version` CAS
- Worker identity: `WORKER_ID` env (required for multi-node)
- Heartbeat: `generation_worker_heartbeats_v2` table (per worker_id)
- No local queues — all state in PostgreSQL
- Graceful shutdown: SIGTERM → drain current tick → exit (reaper recovers)

### PostgreSQL (Authoritative State)

Source of truth for:
- Generation state (`generation_items_v2`, `generation_batches_v2`)
- Billing (`users`, `credit_transactions`, `generation_credit_holds_v2`)
- Payment (`recharge_orders`, `webhook_events`)
- Outbox (`generation_outbox_v2`)
- Worker heartbeat (`generation_worker_heartbeats_v2`)
- Config (`settings`, `oss_config`, `providers`, `models`)

Connection model:
- `PG_POOL_MAX` per node (default 10)
- `PG_SSLMODE` env (require/verify-ca/verify-full for managed PG)
- `PG_CONN_TIMEOUT_MS` env (default 5000)
- `PG_IDLE_TIMEOUT_MS` env (default 30000)
- Managed HA with automatic failover
- Application tolerates transient disconnect → reconnect on next query

### Redis (Cache + Coordination)

Used for:
- RATE_LIMIT: Fixed-window counters (degrades to memory)
- CACHE: General caching (graceful degradation)
- COORDINATION: Redis pub/sub for cross-node SSE events
- KEY_POOL: API key lease tracking

NOT authoritative for:
- Billing (PostgreSQL)
- Generation state (PostgreSQL)
- Provider task recovery (PostgreSQL)

Redis failure impact:
- Rate limits degrade to per-process (observable)
- SSE falls back to local-only (observable)
- Cache misses increase
- Generation continues normally

Connection:
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` env vars
- TLS support via `REDIS_TLS` env (future)
- `ioredis` with retry strategy + memory fallback

### Object Storage (Assets)

- Aliyun OSS / Tencent COS via DB config (`oss_config` table)
- Server-side signed URLs — browser never receives OSS credentials
- Per-user key namespace prevents cross-user overwrite
- Provider base64 data → Worker RAM buffer → OSS PUT → DB metadata
- Buffer is temporary, not durable storage
- OSS disabled → provider URL used directly (safe fallback)

### Load Balancer

- Round-robin across API nodes
- No sticky sessions required
- Liveness: `/api/healthz` (200 = process alive)
- Readiness: `/api/readiness` (200 = PG + Redis available)
- SSE: proxy buffering disabled, long timeout
- Kill any API node → traffic shifts to remaining nodes

### SSE Cross-Node Event Delivery

Architecture:
1. Worker completes generation → writes to `generation_outbox_v2`
2. Outbox tick (any worker) picks up events via `FOR UPDATE SKIP LOCKED`
3. Publishes via `realtime.emitTaskUpdate(userId, payload)`
4. Redis pub/sub to channel `task-updates:{userId}`
5. All API nodes subscribe via `psubscribe task-updates:*`
6. SSE clients connected to any API node receive the event

No second source of truth — outbox in PostgreSQL is the durable authority.

## Environment Variables

| Variable | API | Worker | Description |
|----------|-----|--------|-------------|
| NODE_ID | yes | no | Node identifier for logs |
| NODE_ENV | yes | yes | production/development |
| PORT | yes | no | HTTP port (3001) |
| JWT_SECRET | yes | no | HMAC-SHA256 signing key (SHARED) |
| API_TOKEN | yes | no | System API token (SHARED) |
| PG_HOST | yes | yes | PostgreSQL hostname |
| PG_PORT | yes | yes | PostgreSQL port |
| PG_DATABASE | yes | yes | Database name |
| PG_USER | yes | yes | Database user |
| PG_PASSWORD | yes | yes | Database password |
| PG_POOL_MAX | yes | no | PG pool size per API node |
| PG_SSLMODE | yes | yes | SSL mode (prefer/require/verify-full) |
| PG_CONN_TIMEOUT_MS | yes | yes | Connection timeout |
| PG_IDLE_TIMEOUT_MS | yes | yes | Idle timeout |
| REDIS_HOST | yes | yes | Redis hostname |
| REDIS_PORT | yes | yes | Redis port |
| REDIS_PASSWORD | yes | yes | Redis password |
| CORS_ORIGIN | yes | no | Allowed CORS origin |
| WORKER_ID | no | yes | Worker identifier (unique per node) |
| V2_PG_POOL_MAX | no | yes | PG pool size per worker |
| V2_GENERATION_CONCURRENCY | no | yes | Items processed per tick |
| V2_UPLOAD_CONCURRENCY | no | yes | Upload items per tick |
| V2_TICK_MS | no | yes | Tick interval in ms |
| GENERATION_V2_WORKER_ENABLED | no | yes | Enable V2 worker |
| ENABLE_CLUSTER | yes | no | Node cluster mode (false for multi-host) |

## Security

- JWT_SECRET shared via secret manager (Vault/AWS Secrets Manager)
- API_TOKEN shared via env
- PG credentials via env / secret manager
- OSS credentials in DB (encrypted at rest via `crypto.cjs` AES-256-GCM)
- Payment keys encrypted via `PAYMENT_MASTER_KEY`
- CORS configured via `CORS_ORIGIN`
- SSRF protection via `ssrf.cjs`
- SameSite=Strict cookies
- No plaintext secrets in codebase

## Disaster Recovery

- pg_dump -Fc backups (encrypted at rest via provider)
- pg_restore for recovery
- PITR via managed provider WAL archiving
- Application logical DR via `scripts/backup-db.cjs` + `restore-db.cjs`
- Migration rollback via verified backup restore (human-approved)
