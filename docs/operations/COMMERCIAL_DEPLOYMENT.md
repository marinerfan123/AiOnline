# COMMERCIAL DEPLOYMENT

Moling AI — Commercial Multi-Node Deployment Runbook

## Pre-Deployment Checklist

- [ ] Managed PostgreSQL HA provisioned (Primary + Replica)
- [ ] Managed Redis HA provisioned (Cluster/Sentinel)
- [ ] OSS/COS bucket created
- [ ] Secrets configured (JWT_SECRET, API_TOKEN, PG_PASSWORD, REDIS_PASSWORD, PAYMENT_MASTER_KEY)
- [ ] DNS + CDN/WAF configured
- [ ] Load Balancer configured with health checks
- [ ] Backup/encryption configured
- [ ] PITR enabled on managed PostgreSQL
- [ ] Logs/smetrics pipeline configured
- [ ] NODE_ID assigned per node
- [ ] WORKER_ID assigned per worker

## Shared Secrets (Critical)

All API nodes MUST share:
- `JWT_SECRET` — HMAC-SHA256 signing key
- `API_TOKEN` — System API authentication token
- `PAYMENT_MASTER_KEY` — AES-256-GCM encryption for payment provider keys

All nodes MUST share:
- `PG_*` connection parameters
- `REDIS_*` connection parameters

Recommended distribution: cloud secret manager (AWS Secrets Manager, Aliyun KMS, HashiCorp Vault).
NEVER copy plaintext .env between machines.

## API Node Deployment

```bash
# Environment (per node, same JWT_SECRET + API_TOKEN)
export NODE_ENV=production
export NODE_ID=api-01              # unique per node
export PORT=3001
export ENABLE_CLUSTER=false        # orchestrator manages instances, not Node cluster
export JWT_SECRET=<SHARED_SECRET>
export API_TOKEN=<SHARED_TOKEN>
export PG_HOST=<managed-pg-host>
export PG_PORT=5432
export PG_DATABASE=huabu
export PG_USER=<pg-user>
export PG_PASSWORD=<pg-password>
export PG_SSLMODE=require
export PG_POOL_MAX=20
export REDIS_HOST=<managed-redis-host>
export REDIS_PORT=6379
export REDIS_PASSWORD=<redis-password>
export CORS_ORIGIN=https://yourdomain.com
export PAYMENT_MASTER_KEY=<SHARED_KEY>

# Start
node server/server.js
```

### Container (Docker)

```bash
docker run -d \
  --name moling-api-01 \
  -e NODE_ENV=production \
  -e NODE_ID=api-01 \
  -e ENABLE_CLUSTER=false \
  -e JWT_SECRET=$JWT_SECRET \
  -e API_TOKEN=$API_TOKEN \
  -e PG_HOST=$PG_HOST \
  -e PG_PORT=$PG_PORT \
  -e PG_DATABASE=$PG_DATABASE \
  -e PG_USER=$PG_USER \
  -e PG_PASSWORD=$PG_PASSWORD \
  -e PG_SSLMODE=require \
  -e PG_POOL_MAX=20 \
  -e REDIS_HOST=$REDIS_HOST \
  -e REDIS_PORT=$REDIS_PORT \
  -e REDIS_PASSWORD=$REDIS_PASSWORD \
  -p 3001:3001 \
  moling-ai:latest
```

### Health Checks

- Liveness: `GET http://node:3001/api/healthz` → 200 when process alive
- Readiness: `GET http://node:3001/api/readiness` → 200 when PG + Redis ready, 503 otherwise
- Configure LB to route only to ready instances

## Worker Node Deployment

```bash
# Environment (per worker, unique WORKER_ID)
export NODE_ENV=production
export WORKER_ID=worker-01          # unique per worker
export PG_HOST=<managed-pg-host>
export PG_PORT=5432
export PG_DATABASE=huabu
export PG_USER=<pg-user>
export PG_PASSWORD=<pg-password>
export PG_SSLMODE=require
export V2_PG_POOL_MAX=10
export REDIS_HOST=<managed-redis-host>
export REDIS_PORT=6379
export REDIS_PASSWORD=<redis-password>
export GENERATION_V2_WORKER_ENABLED=true
export V2_GENERATION_CONCURRENCY=10
export V2_UPLOAD_CONCURRENCY=4

# Start
node server/modules/generation-v2/entry.cjs
```

## Migration Deployment (Commercial)

NEVER let every API node run migrations independently.

```bash
# 1. Backup before migration
node scripts/backup-db.cjs --host $PG_HOST --user $PG_USER --password $PG_PASSWORD --db $PG_DATABASE --format pg_dump

# 2. Run migration from ONE node (advisory lock prevents concurrent runs)
node server/db/migrate.cjs --host $PG_HOST --user $PG_USER --password $PG_PASSWORD --db $PG_DATABASE

# 3. Verify schema
# Check migration status via schema_migrations table

# 4. Rolling rollout (old + new code coexist during rollout)
# Deploy new code to API-01, verify readiness, deploy API-02, etc.
```

Migration safety:
- `pg_try_advisory_xact_lock` prevents concurrent migrations
- Fail-closed for production database names
- Transactional migrations

## Rolling Restart (Zero Downtime)

### API Rolling Restart

```bash
# Remove API-01 from LB (or wait for readiness check to fail)
kubectl delete pod moling-api-01   # K8s example
# or: docker stop moling-api-01    # Docker

# Deploy new image to API-01
kubectl apply -f moling-api-01.yaml
# or: docker run -d --name moling-api-01 ...

# Verify API-01 readiness
curl http://api-01:3001/api/readiness

# Repeat for API-02
```

### Worker Rolling Restart

```bash
# Workers can be killed safely — lease recovery handles in-flight jobs
docker stop moling-worker-01
docker run -d --name moling-worker-01 ...

# Reclaimed jobs are automatically picked up by remaining workers
```

## Load Balancer Configuration

```nginx
upstream api_backend {
    server api-01:3001;
    server api-02:3001;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    # SSL termination
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE: no buffering, long timeout
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

## Database Connection Capacity Model

```
Total PG connections = (API_count × PG_POOL_MAX) + (Worker_count × V2_PG_POOL_MAX) + migration_reserve

Example: 2 API × 20 + 2 Worker × 10 + 10 reserve = 60 connections
Managed PG default: 100-200 connections (check provider)

If approaching limit: reduce pool size or use PgBouncer (transaction mode)
```

## Failure Recovery

| Failure | Behavior | Recovery |
|---------|----------|----------|
| One API dies | LB routes to remaining API | Restart/deploy replacement |
| All API restart | Brief 503s during rollout | Rolling restart |
| One Worker dies | Reaper recovers expired leases | Restart worker |
| All Workers restart | Jobs recovered via lease expiry | Restart workers |
| Redis failure | Rate limits → per-process; SSE → local; cache miss | Redis reconnects automatically |
| PG failover | Brief disconnect → reconnect | Managed auto-failover; app reconnects |
| OSS timeout | Provider URL used as fallback | Retry or manual upload |
| Provider timeout | Lease expiry → retry/reconcile | Reconciler handles |
