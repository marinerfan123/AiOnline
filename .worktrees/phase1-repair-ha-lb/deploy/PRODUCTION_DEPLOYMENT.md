# Production Deployment Runbook

## HA Architecture

```
Internet
   |
Cloud LB/WAF (Aliyun SLB/Tengxun CLB)
   |
+--------+--------+--------+
| API-01 | API-02 | API-03 | (stateless, round-robin)
+--------+--------+--------+
   |        |        |
   +--------+--------+
            |
   +--------+--------+
   |   Shared PG     |  Managed PostgreSQL HA
   |   Shared Redis  |  Managed Redis Sentinel/Cluster
   +-----------------+
            |
   +--------+--------+
   | Worker-01 | Worker-02 | (lease-based, stateless)
   +---------------------+
            |
         AI Providers
```

## Deployment Phases

### Phase 1: API Nodes First
```bash
# Start API replicas (workers OFF)
docker compose -f deploy/docker-compose.production.yml up -d api-01 api-02
# Optional: Add api-03 for scaling

# Verify readiness
for node in api-01 api-02 api-03; do
  docker exec $node curl -sf http://localhost:3001/api/readiness && echo " OK"
done

# Cutover: Update cloud LB to point to 18001/18002/18003
# Verify traffic flows
curl -s https://yourdomain.com/api/healthz
```

### Phase 2: Worker Nodes
```bash
# Start workers after API is verified
docker compose -f deploy/docker-compose.production.yml up -d worker-01 worker-02

# Verify worker heartbeats in PostgreSQL
psql -h <pg-host> -U moling -d huabu -c \
  "SELECT worker_id, last_heartbeat FROM generation_worker_heartbeats_v2 ORDER BY last_heartbeat DESC LIMIT 10;"
```

## Scaling Procedures

### Add API Node
```bash
# 1. Update nginx-production.conf: add server api-0N:3001
# 2. Start new API container
docker compose -f deploy/docker-compose.production.yml up -d api-0N

# 3. Verify healthcheck passes
docker inspect --format='{{.State.Health.Status}}' moling-v1-api-0N

# 4. Verify LB routes to new node
curl -s http://localhost/api/healthz | jq '.node_id'
```

### Scale Workers
```bash
# Workers are stateless, add as needed
docker compose -f deploy/docker-compose.production.yml up -d worker-03

# Each worker auto-joins lease pool via PostgreSQL
```

### Graceful Shutdown (Rolling Update)
```bash
# 1. Remove node from LB (or wait for readiness to fail)
# 2. Stop container
docker stop moling-v1-api-0N

# 3. Start replacement
docker compose -f deploy/docker-compose.production.yml up -d api-0N

# 4. Verify readiness before routing traffic back
docker exec moling-v1-api-0N curl -sf http://localhost:3001/api/readiness
```

## Rollback Procedure

```bash
# Stop new stack
docker compose -f deploy/docker-compose.production.yml down

# Restart old stack
docker compose -f deploy/docker-compose.yml up -d

# Verify old stack is serving traffic
curl -s https://yourdomain.com/api/healthz
```

## Health Check Endpoints

| Endpoint | Purpose | Expected Response |
|----------|---------|-------------------|
| `/lb/health` | LB internal check | 200 'ok' |
| `/api/healthz` | Liveness probe | 200 + node status |
| `/api/readiness` | Readiness probe | 200 (PG+Redis ok) or 503 |

## Resource Requirements

| Component | Min CPU | Min Memory | Max Connections |
|-----------|---------|------------|-----------------|
| API Node | 0.5 | 256M | 20 PG pools |
| Worker Node | 1.0 | 512M | 10 PG pools |
| Nginx LB | 0.25 | 64M | - |
| **Total (2 API + 2 Worker + LB)** | **3.25** | **1.6G** | **~60 PG** |

## Connection Capacity Planning

```
Total PG connections = (API_count × 20) + (Worker_count × 10) + reserve
Example: 2 API × 20 + 2 Worker × 10 + 20 reserve = 80 connections
Managed PG default: 100-200 connections
```

## Security Checklist

- [ ] JWT_SECRET shared across all API nodes via secret manager
- [ ] API_TOKEN shared across all API nodes
- [ ] PG_SSLMODE=require for production
- [ ] HTTPS enabled (TLS 1.2+ only)
- [ ] CORS_ORIGIN restricted to known domains
- [ ] Rate limiting enabled on auth endpoints
- [ ] Secrets never committed to repository
