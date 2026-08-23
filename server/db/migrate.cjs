'use strict';
/**
 * Migration runner — applies SQL migrations from server/db/migrations/
 * in deterministic order against the connected PostgreSQL database.
 *
 * Safety:
 * - Advisory lock prevents concurrent migrations
 * - Checksum validation rejects modified migration files
 * - Transactional: failed migrations rollback completely
 * - Idempotent: re-running on same DB is a no-op
 * - Test DB guard: refuses production databases
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const store = require('./migration-store.cjs');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function assertTestDatabase(dbName) {
  if (dbName && /production/i.test(dbName)) {
    throw new Error(`MIGRATION BLOCKED: database name '${dbName}' contains 'production'. Aborting.`);
  }
}

function discoverMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /\.sql$/.test(f))
    .sort()
    .map(f => {
      const m = f.match(/^(\d+)_(.+)\.sql$/);
      if (!m) return null;
      return { version: m[1], name: m[2], filePath: path.join(MIGRATIONS_DIR, f) };
    })
    .filter(Boolean);
}

async function status(pgPool) {
  const client = await pgPool.connect();
  try {
    const applied = await store.getApplied(client);
    const all = discoverMigrations();
    const appliedVersions = new Set(applied.map(a => a.version));
    const pending = all.filter(m => !appliedVersions.has(m.version));
    console.log(`Schema migrations: ${applied.length} applied, ${pending.length} pending`);
    for (const a of applied) {
      console.log(`  [OK]    ${a.version} ${a.name}`);
    }
    for (const p of pending) {
      console.log(`  [PENDING] ${p.version} ${p.name}`);
    }
    return { applied, pending };
  } finally {
    client.release();
  }
}

async function migrate(pgPool, options = {}) {
  const dbName = pgPool.config?.database || process.env.PG_DATABASE || '';
  assertTestDatabase(dbName);

  const allMigrations = discoverMigrations();
  if (!allMigrations.length) {
    console.log('[migrate] No migrations found.');
    return { applied: 0, skipped: 0 };
  }

  // Create tracking table outside any transaction so it survives rollbacks
  const initClient = await pgPool.connect();
  try {
    await store.ensureMigrationTable(initClient);
  } finally {
    initClient.release();
  }

  const client = await pgPool.connect();
  await client.query('BEGIN');

  try {
    // Acquire advisory lock
    const locked = await store.acquireLock(client);
    if (!locked) {
      await client.query('ROLLBACK');
      throw new Error('[migrate] Another migration is running. Aborting.');
    }

    // Load applied migrations
    const applied = await store.getApplied(client);
    const appliedMap = new Map(applied.map(a => [a.version, a]));

    let appliedCount = 0;
    let skippedCount = 0;

    for (const m of allMigrations) {
      const sql = fs.readFileSync(m.filePath, 'utf8');
      const checksum = store.computeChecksum(sql);

      // Check if already applied
      const existing = appliedMap.get(m.version);
      if (existing) {
        // Validate checksum — reject tampered files
        if (existing.checksum !== checksum) {
          await client.query('ROLLBACK');
          throw new Error(
            `[migrate] CHECKSUM MISMATCH for migration ${m.version} (${m.name}). ` +
            `File was modified after application.`
          );
        }
        skippedCount++;
        continue;
      }

      console.log(`[migrate] Applying ${m.version} ${m.name}...`);
      try {
        await client.query(sql);
        await store.recordMigration(client, m.version, m.name, checksum);
        appliedCount++;
        console.log(`[migrate] Applied ${m.version} ${m.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `[migrate] Migration ${m.version} ${m.name} FAILED: ${err.message}. Transaction rolled back.`
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[migrate] Done. ${appliedCount} applied, ${skippedCount} skipped.`);
    return { applied: appliedCount, skipped: skippedCount };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const pg = new Pool();
  (async () => {
    try {
      if (args.includes('--status')) {
        await status(pg);
      } else {
        await migrate(pg);
      }
      process.exit(0);
    } catch (err) {
      console.error('[migrate] ERROR:', err.message);
      process.exit(1);
    } finally {
      await pg.end();
    }
  })();
}

module.exports = { migrate, status, discoverMigrations, assertTestDatabase };
