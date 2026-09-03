# Phase 2 Plan D — Observability and SRE

**Task**: t_3ae01220  
**Status**: PRE-PLANNING (READ_ONLY)  
**Date**: 2026-08-30  
**Repository**: C:\Users\Administrator\github_ai_online  

---

## 1. CURRENT_STATE

### 1.1 Existing Observability Modules

| Module | Path | Purpose | SSE Endpoint | Storage |
|--------|------|---------|--------------|---------|
| monitor.cjs | `server/monitor.cjs` | HTTP request ring buffer (500 recs), QPS/success/P95 metrics | `/api/admin/monitor/stream` | In-memory only |
| logbus.cjs | `server/logbus.cjs` | System events (console.warn/error, PG/Redis), ERROR→syslog persist | `/api/admin/logs/stream` | In-memory + DB (ERROR only) |
| syslog.cjs | `server/syslog.cjs` | Persistent error logging to `system_error_logs` table | `/api/admin/errors` (REST) | PostgreSQL |
| oss-logger.cjs | `server/oss-logger.cjs` | OSS operation logger with sanitization | `/api/oss/logs/stream` | In-memory only |
| realtime.cjs | `server/realtime.cjs` | Generation task SSE (per-user, Redis pub/sub) | `/api/generate/stream` | PG (task status) |
| cpuMonitor.cjs | `server/cpuMonitor.cjs` | CPU adaptive load degradation | None (internal) | In-memory |
| health.cjs | `server/modules/ai-control/domain/health.cjs` | Provider health state derivation (5 states) | None (internal) | None |

### 1.2 Health Endpoints

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /api/healthz` | Liveness probe | 200 with uptime, process info |
| `GET /api/readiness` | Readiness probe | 200/503 based on PG+Redis status |

### 1.3 Admin Console (SSE)

- **Endpoint**: `GET /api/admin/console/stream`
- **Events**: metrics, traffic, flow, log, agent (5 types, 1s interval)
- **UI**: `src/pages/Admin/ConsolePage.tsx` — 6 KPIs, QPS chart, flow scroll, agent stats, alerts tab
- **Alerts**: Client-side threshold checks only (QPS>800, success<95%, latency>1s, etc.)

### 1.4 Error Logging Pipeline

```
console.error/warn → logbus.emit('ERROR') → syslog.insertError() → system_error_logs table
                                                                    ↓
                                                          /api/admin/errors (REST)
                                                          ErrorLogsPage.tsx (UI)
```

### 1.5 Provider Health

- 5-state model: DISABLED > UNHEALTHY > DEGRADED > HEALTHY > UNKNOWN
- Signals: circuit breaker, connectivity, success rate, p95 latency, rate limited, key availability
- Used by: AI control plane routing decisions

### 1.6 Test Coverage

- `server/tests/integration/all.test.cjs` — healthz returns 200
- `server/modules/ai-control/domain/health.test.cjs` — deriveHealth pure function tests
- No observability-specific integration tests exist

---

## 2. GAPS

### 2.1 Critical Gaps (P0)

| Gap | Impact | Current State |
|-----|--------|---------------|
| **No external metrics export** | Cannot integrate with Prometheus/Grafana, no external monitoring | No /metrics endpoint, no standard metric format |
| **No alert delivery** | Alerts only client-side visible to admin on console page; no webhook/pagerduty/email | ConsolePage.tsx has threshold checks but no server-side notification |
| **No request correlation/tracing** | Cannot trace a request across dispatcher→provider→callback; debugging distributed failures is blind | No trace IDs, no request correlation |
| **No log retention/shipping** | In-memory ring buffers lost on restart; logs not shipped to external SIEM | monitor.cjs/logbus.cjs are volatile; no log aggregator integration |

### 2.2 Significant Gaps (P1)

| Gap | Impact | Current State |
|-----|--------|---------------|
| **No capacity planning data** | Cannot forecast growth, plan scaling | No historical trends beyond ring buffers |
| **No audit log export** | Compliance/forensics requires log export | audit_logs table exists but no export API |
| **No synthetic monitoring** | No external uptime checks, cannot detect regional outages | healthz is internal-only |
| **No error budget tracking** | Cannot measure SLO compliance over time | No error budget concept |
| **No structured metric dimensions** | Hard to query by user/model/provider | All metrics are aggregated totals |

### 2.3 Nice-to-Have (P2)

- Distributed tracing with OpenTelemetry
- Log aggregation across multi-node deployment
- Automated runbook suggestions for common errors
- Cost attribution dashboard (already partial in ConsolePage)

---

## 3. PARALLEL_DAG

```
                    ┌─────────────────┐
                    │  Phase 2 Plan D │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ Branch A:   │  │ Branch B:   │  │ Branch C:   │
    │ Metrics     │  │ Tracing     │  │ Alerts      │
    │ Export      │  │ IDs         │  │ Engine      │
    └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
           │                │                │
           │                │                │
           ▼                ▼                ▼
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ Branch D:   │  │ Branch E:   │  │ Branch F:   │
    │ Log Shipping│  │ Audit Export│  │ Synthetic   │
    │             │  │             │  │ Monitoring  │
    └─────────────┘  └─────────────┘  └─────────────┘
```

### Branch Descriptions

**Branch A: Metrics Export (server/metrics.cjs)**
- New file: Prometheus-compatible `/api/metrics` endpoint
- Exports counters (requests, errors, generations), gauges (online users, queue depth), histograms (latency)
- Aggregates from monitor.cjs, logbus.cjs, dispatcher stats
- Fully independent, no dependencies

**Branch B: Trace IDs (server/tracing.cjs + server.js middleware)**
- New file: Trace ID generation and propagation
- Adds `X-Trace-ID` header to all requests
- Correlates dispatcher→provider→callback lifecycle
- Modifies dispatcher.cjs to attach trace ID to task metadata
- Depends on: server.js request middleware hook

**Branch C: Alerts Engine (server/alerts.cjs)**
- New file: Server-side alert evaluation
- Watches monitor.cjs metrics + logbus.cjs errors
- Supports webhook delivery (Discord/Slack/Telegram)
- Configurable thresholds, cooldown periods
- Depends on: Branch A (metrics) or direct monitor.cjs integration

**Branch D: Log Shipping (server/log-shipper.cjs)**
- New file: External log aggregation
- Buffers logbus.cjs events and ships to HTTP endpoint
- Retry logic, batching, backpressure handling
- Configurable via env vars (LOG_SHIPPER_URL, LOG_SHIPPER_INTERVAL)
- Depends on: logbus.cjs modification for hook injection

**Branch E: Audit Export (server/admin.cjs + src/services/api.ts)**
- Modify existing: Add GET /api/admin/audit/export endpoint
- CSV/JSON export of audit_logs and credit_transactions
- Server-side pagination for large exports
- Depends on: admin.cjs modification only

**Branch F: Synthetic Monitoring (scripts/synthetic-monitor.cjs)**
- New file: External health check script
- Polls /api/healthz and /api/readiness from external URL
- Reports to webhook on failure
- Can be run by CI/CD or external monitor
- No dependencies

---

## 4. FILE/BRANCH_BOUNDARIES

### Worktree Allocation

| Worktree | Branch | Owner | Files |
|----------|--------|-------|-------|
| `t_metrics_export` | `feat/observability-metrics` | Worker A | `server/metrics.cjs` (new), `server/server.js` (modify route) |
| `t_tracing` | `feat/observability-tracing` | Worker B | `server/tracing.cjs` (new), `server/server.js` (modify middleware), `server/dispatcher.cjs` (modify) |
| `t_alerts` | `feat/observability-alerts` | Worker C | `server/alerts.cjs` (new), `server/monitor.cjs` (modify hook), `server/logbus.cjs` (modify hook) |
| `t_log_shipping` | `feat/observability-log-shipper` | Worker D | `server/log-shipper.cjs` (new), `server/logbus.cjs` (modify hook) |
| `t_audit_export` | `feat/observability-audit-export` | Worker E | `server/admin.cjs` (modify), `src/services/api.ts` (modify), `src/pages/Admin/FinancePage.tsx` (modify) |
| `t_synthetic` | `feat/observability-synthetic` | Worker F | `scripts/synthetic-monitor.cjs` (new) |

### File Modifications (Read-Only for Planning)

**server/server.js** (requires modification)
- Line ~1901: Add `/api/metrics` route after healthz
- Line ~1409: Import metrics module, create instance
- Line ~1422: Inject metrics into admin context

**server/dispatcher.cjs** (requires modification)
- Add trace ID to task metadata on creation
- Propagate trace ID through provider calls

**server/monitor.cjs** (requires modification)
- Export metrics data for external consumption
- Add webhook alert callback support

**server/logbus.cjs** (requires modification)
- Add log shipping callback support

**src/services/api.ts** (requires modification)
- Add audit export API client

**src/pages/Admin/FinancePage.tsx** (requires modification)
- Add export button and modal

---

## 5. TEST/ACCEPTANCE

### 5.1 Metrics Export (Branch A)

**Unit Tests** (`server/tests/metrics.test.cjs`)
- [ ] `/api/metrics` returns 200 with Prometheus format
- [ ] Counter metrics increment correctly
- [ ] Histogram metrics capture latency percentiles
- [ ] Gauge metrics reflect current state

**Integration Tests** (`server/tests/integration/metrics.test.cjs`)
- [ ] Metrics endpoint accessible without auth (public)
- [ ] Metrics include expected labels (method, status, path)
- [ ] Metrics persist across multiple requests

**Acceptance Criteria**
- [ ] Prometheus scrape target configured
- [ ] Grafana dashboard imports successfully
- [ ] Alertmanager can rule on metrics

### 5.2 Trace IDs (Branch B)

**Unit Tests** (`server/tests/tracing.test.cjs`)
- [ ] Trace ID is valid UUID v4
- [ ] Trace ID propagated to response headers
- [ ] Trace ID attached to task metadata

**Integration Tests** (`server/tests/integration/tracing.test.cjs`)
- [ ] Same trace ID flows from request → task → provider call
- [ ] Trace ID visible in system_error_logs meta

**Acceptance Criteria**
- [ ] Jaeger/Zipkin can query traces
- [ ] Trace ID appears in admin error logs

### 5.3 Alerts Engine (Branch C)

**Unit Tests** (`server/tests/alerts.test.cjs`)
- [ ] Alert triggers when threshold exceeded
- [ ] Alert cools down after first trigger
- [ ] Alert clears when condition resolves
- [ ] Webhook delivery succeeds/fails correctly

**Integration Tests** (`server/tests/integration/alerts.test.cjs`)
- [ ] Server-side alert fires on simulated high error rate
- [ ] Webhook receives correct payload

**Acceptance Criteria**
- [ ] Discord/Slack webhook tested end-to-end
- [ ] Alert history stored in DB

### 5.4 Log Shipping (Branch D)

**Unit Tests** (`server/tests/log-shipper.test.cjs`)
- [ ] Batch size configurable
- [ ] Retry on failure with backoff
- [ ] Buffer flush on shutdown

**Integration Tests** (`server/tests/integration/log-shipper.test.cjs`)
- [ ] Logs shipped to mock HTTP endpoint
- [ ] Duplicate logs not sent

**Acceptance Criteria**
- [ ] Log aggregation system receives events
- [ ] No performance degradation under load

### 5.5 Audit Export (Branch E)

**Unit Tests** (`server/tests/admin-audit.test.cjs`)
- [ ] Export returns valid CSV/JSON
- [ ] Export respects date range filters
- [ ] Export handles large datasets (pagination)

**Integration Tests** (`server/tests/integration/audit-export.test.cjs`)
- [ ] GET /api/admin/audit/export returns 200
- [ ] Downloaded file matches DB content

**Acceptance Criteria**
- [ ] Export completes within 30s for 10k records
- [ ] File is valid CSV/JSON

### 5.6 Synthetic Monitoring (Branch F)

**Unit Tests** (`scripts/tests/synthetic-monitor.test.cjs`)
- [ ] Health check passes for healthy endpoint
- [ ] Health check fails for unhealthy endpoint
- [ ] Webhook notification sent on failure

**Acceptance Criteria**
- [ ] Script runs successfully in CI
- [ ] External monitoring tool can invoke script

---

## 6. DEPENDENCIES

```
Branch A (Metrics) ──────────────────────────────────────────────┐
                                                                  │
Branch B (Tracing) ──────────► server.js (route + middleware) ───┼──► Branch C (Alerts)
                                                                  │     (needs metrics)
Branch C (Alerts) ────────────────────────────────────────────────┤
                                                                  │
Branch D (Log Shipping) ──────────► logbus.cjs (hook) ────────────┘
                                                                  │
Branch E (Audit Export) ──────────► admin.cjs (route)             │
                                                                  │
Branch F (Synthetic) ─────────────────────────────────────────────┘
```

**Key Dependencies:**
- Branch A → None (independent)
- Branch B → server.js (middleware hook)
- Branch C → Branch A (metrics data) or direct monitor.cjs integration
- Branch D → logbus.cjs (hook injection)
- Branch E → admin.cjs (route addition)
- Branch F → None (independent)

**Shared Dependencies:**
- server.js: Modified by Branch A (metrics route) and Branch B (tracing middleware)
- logbus.cjs: Modified by Branch D (log shipping hook)

---

## 7. CRITICAL_PATH

```
Week 1: Branch A (Metrics Export) — 3 days
  Day 1-2: Implement server/metrics.cjs
  Day 3: Tests + integration

Week 1-2: Branch B (Tracing IDs) — 4 days
  Day 1: Implement server/tracing.cjs
  Day 2-3: Modify dispatcher.cjs, server.js
  Day 4: Tests + integration

Week 2: Branch C (Alerts Engine) — 3 days
  Day 1-2: Implement server/alerts.cjs
  Day 3: Tests + webhook integration

Week 2-3: Branch D (Log Shipping) — 3 days
  Day 1: Implement server/log-shipper.cjs
  Day 2: Modify logbus.cjs
  Day 3: Tests + integration

Week 3: Branch E (Audit Export) — 2 days
  Day 1: Modify admin.cjs, src/services/api.ts
  Day 2: Tests + UI modification

Week 3: Branch F (Synthetic Monitoring) — 2 days
  Day 1: Implement scripts/synthetic-monitor.cjs
  Day 2: Tests
```

**Critical Path Duration**: 3 weeks (sequential execution)  
**With Parallelism**: 1.5 weeks (Branch A+F in parallel, then B+C, then D+E)

---

## 8. ESTIMATED_SAFE_PARALLELISM

### Safe Parallel Execution

| Wave | Branches | Rationale |
|------|----------|-----------|
| Wave 1 | A, F | No shared dependencies, fully independent |
| Wave 2 | B, C | Branch C depends on A (metrics), B independent |
| Wave 3 | D, E | D depends on logbus, E depends on admin — no conflict |

### Worktree Isolation

Each branch gets dedicated worktree:
- `git worktree add .worktrees/t_metrics_export feat/observability-metrics`
- `git worktree add .worktrees/t_tracing feat/observability-tracing`
- `git worktree add .worktrees/t_alerts feat/observability-alerts`
- `git worktree add .worktrees/t_log_shipping feat/observability-log-shipper`
- `git worktree add .worktrees/t_audit_export feat/observability-audit-export`
- `git worktree add .worktrees/t_synthetic feat/observability-synthetic`

### Merge Conflict Risk Assessment

| Pair | Risk | Reason |
|------|------|--------|
| A + F | None | No shared files |
| A + B | Low | Both modify server.js but different sections |
| B + C | Low | C uses A's output, different files |
| D + E | Low | Different files (logbus vs admin) |
| All | Medium | server.js modifications need coordination |

---

## 9. P0/P1 RISKS

### P0 Risks (Block Progress)

| Risk | Mitigation |
|------|------------|
| **server.js modification conflicts** | Coordinate merge order: A first, then B, then others |
| **logbus.cjs hook injection breaks existing behavior** | Use additive pattern: new optional callback, no breaking changes |
| **Tracing overhead impacts latency** | Make tracing opt-in via env var, sample 10% by default |
| **Metrics endpoint becomes bottleneck** | Cache metrics, async export, rate limit scraping |

### P1 Risks (Monitor)

| Risk | Mitigation |
|------|------------|
| **Webhook delivery failures** | Retry with backoff, queue for later delivery |
| **Log shipping buffer overflow** | Drop oldest entries, warn on overflow |
| **Export generates large files** | Server-side pagination, streaming response |
| **Synthetic monitoring false positives** | Require 2/3 consecutive failures before alert |

---

## 10. WHAT_NOT_TO_BUILD

### Out of Scope (for this phase)

- **OpenTelemetry integration** — Too heavy for current architecture; simple trace IDs suffice
- **Kibana/ELK stack** — Requires infrastructure changes; log shipping is lighter weight
- **Prometheus + Grafana deployment** — Assume managed or external; we only provide metrics endpoint
- **Automated incident response** — Too risky; manual intervention preferred for now
- **Custom APM agent** — Over-engineered; request tracing is sufficient
- **Log aggregation across nodes** — Single-node assumption for now; add later if needed
- **Real-time log search** — Elasticsearch is overkill; DB queries suffice for now
- **Cost attribution dashboard** — Partially implemented in ConsolePage; defer enhancement
- **Self-healing automation** — Too risky without extensive testing
- **Multi-region monitoring** — Single region assumption for now

### Deferred to Future Phases

- Distributed tracing with W3C trace context
- Service mesh integration
- Chaos engineering tests
- Automated runbook execution
- ML-based anomaly detection

---

## Summary

**Total Work**: 6 branches, ~15 days sequential / ~7.5 days parallel  
**Critical Path**: Metrics Export → Tracing → Alerts  
**Risk Level**: Medium (server.js coordination required)  
**Recommendation**: Start with Branch A (Metrics) as foundation; Branch F (Synthetic) can run in parallel immediately.
