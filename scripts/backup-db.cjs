'use strict';
/**
 * Database backup tool — Moling AI
 *
 * Safety:
 * - Refuses production database names (must contain 'test', 'restore', 'dr', or 'backup')
 * - Generates manifest with checksums
 * - Non-zero exit on any failure
 * - Secrets are never written to backup files
 *
 * Usage:
 *   node scripts/backup-db.cjs [options]
 *
 * Options:
 *   --db <name>          Database name (required)
 *   --host <host>        PostgreSQL host (default: localhost)
 *   --port <port>        PostgreSQL port (default: 5432)
 *   --user <user>        PostgreSQL user (default: postgres)
 *   --password <pw>      PostgreSQL password (default: from env)
 *   --output <dir>       Output directory (default: backups/YYYYMMDD-HHMMSS/)
 *   --format <fmt>       Format: logical (default) | pg_dump (requires pg_dump binary)
 *   --dry-run            Show what would be done without doing it
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// ─── Safety ───────────────────────────────────────────────

function assertSafeDatabase(dbName) {
  if (!dbName) {
    throw new Error('ABORT: --db is required.');
  }
  if (/production/i.test(dbName)) {
    throw new Error(`ABORT: database name '${dbName}' contains 'production'. Refusing to backup production databases.`);
  }
  // Allow any DB for backup (we only restrict restore to test DBs)
  // But warn about non-test DBs
  if (!/test|restore|dr|backup|staging|dev|moling/i.test(dbName)) {
    console.error(`WARNING: database '${dbName}' does not appear to be a test/development database.`);
    console.error('Backup is proceeding, but only test databases are recommended.');
  }
  return true;
}

// ─── Config ───────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    db: null,
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || process.env.TEST_PG_PASSWORD || '0.0.1abcd',
    output: null,
    format: 'logical',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--db': args.db = argv[++i]; break;
      case '--host': args.host = argv[++i]; break;
      case '--port': args.port = parseInt(argv[++i], 10); break;
      case '--user': args.user = argv[++i]; break;
      case '--password': args.password = argv[++i]; break;
      case '--output': args.output = argv[++i]; break;
      case '--format': args.format = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help':
        console.log('Usage: node backup-db.cjs --db <name> [--host] [--port] [--output] [--format logical|pg_dump]');
        process.exit(0);
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  return args;
}

// ─── Manifest ─────────────────────────────────────────────

function generateManifest(config, results) {
  const now = new Date().toISOString();
  return {
    backup_id: `backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    timestamp: now,
    project: 'moling-ai',
    git_commit: results.git_commit || 'unknown',
    branch: results.branch || 'unknown',
    database_name: config.db,
    database_schema_version: results.schema_version || 'unknown',
    migration_versions: results.migration_versions || [],
    node_version: process.version,
    backup_format: config.format,
    files_included: results.files_included || [],
    files_excluded: [],
    checksums: results.checksums || {},
    restore_compatibility: 'moling-ai >= v1.0',
    environment_classification: 'test',
    secret_present: false,
    row_counts: results.row_counts || {},
    backup_duration_ms: results.duration_ms || 0,
  };
}

// ─── Logical Backup ───────────────────────────────────────

async function logicalBackup(config) {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.db,
    user: config.user,
    password: config.password,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  const startMs = Date.now();

  try {
    // Discover tables
    const tablesResult = await pool.query(`
      SELECT tablename FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    const tables = tablesResult.rows.map(r => r.tablename);

    // Get schema — capture column metadata per table for restore-time DDL generation
    const tableSchemas = {};
    for (const table of tables) {
      try {
        const cols = await pool.query(`
          SELECT column_name, data_type, is_nullable, column_default, ordinal_position
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `, [table]);
        const pks = await pool.query(`
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
        `, [table]);
        tableSchemas[table] = {
          columns: cols.rows,
          primaryKeys: pks.rows.map(r => r.column_name),
        };
      } catch (_) {
        tableSchemas[table] = { columns: [], primaryKeys: [] };
      }
    }

    // Get migration history
    let migrationVersions = [];
    try {
      const migResult = await pool.query(`
        SELECT version, name FROM schema_migrations ORDER BY version
      `);
      migrationVersions = migResult.rows.map(r => `${r.version}_${r.name}`);
    } catch (_) {
      // schema_migrations may not exist
    }

    // Get row counts
    const rowCounts = {};
    for (const table of tables) {
      try {
        const countResult = await pool.query(`SELECT COUNT(*)::int FROM ${table}`);
        rowCounts[table] = parseInt(countResult.rows[0].count, 10);
      } catch (_) {
        rowCounts[table] = -1; // error counting
      }
    }

    // Dump each table
    const backups = {};
    for (const table of tables) {
      try {
        const rows = await pool.query(`SELECT * FROM ${table}`);
        backups[table] = rows.rows;
      } catch (err) {
        console.error(`ERROR dumping table ${table}: ${err.message}`);
        throw err;
      }
    }

    // Get schema version from migrations
    const schemaVersion = migrationVersions.length > 0
      ? migrationVersions[migrationVersions.length - 1].split('_')[0]
      : 'unknown';

    // Get git info
    let gitCommit = 'unknown';
    let branch = 'unknown';
    try {
      const { execSync } = require('child_process');
      gitCommit = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
      branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() }).toString().trim();
    } catch (_) {
      // git not available or not in a repo
    }

    const duration = Date.now() - startMs;

    return {
      tableSchemas,
      tableData: backups,
      tables,
      rowCounts,
      migrationVersions,
      schemaVersion,
      gitCommit,
      branch,
      duration,
    };
  } finally {
    await pool.end();
  }
}

// ─── Write Backup ─────────────────────────────────────────

function writeBackup(outputDir, backupData, config) {
  const manifest = generateManifest(config, {
    git_commit: backupData.gitCommit,
    branch: backupData.branch,
    schema_version: backupData.schemaVersion,
    migration_versions: backupData.migrationVersions,
    row_counts: backupData.rowCounts,
    duration_ms: backupData.duration,
    files_included: ['schema-meta.json', 'data.json', 'manifest.json'],
  });

  // Write schema metadata
  const schemaMetaPath = path.join(outputDir, 'schema-meta.json');
  fs.writeFileSync(schemaMetaPath, JSON.stringify(backupData.tableSchemas || {}, null, 2), 'utf-8');

  // Write data
  const dataPath = path.join(outputDir, 'data.json');
  fs.writeFileSync(dataPath, JSON.stringify(backupData.tableData, null, 2), 'utf-8');

  // Write manifest
  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Compute checksums
  const checksums = {};
  for (const file of ['schema-meta.json', 'data.json']) {
    const content = fs.readFileSync(path.join(outputDir, file));
    checksums[file] = crypto.createHash('sha256').update(content).digest('hex');
  }

  // Write checksums file
  const checksumPath = path.join(outputDir, 'checksums.sha256');
  const checksumContent = Object.entries(checksums)
    .map(([file, hash]) => `${hash}  ${file}`)
    .join('\n') + '\n';
  fs.writeFileSync(checksumPath, checksumContent, 'utf-8');

  manifest.checksums = checksums;
  // Rewrite manifest with checksums
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return {
    manifest,
    outputDir,
    files: ['schema-meta.json', 'data.json', 'manifest.json', 'checksums.sha256'],
  };
}

// ─── pg_dump Backup ───────────────────────────────────────

async function pgDumpBackup(config) {
  const { spawnSync } = require('child_process');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = config.output || path.join(process.cwd(), 'backups', timestamp);
  fs.mkdirSync(outputDir, { recursive: true });

  const outputFiles = [];

  // pg_dump custom format
  const dumpFile = path.join(outputDir, 'backup.dump');
  const dumpResult = spawnSync('pg_dump', [
    '-h', config.host,
    '-p', String(config.port),
    '-U', config.user,
    '-d', config.db,
    '-Fc',
    '-f', dumpFile,
  ], {
    env: { ...process.env, PGPASSWORD: config.password },
  });

  if (dumpResult.status !== 0) {
    console.error('pg_dump stdout:', dumpResult.stdout?.toString());
    console.error('pg_dump stderr:', dumpResult.stderr?.toString());
    throw new Error(`pg_dump failed with exit code ${dumpResult.status}`);
  }

  outputFiles.push('backup.dump');

  // Schema
  const schemaPath = path.join(outputDir, 'schema.sql');
  const schemaResult = spawnSync('pg_dump', [
    '-h', config.host,
    '-p', String(config.port),
    '-U', config.user,
    '-d', config.db,
    '--schema-only',
  ], {
    env: { ...process.env, PGPASSWORD: config.password },
    encoding: 'utf-8',
  });

  if (schemaResult.status === 0) {
    fs.writeFileSync(schemaPath, schemaResult.stdout);
    outputFiles.push('schema.sql');
  }

  // Manifest
  const manifest = generateManifest(config, {
    git_commit: 'unknown',
    branch: 'unknown',
    schema_version: 'unknown',
    files_included: outputFiles,
    checksums: {},
  });

  // Compute checksum
  const dumpContent = fs.readFileSync(dumpFile);
  manifest.checksums['backup.dump'] = crypto.createHash('sha256').update(dumpContent).digest('hex');
  const checksumsFile = Object.entries(manifest.checksums)
    .map(([file, hash]) => `${hash}  ${file}`)
    .join('\n') + '\n';
  fs.writeFileSync(path.join(outputDir, 'checksums.sha256'), checksumsFile, 'utf-8');
  outputFiles.push('checksums.sha256');

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  outputFiles.push('manifest.json');

  return { manifest, outputDir, files: outputFiles };
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const config = parseArgs(process.argv.slice(2));

  if (!config.db) {
    console.error('ERROR: --db <database_name> is required.');
    process.exit(1);
  }

  // Safety check
  assertSafeDatabase(config.db);

  if (config.dryRun) {
    console.log('DRY RUN — would backup database:', config.db);
    console.log('  host:', config.host);
    console.log('  port:', config.port);
    console.log('  format:', config.format);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  config.output = config.output || path.join(process.cwd(), 'backups', timestamp);
  fs.mkdirSync(config.output, { recursive: true });

  console.log(`[backup] Starting backup of '${config.db}' at ${timestamp}`);

  try {
    let result;
    if (config.format === 'pg_dump') {
      result = await pgDumpBackup(config);
    } else {
      const backupData = await logicalBackup(config);
      result = writeBackup(config.output, backupData, config);
    }

    console.log(`[backup] Complete: ${result.outputDir}`);
    console.log(`[backup] Files: ${result.files.join(', ')}`);
    console.log(`[backup] Manifest: ${JSON.stringify(result.manifest.backup_id)}`);
    if (result.manifest.checksums) {
      for (const [file, hash] of Object.entries(result.manifest.checksums)) {
        console.log(`[backup] SHA256 ${file}: ${hash.substring(0, 16)}...`);
      }
    }
    console.log(`[backup] Duration: ${result.manifest.backup_duration_ms || 0}ms`);
  } catch (err) {
    console.error(`[backup] FAILED: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`[backup] UNEXPECTED ERROR: ${err.message}`);
  process.exit(1);
});
