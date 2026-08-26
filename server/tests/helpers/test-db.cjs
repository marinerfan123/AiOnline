'use strict';
const { Pool } = require('pg');
const assert = require('node:assert/strict');

/**
 * Assert that the configured database name contains 'test' to prevent
 * accidental production database operations. Fail-closed.
 */
function assertSafeTestDatabase() {
  const dbName = process.env.TEST_PG_DATABASE || process.env.PG_DATABASE || '';
  assert.ok(
    /test/i.test(dbName),
    `ABORT: database "${dbName}" does not contain 'test'. Refusing to run integration tests against a non-test database.`
  );
  return dbName;
}

/**
 * Create a connection pool to the test database.
 * Reads TEST_PG_* env vars, falls back to PG_*, defaults to moling_test.
 */
function createTestPool() {
  return new Pool({
    host: process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost',
    port: Number(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432'),
    database: process.env.TEST_PG_DATABASE || process.env.PG_DATABASE || 'moling_test',
    user: process.env.TEST_PG_USER || process.env.PG_USER || 'postgres',
    password: process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || '0.0.1abcd',
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
}

/**
 * Initialize the test database schema by running the same DDL that server.js
 * runs on startup. Uses a lightweight approach: connect to the test DB and
 * execute the schema migration SQL from schema.cjs if available, otherwise
 * run a minimal set of table creation statements.
 */
async function initTestSchema(pg) {
  // Run the V2 schema if it exists
  try {
    const { applyGenerationV2Schema } = require('../../modules/generation-v2/schema.cjs');
    await applyGenerationV2Schema(pg);
  } catch (_) {
    // V2 schema may not exist in older baselines; non-fatal
  }

  // Run the core schema from server.js initDB equivalent
  // We import server.js's DDL by executing the same CREATE TABLE IF NOT EXISTS statements
  const coreSchema = `\
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      reward_credits NUMERIC(18,4) NOT NULL DEFAULT 0,
      recharge_credits NUMERIC(18,4) NOT NULL DEFAULT 0,
      credits NUMERIC(18,4) GENERATED ALWAYS AS (reward_credits + recharge_credits) STORED,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
      status TEXT NOT NULL DEFAULT 'active',
      plan TEXT DEFAULT 'free',
      avatar TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      revision INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'official',
      base_url TEXT DEFAULT '',
      api_key TEXT DEFAULT '',
      supported_types TEXT[] DEFAULT '{}',
      enabled BOOLEAN DEFAULT TRUE,
      protocol TEXT DEFAULT 'openai-compatible',
      remark TEXT DEFAULT '',
      default_endpoint JSONB DEFAULT '{}',
      capacity_model TEXT DEFAULT 'limited',
      bucket_max INT,
      cooldown_ms INT DEFAULT 60000,
      revision INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      mapping_name TEXT DEFAULT '',
      type TEXT DEFAULT 'image',
      provider_id TEXT REFERENCES providers(id) ON DELETE CASCADE,
      enabled BOOLEAN DEFAULT TRUE,
      supported_resolutions TEXT[] DEFAULT '{}',
      capabilities JSONB DEFAULT '{}',
      endpoint JSONB DEFAULT '{}',
      param_template JSONB DEFAULT '{}'::jsonb,
      credit_cost NUMERIC(18,4) DEFAULT 0,
      supports_reward_balance BOOLEAN NOT NULL DEFAULT TRUE,
      reward_credits_required NUMERIC(18,4) NOT NULL DEFAULT 0,
      max_concurrent INT,
      category TEXT DEFAULT '',
      creator JSONB DEFAULT '{}'::jsonb,
      commercial_use BOOLEAN,
      sort_order INT NOT NULL DEFAULT 0,
      revision INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      title TEXT DEFAULT '',
      type TEXT DEFAULT 'image',
      thumbnail TEXT DEFAULT '',
      full_url TEXT DEFAULT '',
      prompt TEXT DEFAULT '',
      model TEXT DEFAULT '',
      ratio TEXT DEFAULT '1:1',
      source TEXT DEFAULT 'user',
      is_favorite BOOLEAN DEFAULT FALSE,
      is_deleted BOOLEAN DEFAULT FALSE,
      oss_url TEXT DEFAULT '',
      oss_object_key TEXT DEFAULT '',
      oss_uploaded BOOLEAN DEFAULT FALSE,
      category TEXT DEFAULT 'generated',
      status TEXT DEFAULT 'success',
      error_message TEXT DEFAULT '',
      failed_at TIMESTAMPTZ,
      file_size BIGINT,
      task_id TEXT DEFAULT '',
      provider_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount NUMERIC(14,4) NOT NULL,
      ref TEXT,
      pool TEXT DEFAULT 'recharge',
      balance_after NUMERIC(18,4),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_transactions_v2_ref_kind
      ON credit_transactions (ref, kind) WHERE ref LIKE 'v2:%';

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS generation_tasks (
      task_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      model TEXT DEFAULT '',
      prompt TEXT DEFAULT '',
      count INT DEFAULT 1,
      content_type TEXT DEFAULT 'image',
      result TEXT DEFAULT '',
      error TEXT DEFAULT '',
      pending_ids TEXT[] DEFAULT '{}',
      client_meta JSONB DEFAULT '{}'::jsonb,
      cost NUMERIC(14,4),
      cost_pool TEXT,
      provider_id TEXT,
      model_id TEXT,
      provider_key TEXT,
      provider_task_id TEXT,
      resume_meta JSONB,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS generation_batches_v2 (
      batch_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      requested_count SMALLINT NOT NULL,
      unit_price NUMERIC(14,4) NOT NULL,
      reserved_total NUMERIC(14,4) NOT NULL,
      success_count SMALLINT NOT NULL DEFAULT 0,
      failed_count SMALLINT NOT NULL DEFAULT 0,
      canceled_count SMALLINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'accepted',
      request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      UNIQUE (user_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS generation_items_v2 (
      item_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES generation_batches_v2(batch_id) ON DELETE CASCADE,
      item_index SMALLINT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'real',
      status TEXT NOT NULL DEFAULT 'queued',
      priority INT NOT NULL DEFAULT 0,
      attempt_count INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_owner TEXT,
      lease_version BIGINT NOT NULL DEFAULT 0,
      lease_expires_at TIMESTAMPTZ,
      provider_id TEXT,
      key_id TEXT,
      provider_request_id TEXT,
      provider_url TEXT,
      oss_url TEXT,
      last_error_code TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      generated_at TIMESTAMPTZ,
      uploaded_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      UNIQUE (batch_id, item_index)
    );

    CREATE TABLE IF NOT EXISTS generation_credit_holds_v2 (
      hold_id BIGSERIAL PRIMARY KEY,
      item_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      pool TEXT NOT NULL,
      amount NUMERIC(14,4) NOT NULL,
      status TEXT NOT NULL DEFAULT 'held',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS generation_item_attempts_v2 (
      attempt_id BIGSERIAL PRIMARY KEY,
      item_id TEXT NOT NULL,
      attempt_no INT NOT NULL,
      lease_version BIGINT NOT NULL,
      provider_id TEXT,
      key_id TEXT,
      provider_request_id TEXT,
      client_request_id TEXT,
      status TEXT NOT NULL,
      http_status INT,
      error_code TEXT,
      error_message TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      latency_ms INT,
      UNIQUE (item_id, attempt_no)
    );

    CREATE TABLE IF NOT EXISTS generation_outbox_v2 (
      event_id BIGSERIAL PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      attempts INT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS generation_worker_heartbeats_v2 (
      worker_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      meta JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS provider_model_bindings (
      id TEXT PRIMARY KEY DEFAULT 'pmb-' || gen_random_uuid()::text,
      model_id TEXT NOT NULL,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      upstream_model_name TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      priority INT NOT NULL DEFAULT 0,
      weight INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (model_id, provider_id)
    );

    CREATE TABLE IF NOT EXISTS system_error_logs (
      id BIGSERIAL PRIMARY KEY,
      category TEXT DEFAULT 'app',
      source TEXT DEFAULT '',
      message TEXT DEFAULT '',
      meta JSONB DEFAULT '{}'::jsonb,
      stack TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  await pg.query(coreSchema);
}

/**
 * Truncate all tables in the test database to clean state.
 * Order matters for FK constraints.
 */
async function truncateAll(pg) {
  const tables = [
    'generation_worker_heartbeats_v2',
    'generation_outbox_v2',
    'generation_item_attempts_v2',
    'generation_credit_holds_v2',
    'generation_items_v2',
    'generation_batches_v2',
    'system_error_logs',
    'provider_model_bindings',
    'credit_transactions',
    'settings',
    'generation_tasks',
    'media',
    'models',
    'providers',
    'users',
  ];
  // Single atomic truncate with CASCADE handles all FK constraints
  await pg.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * Close the test pool.
 */
async function closeTestPool(pg) {
  if (pg && typeof pg.end === 'function') {
    await pg.end();
  }
}

module.exports = {
  assertSafeTestDatabase,
  createTestPool,
  initTestSchema,
  truncateAll,
  closeTestPool,
};
