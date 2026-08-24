# POSTGRESQL PRODUCTION DR

Moling AI — PostgreSQL Production Disaster Recovery

## Strategy

Two complementary DR approaches:

1. **Application Logical DR** — Node.js tools (`backup-db.cjs`, `restore-db.cjs`, `dr-drill.cjs`)
   - Format: JSON export/import via `pg` driver
   - Portable across platforms
   - Limited: no FK constraint capture

2. **PostgreSQL Native DR** — `pg_dump` / `pg_restore` (custom format)
   - Full fidelity: FK constraints, indexes, sequences, large objects
   - Compressed custom format (`-Fc`)
   - Supports parallel restore (`-j`)
   - Production standard

Both should be tested regularly.

## Managed PostgreSQL Provider DR

For managed PostgreSQL (RDS/Aurora/CloudSQL), prefer provider-native features:

| Feature | Aliyun RDS | AWS RDS/Aurora | GCP Cloud SQL |
|---------|-----------|----------------|---------------|
| Automated backups | Yes (7d retention) | Yes (7-35d) | Yes (7d default) |
| PITR | Yes (WAL-based) | Yes (WAL-based) | Yes (Continuous) |
| Read replicas | Yes | Yes | Yes |
| Cross-region | Manual snapshot copy | Manual snapshot copy | Cross-region replica |
| Point-in-time restore | Console/CLI | Console/CLI | Console/CLI |

**PITR is provider-managed — do not build homemade WAL infrastructure.**

## pg_dump -Fc Backup

### Command

```bash
pg_dump -Fc -h $PG_HOST -p $PG_PORT -U $PG_USER -d $PG_DATABASE -f backup.dump
```

### With TLS

```bash
PGSSLMODE=require pg_dump -Fc -h $PG_HOST -p $PG_PORT -U $PG_USER -d $PG_DATABASE -f backup.dump
```

### Verify Archive

```bash
pg_restore --list backup.dump
# Shows: schemas, tables, indexes, constraints, data

# Check SHA256
sha256sum backup.dump
```

### What's Included

- All table schemas (DDL)
- Foreign key constraints
- Indexes (including partial/unique)
- Sequences with current values
- Data (all rows)
- Comments
- Extensions

### What's NOT Included

- Roles/users (manage separately)
- Database-level grants (manage separately)
- Other databases on the same server

## pg_restore Recovery

### Full Restore to Fresh Database

```bash
# Create empty database
createdb -h $PG_HOST -U $PG_USER -d $PG_DATABASE_RESTORED

# Restore (parallel, drop-if-exists, no-owner, no-privileges)
pg_restore -h $PG_HOST -U $PG_USER -d $PG_DATABASE_RESTORED \
  --jobs 4 \
  --clean --if-exists \
  --no-owner --no-privileges \
  backup.dump
```

### Flags Explained

| Flag | Purpose |
|------|---------|
| `--jobs 4` | Parallel restore (speeds up large DBs) |
| `--clean --if-exists` | Drop existing objects before creating |
| `--no-owner` | Don't try to SET OWNER (managed PG restricts this) |
| `--no-privileges` | Don't try to GRANT (managed PG restricts this) |

## Application-Level Verification

After restore, run the application logical verification:

```bash
# 1. Check migration status
node server/db/migrate.cjs --dry-run --host $PG_HOST --user $PG_USER --password $PG_PASSWORD --db $PG_DATABASE_RESTORED

# 2. Boot application and run health check
curl http://localhost:3001/api/healthz
curl http://localhost:3001/api/readiness

# 3. Verify data parity
# Compare row counts, billing totals, generation counts
```

## Backup Encryption

**Production backups are SENSITIVE.** Requirements:

1. **Encryption at rest** — Use storage-class encryption (SSE-S3, Aliyun KMS, GCP CMEK)
2. **Encrypted transport** — Always use TLS (pg_sslmode=require)
3. **Restricted IAM** — Only authorized roles can access backup storage
4. **Off-site copy** — Replicate backups to a separate region/account

Do NOT implement custom cryptography. Use provider-supported encryption:
- Aliyun OSS: Server-side encryption with KMS
- AWS S3: SSE-S3 or SSE-KMS
- GCP GCS: CMEK or default encryption

## Backup Schedule (Recommended)

| Frequency | Retention | Purpose |
|-----------|-----------|---------|
| Pre-migration | Until migration verified + 7d | Rollback safety |
| Pre-deployment | Until deployment verified + 7d | Rollback safety |
| Hourly | 24h | PITR window |
| Daily | 7d | Weekly recovery |
| Weekly | 30d | Monthly recovery |
| Monthly | 90d | Long-term retention |

## PITR Workflow (Managed Provider)

When using managed PostgreSQL:

1. Identify target timestamp (before the incident)
2. Use provider console or CLI to create PITR restore
3. Provider creates new cluster from WAL at that point
4. Verify restored data
5. Update application connection string to point to restored cluster
6. Update DNS/LB if needed

**Estimated RTO**: 5-15 minutes (provider-dependent)
**Estimated RPO**: < 5 minutes (WAL archiving interval)

## DR Drill

Run regular DR drills to verify recovery:

```bash
# Application logical DR (Node.js)
npm run dr:test

# Native pg_dump/pg_restore DR (manual or scripted)
# 1. Dump production (or staging copy)
# 2. Restore to isolated test database
# 3. Verify schema, data, migration status
# 4. Run application health checks
# 5. Tear down test database
```

Schedule: monthly minimum, before every major release.

## Failover Behavior

During managed PostgreSQL failover:

1. Primary goes down (provider detects failure)
2. Replica promoted to primary (30-120s)
3. DNS/connection string resolves to new primary
4. Application behavior:
   - Active connections drop (ECONNRESET)
   - pg pool errors on next query attempt
   - `connectionTimeoutMillis` retries kick in
   - New connections establish to new primary
   - No data loss (replica was synchronous or near-sync)

Application tolerance:
- No connection pool warmup needed — pg creates new connections on demand
- In-flight queries fail → caller retries at HTTP level
- Workers lose lease → reaper recovers → normal resume
- API nodes return 503 during brief reconnect → LB health check handles

## Connection Failover Configuration

```bash
# Enable connection retry
PG_CONN_TIMEOUT_MS=5000    # 5s per attempt
PG_POOL_MAX=20             # Sufficient pool for reconnect storm

# The pg Pool auto-reconnects on next query
# No explicit reconnect code needed
```

## Secrets in Backups

Backups contain sensitive data:
- User credentials (hashed passwords)
- Payment provider keys (encrypted but still in DB)
- API keys
- User PII

Handle backups as classified data:
- Encrypt at rest
- Restrict access
- Audit access logs
- Securely destroy expired backups
