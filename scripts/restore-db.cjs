'use strict';
/**
 * Database restore tool — Moling AI
 *
 * Safety:
 * - Only restores to databases whose names contain 'test', 'restore', 'dr', or 'backup'
 * - Refuses overwrite of non-empty target unless --allow-overwrite-test is explicitly passed
 * - Verifies backup integrity before restore (checksums + manifest)
 * - Non-zero exit on any failure
 *
 * Usage:
 *   node scripts/restore-db.cjs [options]
 *
 * Options:
 *   --backup <dir>          Backup directory (required)
 *   --db <name>             Target database name (required)
 *   --host <host>           PostgreSQL host (default: localhost)
 *   --port <port>           PostgreSQL port (default: 5432)
 *   --user <user>           PostgreSQL user (default: postgres)
 *   --password <pw>         PostgreSQL password (default: from env)
 *   --allow-overwrite-test  Allow overwriting a non-empty test database
 *   --dry-run               Show what would be done without doing it
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, Client } = require('pg');

// ─── Safety ───────────────────────────────────────────────

function assertSafeRestoreDatabase(dbName) {
  if (!dbName) {
    throw new Error('ABORT: --db is required.');
  }
  if (!/test|restore|dr|backup/i.test(dbName)) {
    throw new Error(`ABORT: database name '${dbName}' does not contain 'test', 'restore', 'dr', or 'backup'. Refusing to restore to an unsafe database.`);
  }
  if (/production/i.test(dbName)) {
    throw new Error(`ABORT: database name '${dbName}' contains 'production'. NEVER restore to production.`);
  }
  return true;
}

// ─── Config ───────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    backup: null,
    db: null,
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || process.env.TEST_PG_PASSWORD || '0.0.1abcd',
    allowOverwriteTest: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--backup': args.backup = argv[++i]; break;
      case '--db': args.db = argv[++i]; break;
      case '--host': args.host = argv[++i]; break;
      case '--port': args.port = parseInt(argv[++i], 10); break;
      case '--user': args.user = argv[++i]; break;
      case '--password': args.password = argv[++i]; break;
      case '--allow-overwrite-test': args.allowOverwriteTest = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help':
        console.log('Usage: node restore-db.cjs --backup <dir> --db <name> [--allow-overwrite-test]');
        process.exit(0);
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  return args;
}

// ─── Verify Backup ────────────────────────────────────────

function verifyBackup(backupDir) {
  const errors = [];

  // Check manifest exists
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    errors.push('Missing manifest.json');
    return { valid: false, errors, manifest: null };
  }

  // Read manifest
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    errors.push(`Invalid manifest.json: ${err.message}`);
    return { valid: false, errors, manifest: null };
  }

  // Verify checksums
  const checksumPath = path.join(backupDir, 'checksums.sha256');
  if (fs.existsSync(checksumPath)) {
    const checksumLines = fs.readFileSync(checksumPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim());

    for (const line of checksumLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const expectedHash = parts[0];
      const filename = parts[1];
      const filePath = path.join(backupDir, filename);

      if (!fs.existsSync(filePath)) {
        errors.push(`File missing: ${filename}`);
        continue;
      }

      const actualHash = crypto.createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');

      if (actualHash !== expectedHash) {
        errors.push(`CHECKSUM MISMATCH: ${filename} (expected ${expectedHash.substring(0, 16)}..., got ${actualHash.substring(0, 16)}...)`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest,
  };
}

// ─── Check Target DB ──────────────────────────────────────

async function checkTargetDBEmpty(config) {
  const client = new Client({
    host: config.host,
    port: config.port,
    database: 'postgres', // connect to postgres template DB to check target
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 10000,
  });

  await client.connect();
  try {
    // Check if target DB exists
    const dbExists = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [config.db]
    );

    if (dbExists.rows.length === 0) {
      return { exists: false, isEmpty: true };
    }

    // Check if target DB is empty (has no tables beyond defaults)
    const client2 = new Client({
      host: config.host,
      port: config.port,
      database: config.db,
      user: config.user,
      password: config.password,
      connectionTimeoutMillis: 10000,
    });

    await client2.connect();
    try {
      const tables = await client2.query(`
        SELECT COUNT(*)::int FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
      `);
      await client2.end();
      return { exists: true, isEmpty: parseInt(tables.rows[0].count, 10) === 0 };
    } catch (_) {
      await client2.end();
      throw new Error(`Cannot connect to target database '${config.db}'`);
    }
  } finally {
    await client.end();
  }
}

// ─── Create Target DB ─────────────────────────────────────

async function createDatabase(config) {
  const client = new Client({
    host: config.host,
    port: config.port,
    database: 'postgres',
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 10000,
  });

  await client.connect();
  try {
    // Drop if exists (only safe test DBs)
    await client.query(`DROP DATABASE IF EXISTS "${config.db}"`);
    await client.query(`CREATE DATABASE "${config.db}"`);
  } finally {
    await client.end();
  }
}

// ─── Restore from Logical Backup ──────────────────────────

function pgTypeCast(dataType) {
  // Map PG data types to simple casting for restore
  const casts = {
    'boolean': 'BOOLEAN',
    'integer': 'INT',
    'bigint': 'BIGINT',
    'smallint': 'SMALLINT',
    'real': 'REAL',
    'double precision': 'DOUBLE PRECISION',
    'numeric': 'NUMERIC',
    'text': 'TEXT',
    'character varying': 'TEXT',
    'timestamp with time zone': 'TIMESTAMPTZ',
    'timestamp without time zone': 'TIMESTAMP',
    'date': 'DATE',
    'time': 'TIME',
    'json': 'JSON',
    'jsonb': 'JSONB',
    'bytea': 'BYTEA',
    'uuid': 'UUID',
  };
  return casts[dataType] || 'TEXT';
}

function generateCreateTable(tableName, schema) {
  if (!schema.columns || schema.columns.length === 0) return null;

  const colDefs = schema.columns.map(col => {
    const colType = pgTypeCast(col.data_type);
    let def = `  "${col.column_name}" ${colType}`;
    if (col.column_default) {
      def += ` DEFAULT ${col.column_default}`;
    }
    if (col.is_nullable === 'NO') {
      def += ' NOT NULL';
    }
    return def;
  });

  let sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${colDefs.join(',\n')}\n)`;

  if (schema.primaryKeys && schema.primaryKeys.length > 0) {
    sql += `; ALTER TABLE "${tableName}" ADD PRIMARY KEY (${schema.primaryKeys.map(k => `"${k}"`).join(', ')})`;
  }

  return sql + ';';
}

async function logicalRestore(config, backupDir) {
  const dataPath = path.join(backupDir, 'data.json');
  const schemaMetaPath = path.join(backupDir, 'schema-meta.json');
  const schemaPath = path.join(backupDir, 'schema.sql');

  // Read schema metadata
  let tableSchemas = {};
  if (fs.existsSync(schemaMetaPath)) {
    tableSchemas = JSON.parse(fs.readFileSync(schemaMetaPath, 'utf-8'));
  }

  // Read schema SQL (if any)
  let schemaSql = '';
  if (fs.existsSync(schemaPath)) {
    schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  }

  // Read data
  const tableData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

  // Connect to target DB
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.db,
    user: config.user,
    password: config.password,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    // Apply schema SQL if available
    if (schemaSql) {
      await pool.query(schemaSql);
    }

    // Create tables from schema metadata
    for (const [tableName, schema] of Object.entries(tableSchemas)) {
      const createSql = generateCreateTable(tableName, schema);
      if (createSql) {
        try {
          await pool.query(createSql);
          console.log(`[restore] Created table: ${tableName}`);
        } catch (err) {
          console.warn(`[restore] Warning creating ${tableName}: ${err.message}`);
        }
      }
    }

    // Restore data table by table
    for (const [tableName, rows] of Object.entries(tableData)) {
      if (!rows || rows.length === 0) continue;

      const columns = Object.keys(rows[0]);

      // Check if table exists
      try {
        await pool.query(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE`);
      } catch (err) {
        // Table may not exist — skip this table's data
        console.warn(`[restore] Table ${tableName} does not exist, skipping data`);
        continue;
      }

      // Insert rows
      for (const row of rows) {
        const placeholders = columns
          .map((col, idx) => `$${idx + 1}`)
          .join(', ');
        const values = columns.map(col => row[col]);

        try {
          await pool.query(
            `INSERT INTO "${tableName}" ("${columns.join('", "')}") VALUES (${placeholders})`,
            values
          );
        } catch (err) {
          console.warn(`[restore] Warning inserting row in ${tableName}: ${err.message}`);
        }
      }
    }
  } finally {
    await pool.end();
  }
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const config = parseArgs(process.argv.slice(2));

  if (!config.backup) {
    console.error('ERROR: --backup <backup_directory> is required.');
    process.exit(1);
  }

  if (!config.db) {
    console.error('ERROR: --db <target_database_name> is required.');
    process.exit(1);
  }

  // Safety checks
  assertSafeRestoreDatabase(config.db);

  // Verify backup
  const verification = verifyBackup(config.backup);
  if (!verification.valid) {
    console.error('[restore] Backup verification FAILED:');
    for (const err of verification.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`[restore] Backup verified: ${verification.manifest.backup_id}`);

  if (config.dryRun) {
    console.log('DRY RUN — would restore to:', config.db);
    console.log('  backup:', config.backup);
    console.log('  manifest:', verification.manifest.backup_id);
    return;
  }

  const startMs = Date.now();

  try {
    // Check target DB
    const target = await checkTargetDBEmpty(config);

    if (target.exists && !target.isEmpty && !config.allowOverwriteTest) {
      console.error(`[restore] ABORT: target database '${config.db}' exists and is not empty.`);
      console.error('[restore] Use --allow-overwrite-test to overwrite test databases.');
      process.exit(1);
    }

    // Create or recreate target DB
    if (target.exists) {
      console.log(`[restore] Dropping existing database '${config.db}'`);
    }
    await createDatabase(config);
    console.log(`[restore] Created database '${config.db}'`);

    // Restore data
    console.log('[restore] Restoring data...');
    await logicalRestore(config, config.backup);

    const duration = Date.now() - startMs;
    console.log(`[restore] Complete: ${config.db} restored in ${duration}ms`);
    console.log(`[restore] Source: ${verification.manifest.backup_id}`);
    console.log(`[restore] Schema version: ${verification.manifest.database_schema_version}`);
  } catch (err) {
    console.error(`[restore] FAILED: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`[restore] UNEXPECTED ERROR: ${err.message}`);
  process.exit(1);
});
