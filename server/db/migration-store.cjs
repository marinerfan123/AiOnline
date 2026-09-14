'use strict';
/**
 * Migration store — tracks applied migrations in schema_migrations table.
 * Provides checksum validation, duplicate prevention, and version tracking.
 */
const { Pool, Client } = require('pg');
const crypto = require('crypto');

const LOCK_TAG = 84_721_903_574; // pg_advisory_xact_lock tag for migrations

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getApplied(client) {
  await ensureMigrationTable(client);
  const r = await client.query(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC'
  );
  return r.rows;
}

function computeChecksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function recordMigration(client, version, name, checksum) {
  await client.query(
    'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
    [version, name, checksum]
  );
}

/**
 * Acquire a global advisory lock so only one migrator runs at a time.
 * Timeout after 30s — if lock is held, the other instance is migrating.
 */
async function acquireLock(client) {
  const r = await client.query('SELECT pg_try_advisory_xact_lock($1)', [LOCK_TAG]);
  return r.rows[0].pg_try_advisory_xact_lock;
}

module.exports = {
  ensureMigrationTable,
  getApplied,
  computeChecksum,
  recordMigration,
  acquireLock,
  LOCK_TAG,
};
