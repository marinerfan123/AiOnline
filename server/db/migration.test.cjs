'use strict';
/**
 * Migration framework tests — M1 through M12.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');

const { migrate, status, discoverMigrations, assertTestDatabase } = require('../db/migrate.cjs');
const store = require('../db/migration-store.cjs');

const pgUser = process.env.TEST_PG_USER || process.env.PG_USER || 'postgres';
const pgPass = process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd';
const pgHost = process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost';
const pgPort = process.env.TEST_PG_PORT || process.env.PG_PORT || '5432';
const pgUrl = `postgresql://${pgUser}:${pgPass}@${pgHost}:${pgPort}/postgres`;

const adminPool = new Pool({ connectionString: pgUrl, max: 1 });

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

async function createTestDb(suffix) {
  const dbName = `moling_mig_test_${suffix}`;
  // Terminate existing connections first
  await adminPool.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()
  `, [dbName]);
  await adminPool.query('DROP DATABASE IF EXISTS ' + dbName);
  await adminPool.query('CREATE DATABASE ' + dbName);
  return dbName;
}

async function dropTestDb(dbName) {
  try {
    await adminPool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [dbName]);
    await adminPool.query('DROP DATABASE IF EXISTS ' + dbName);
  } catch (_) {}
}

function createPool(dbName) {
  return new Pool({
    host: pgHost, port: Number(pgPort),
    user: pgUser, password: pgPass,
    database: dbName, max: 1,
  });
}

async function getTableColumns(pg, tableName) {
  const r = await pg.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = $1 ORDER BY ordinal_position
  `, [tableName]);
  return r.rows;
}

async function getTableIndexes(pg, tableName) {
  const r = await pg.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = $1 ORDER BY indexname
  `, [tableName]);
  return r.rows;
}

// === M1: Fresh DB migration ===
test('M1: fresh DB migration applies all migrations', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    const result = await migrate(pg);
    assert.ok(result.applied > 0, 'should have applied migrations');
    const appliedNames = ['baseline_legacy_schema', 'generation_v2_schema'];
    const { applied } = await status(pg);
    for (const name of appliedNames) {
      assert.ok(applied.find(a => a.name === name), `migration ${name} should be applied`);
    }
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// === M2: Second run is no-op ===
test('M2: second migration run is no-op', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await migrate(pg);
    const result = await migrate(pg);
    assert.equal(result.applied, 0, 'second run should apply 0');
    assert.ok(result.skipped > 0, 'second run should skip all');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// === M3: Versions ordered ===
test('M3: migration versions are deterministic and ordered', () => {
  const migrations = discoverMigrations();
  assert.ok(migrations.length >= 2, 'should have at least 2 migrations');
  for (let i = 1; i < migrations.length; i++) {
    assert.ok(
      migrations[i].version > migrations[i - 1].version,
      `migration ${i} version ${migrations[i].version} should be > ${migrations[i - 1].version}`
    );
  }
});

// === M4: Checksum mismatch rejected ===
test('M4: checksum mismatch for applied migration is rejected', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await migrate(pg);
    const m = discoverMigrations()[0];
    const orig = fs.readFileSync(m.filePath, 'utf8');
    const tampered = orig + '\n-- tampered';
    fs.writeFileSync(m.filePath, tampered);
    let threw = false;
    try {
      await migrate(pg);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('CHECKSUM MISMATCH'), `error should mention checksum: ${err.message}`);
    }
    assert.ok(threw, 'should have thrown on checksum mismatch');
    fs.writeFileSync(m.filePath, orig);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// === M5: Failed migration rolls back ===
test('M5: failed migration rolls back transaction', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  const migrationsDir = path.join(__dirname, 'migrations');
  const badPath = path.join(migrationsDir, '9999_bad_migration.sql');
  try {
    fs.writeFileSync(badPath, 'CREATE TABLE IF NOT EXISTS real_table_for_m5 (id TEXT PRIMARY KEY); INVALID SQL HERE;');
    let threw = false;
    try {
      await migrate(pg);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('FAILED'), `should mention failure: ${err.message}`);
    }
    assert.ok(threw, 'should have thrown on bad SQL');
    const r = await pg.query(`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'real_table_for_m5'
    `);
    assert.equal(r.rows.length, 0, 'bad table should not exist after rollback');
  } finally {
    try { fs.unlinkSync(badPath); } catch (_) {}
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// === M6: Failed migration not recorded ===
test('M6: failed migration is not recorded in schema_migrations', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  const migrationsDir = path.join(__dirname, 'migrations');
  const badPath = path.join(migrationsDir, '9998_fail_not_recorded.sql');
  try {
    fs.writeFileSync(badPath, 'CREATE TABLE if_not_real_for_m6 (id INT); THIS IS BAD;');
    try {
      await migrate(pg);
    } catch (_) {
      // expected
    }
    const r = await pg.query(
      "SELECT version FROM schema_migrations WHERE version = '9998'"
    );
    assert.equal(r.rows.length, 0, 'failed migration should not be recorded');
  } finally {
    try { fs.unlinkSync(badPath); } catch (_) {}
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// === M7: Concurrent migrators serialized ===
test('M7: concurrent migration runs are serialized', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    const result = await migrate(pg);
    assert.ok(result.applied > 0, 'migrations should apply');
    const { applied } = await status(pg);
    assert.ok(applied.length >= 2, 'should have applied both migrations');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// === M8: Unsafe DB rejected ===
test('M8: unsafe database name is rejected', () => {
  assert.throws(
    () => assertTestDatabase('my_production_db'),
    /production/i,
    'should reject production database name'
  );
  assert.doesNotThrow(
    () => assertTestDatabase('moling_test'),
    'should allow test database name'
  );
});

// === M9: Empty DB reaches required schema ===
test('M9: empty DB after migration has all required tables', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await migrate(pg);
    const required = [
      'users', 'providers', 'models', 'media', 'credit_transactions',
      'generation_batches_v2', 'generation_items_v2', 'generation_credit_holds_v2',
      'generation_outbox_v2', 'generation_worker_heartbeats_v2',
    ];
    for (const table of required) {
      const r = await pg.query(`
        SELECT 1 FROM information_schema.tables WHERE table_name = $1
      `, [table]);
      assert.equal(r.rows.length, 1, `table ${table} should exist`);
    }
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// === M10: Application tests work after migrations ===
test('M10: application can query tables after migration', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await migrate(pg);
    await pg.query(
      "INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
      ['u-test', 'test@test.com', 'Test', '$2b$10$fakehash']
    );
    const r = await pg.query('SELECT id, email FROM users WHERE id = $1', ['u-test']);
    assert.equal(r.rows[0].email, 'test@test.com');
    await pg.query(
      "INSERT INTO generation_batches_v2 (batch_id, user_id, model_id, requested_count, payload) VALUES ($1, $2, $3, $4, $5)",
      ['b-1', 'u-test', 'm-1', 1, '{}']
    );
    const b = await pg.query('SELECT batch_id FROM generation_batches_v2 WHERE batch_id = $1', ['b-1']);
    assert.equal(b.rows[0].batch_id, 'b-1');
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// === M11: Migration history deterministic ===
test('M11: migration history is deterministic across runs', async () => {
  const suffix1 = randomSuffix();
  const suffix2 = randomSuffix();
  const db1 = await createTestDb(suffix1);
  const db2 = await createTestDb(suffix2);
  const pg1 = createPool(db1);
  const pg2 = createPool(db2);
  try {
    await migrate(pg1);
    await migrate(pg2);
    const s1 = await status(pg1);
    const s2 = await status(pg2);
    assert.equal(s1.applied.length, s2.applied.length, 'same number of migrations');
    for (let i = 0; i < s1.applied.length; i++) {
      assert.equal(s1.applied[i].version, s2.applied[i].version, `version ${i} should match`);
      assert.equal(s1.applied[i].name, s2.applied[i].name, `name ${i} should match`);
      assert.equal(s1.applied[i].checksum, s2.applied[i].checksum, `checksum ${i} should match`);
    }
  } finally {
    await pg1.end();
    await pg2.end();
    await dropTestDb(db1);
    await dropTestDb(db2);
  }
}, { timeout: 120000 });

async function assertGenerationV2RuntimeSchema(pg) {
  const usersCols = await getTableColumns(pg, 'users');
  const userColNames = usersCols.map(c => c.column_name);
  assert.ok(userColNames.includes('email'), 'users should have email');
  assert.ok(userColNames.includes('password_hash'), 'users should have password_hash');
  assert.ok(userColNames.includes('reward_credits'), 'users should have reward_credits');
  assert.ok(userColNames.includes('credits'), 'users should have credits');

  const batchesCols = await getTableColumns(pg, 'generation_batches_v2');
  const batchColNames = batchesCols.map(c => c.column_name);
  for (const col of [
    'batch_id', 'user_id', 'idempotency_key', 'model_id', 'content_type',
    'requested_count', 'unit_price', 'reserved_total', 'success_count',
    'failed_count', 'canceled_count', 'status', 'request_payload',
    'created_at', 'started_at', 'completed_at',
  ]) {
    assert.ok(batchColNames.includes(col), `generation_batches_v2 should have ${col}`);
  }

  const itemsCols = await getTableColumns(pg, 'generation_items_v2');
  const itemColNames = itemsCols.map(c => c.column_name);
  for (const col of [
    'item_id', 'batch_id', 'item_index', 'mode', 'status', 'priority',
    'attempt_count', 'next_attempt_at', 'lease_owner', 'lease_version',
    'lease_expires_at', 'provider_id', 'key_id', 'provider_request_id',
    'provider_url', 'oss_url', 'last_error_code', 'last_error',
    'created_at', 'started_at', 'generated_at', 'uploaded_at', 'completed_at',
  ]) {
    assert.ok(itemColNames.includes(col), `generation_items_v2 should have ${col}`);
  }

  const attemptsCols = await getTableColumns(pg, 'generation_item_attempts_v2');
  const attemptColNames = attemptsCols.map(c => c.column_name);
  for (const col of [
    'attempt_id', 'item_id', 'attempt_no', 'lease_version', 'provider_id',
    'key_id', 'provider_request_id', 'client_request_id', 'status',
    'http_status', 'error_code', 'error_message', 'started_at', 'finished_at', 'latency_ms',
  ]) {
    assert.ok(attemptColNames.includes(col), `generation_item_attempts_v2 should have ${col}`);
  }

  const holdsCols = await getTableColumns(pg, 'generation_credit_holds_v2');
  const holdColNames = holdsCols.map(c => c.column_name);
  for (const col of ['hold_id', 'item_id', 'user_id', 'pool', 'amount', 'status', 'created_at', 'settled_at', 'kind', 'ref']) {
    assert.ok(holdColNames.includes(col), `generation_credit_holds_v2 should have ${col}`);
  }

  const heartbeatCols = await getTableColumns(pg, 'generation_worker_heartbeats_v2');
  const heartbeatColNames = heartbeatCols.map(c => c.column_name);
  for (const col of ['worker_id', 'role', 'last_seen_at', 'meta']) {
    assert.ok(heartbeatColNames.includes(col), `generation_worker_heartbeats_v2 should have ${col}`);
  }

  const outboxCols = await getTableColumns(pg, 'generation_outbox_v2');
  const outboxColNames = outboxCols.map(c => c.column_name);
  for (const col of [
    'event_id', 'aggregate_type', 'aggregate_id', 'event_type', 'payload',
    'created_at', 'published_at', 'lease_owner', 'lease_expires_at', 'attempts',
  ]) {
    assert.ok(outboxColNames.includes(col), `generation_outbox_v2 should have ${col}`);
  }

  const itemsIdx = await getTableIndexes(pg, 'generation_items_v2');
  const idxNames = itemsIdx.map(i => i.indexname);
  assert.ok(idxNames.includes('idx_generation_items_v2_claim'), 'should have claim index');
  assert.ok(idxNames.includes('idx_generation_items_v2_lease'), 'should have lease index');
  assert.ok(idxNames.includes('idx_generation_items_v2_batch'), 'should have batch index');
  assert.ok(idxNames.includes('uq_generation_items_v2_provider_request'), 'should have unique provider request index');
  const claimIdx = itemsIdx.find(i => i.indexname === 'idx_generation_items_v2_claim');
  assert.match(claimIdx.indexdef, /next_attempt_at/i, 'claim index should use runtime retry scheduler');
  assert.match(claimIdx.indexdef, /priority/i, 'claim index should use priority');

  const outboxIdx = await getTableIndexes(pg, 'generation_outbox_v2');
  const outboxPending = outboxIdx.find(i => i.indexname === 'idx_generation_outbox_v2_pending');
  assert.ok(outboxPending, 'should have outbox pending index');
  assert.match(outboxPending.indexdef, /published_at IS NULL/i, 'outbox pending index should use published_at');
}

async function assertGenerationV2WorkerStartupPrimitives(pg) {
  await pg.query(
    `INSERT INTO generation_worker_heartbeats_v2(worker_id, role, last_seen_at, meta)
     VALUES('w-migration-test', 'generation', NOW(), '{}'::jsonb)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at=NOW(), meta=EXCLUDED.meta`
  );
  await pg.query(
    `INSERT INTO users (id, email, display_name, password_hash)
     VALUES ('u-migration-v2', 'migration-v2@test.local', 'Migration V2', '$2b$10$fake')`
  );
  await pg.query(
    `INSERT INTO generation_batches_v2
       (batch_id, user_id, idempotency_key, model_id, content_type, requested_count, unit_price, reserved_total, request_payload)
     VALUES ('b-migration-v2', 'u-migration-v2', 'idem-migration-v2', 'model-v2', 'image', 1, 0, 0, '{}'::jsonb)`
  );
  await pg.query(
    `INSERT INTO generation_items_v2 (item_id, batch_id, item_index, status, mode, priority)
     VALUES ('i-migration-v2', 'b-migration-v2', 0, 'queued', 'real', 10)`
  );
  const claimed = await pg.query(
    `WITH picked AS (
       SELECT item_id FROM generation_items_v2
       WHERE status IN ('queued','retry_wait') AND mode='real' AND next_attempt_at <= NOW()
       ORDER BY priority DESC, created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE generation_items_v2 i
       SET status='leased', lease_owner='w-migration-test',
           lease_expires_at=NOW() + INTERVAL '30 seconds',
           lease_version=i.lease_version+1, attempt_count=i.attempt_count+1
     FROM picked WHERE i.item_id=picked.item_id
     RETURNING i.item_id, i.status, i.lease_version`
  );
  assert.equal(claimed.rowCount, 1, 'worker should claim a migrated V2 item');
}

// === M12: Schema parity ===
test('M12: schema parity between bootstrap and migration-created DB', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await migrate(pg);
    await assertGenerationV2RuntimeSchema(pg);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

test('M13: fresh migrations support Generation V2 worker startup primitives', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await migrate(pg);
    await assertGenerationV2RuntimeSchema(pg);
    await assertGenerationV2WorkerStartupPrimitives(pg);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

test('M14: database already at 0002 upgrades to runtime Generation V2 schema', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    const all = discoverMigrations();
    const beforeForward = all.filter(m => m.version <= '0002');
    assert.equal(beforeForward.length, 2, 'test setup should apply 0001 and 0002 only');
    await store.ensureMigrationTable(pg);
    for (const m of beforeForward) {
      const sql = fs.readFileSync(m.filePath, 'utf8');
      await pg.query('BEGIN');
      await pg.query(sql);
      await store.recordMigration(pg, m.version, m.name, store.computeChecksum(sql));
      await pg.query('COMMIT');
    }

    const result = await migrate(pg);
    assert.ok(result.applied >= 1, 'forward migration should apply to a database already at 0002');
    await assertGenerationV2RuntimeSchema(pg);
    await assertGenerationV2WorkerStartupPrimitives(pg);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// M15: fresh migrations create legacy runtime tables (P0: order-expiry tick
// failed on migrated production DBs because this schema only ever came from the
// legacy inline DDL removed in f6b2c7b; 0007+0008 move it to the migration chain).
test('M15: fresh migrations create legacy runtime tables (order-expiry dependency)', async () => {
  const suffix = randomSuffix();
  const dbName = await createTestDb(suffix);
  const pg = createPool(dbName);
  try {
    await migrate(pg);

    const tables = await pg.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          -- 0007: recharge/payment
          'recharge_orders','topup_packages','payment_settings','payment_providers',
          -- 0008: remaining legacy runtime tables
          'characters','webhook_events','payment_audit','skill_registry','products',
          'user_skills','model_cost_rates','consumption_ledger','model_price_history',
          'model_pricing','provider_model_costs','cron_marker','feedback','reports',
          'system_error_logs','studio_projects','agent_rule_logs'
        )
      ORDER BY table_name
    `);
    const expected = [
      'agent_rule_logs','characters','consumption_ledger','cron_marker','feedback',
      'model_cost_rates','model_pricing','model_price_history','payment_audit',
      'payment_providers','payment_settings','products','provider_model_costs',
      'recharge_orders','reports','skill_registry','studio_projects',
      'system_error_logs','topup_packages','user_skills','webhook_events',
    ].sort();
    assert.deepEqual(
      tables.rows.map(r => r.table_name),
      expected,
      '0007+0008 must create all legacy runtime tables on a fresh migrated DB'
    );

    // Exact query the order-expiry ticker runs — must not hit a missing relation.
    const s = await pg.query('SELECT default_expires_min, enabled FROM payment_settings WHERE id=1');
    assert.equal(s.rows.length, 1, 'payment_settings seed row (id=1) must exist');
    assert.equal(s.rows[0].default_expires_min, 15);
    assert.equal(s.rows[0].enabled, true);

    // Migration chain reports 0008 as the head on a fresh DB.
    const head = await pg.query(`SELECT max(version) AS v FROM schema_migrations`);
    assert.ok(head.rows[0].v >= '0008', `fresh DB migration head should be >= 0008, got ${head.rows[0].v}`);
  } finally {
    await pg.end();
    await dropTestDb(dbName);
  }
}, { timeout: 60000 });

// Cleanup
test.after(async () => {
  await adminPool.end();
});
