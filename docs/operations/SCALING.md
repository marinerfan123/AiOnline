# SCALING

Moling AI — Horizontal Scaling Guide

## Scaling Model

All scaling is horizontal — add nodes, don't upgrade single machines.

| Layer | Scale Method | Config |
|-------|-------------|--------|
| API | Add containers/VMs | Orchestrator (K8s/Docker Swarm) |
| Worker | Add containers/VMs | Orchestrator + unique WORKER_ID |
| PostgreSQL | Provider-managed scaling | Increase instance class, add replicas |
| Redis | Provider-managed scaling | Cluster mode for horizontal |
| OSS/COS | Automatic | No config needed |
| LB | Provider-managed | Auto-scales with backend count |

## API Scaling

API nodes are stateless and disposable. Scale by adding identical instances.

```bash
# Scale from 2 to 4 API nodes
NODE_ID=api-03  # unique per node
NODE_ID=api-04

# All share same JWT_SECRET and API_TOKEN
# All connect to same PG and Redis
# LB distributes across all 4
```

### When to scale API

- p95 latency > 200ms
- Error rate > 0.1%
- CPU > 70% sustained
- Connection queue growing

### PG pool sizing per API

```
PG_POOL_MAX = min(20, available_pg_connections / api_node_count)

Example: 200 available / 4 nodes = 50 per node (cap at 20 to leave headroom)
```

## Worker Scaling

Workers compete for work via `FOR UPDATE SKIP LOCKED`. Adding workers automatically distributes load.

```bash
# Scale from 2 to 10 workers
WORKER_ID=worker-01  # unique per worker
WORKER_ID=worker-02
...
WORKER_ID=worker-10

# Each worker runs the same V2 runtime
# PG is the queue — no coordination needed
```

### When to scale workers

- Queue depth growing (check `generation_items_v2` status=queued count)
- Oldest queued item > 30 seconds
- Provider concurrency has headroom
- Worker CPU < 50%

### Worker concurrency tuning

| Env Var | Default | Range | Description |
|---------|---------|-------|-------------|
| V2_GENERATION_CONCURRENCY | 10 | 1-50 | Items processed per tick |
| V2_UPLOAD_CONCURRENCY | 4 | 1-20 | Upload items per tick |
| V2_TICK_MS | 1000 | 500-5000 | Milliseconds between ticks |

## PostgreSQL Scaling

### Phase 1 (2-4 nodes)
Single managed instance, 100-200 connections. No PgBouncer needed.

### Phase 2 (4-8 nodes)
Add read replica for reporting/observability queries. PgBouncer in transaction mode.

### Phase 3 (8+ nodes)
PgBouncer required. Consider connection pooling optimization.

```
With PgBouncer:
  PG_HOST=pgbouncer
  PG_PORT=6432
  PG_POOL_MAX=20  (PgBouncer pools globally)
```

## Redis Scaling

### Phase 1
Single managed Redis instance. Adequate for 2-4 API + 2-4 workers.

### Phase 2
Redis Sentinel for HA. Automatic failover.

### Phase 3
Redis Cluster for horizontal scaling. Shard-aware client.

## Backpressure

Generation backpressure prevents overloading providers:

1. User credits (hard limit)
2. User rate limit (Redis-based, per-user)
3. Queue depth monitoring
4. Worker capacity (concurrency settings)
5. Provider concurrency limits (per-account)
6. Provider circuit breaker

No unlimited in-memory queues — everything flows through PostgreSQL.

## Growth Profiles

### Profile 1: Startup (100 users)
- 2 API, 2 Workers, 1 PG, 1 Redis
- PG_POOL_MAX: 10, V2_PG_POOL_MAX: 10
- Total PG connections: ~60

### Profile 2: Growth (1000 users)
- 4 API, 4 Workers, 1 PG + 1 Replica, Redis Sentinel
- PG_POOL_MAX: 15, V2_PG_POOL_MAX: 10
- Total PG connections: ~140

### Profile 3: Scale (5000 users)
- 8 API, 10 Workers, Managed PG HA, Redis Cluster, PgBouncer
- PG_POOL_MAX: 20, V2_PG_POOL_MAX: 15
- PgBouncer handles pooling

### Profile 4: Large (10000+ users)
- 16 API, 20+ Workers, Aurora/RDS Multi-AZ, Redis Cluster
- Auto-scaling groups for API and Worker
- Dedicated migration runner
