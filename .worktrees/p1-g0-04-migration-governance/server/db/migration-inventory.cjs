'use strict';
/**
 * Migration Inventory — read-only snapshot of all migration files.
 * Produces a deterministic JSON manifest used by allocator, preflight, and CI.
 *
 * Usage:
 *   node server/db/migration-inventory.cjs              # full JSON
 *   node server/db/migration-inventory.cjs --versions   # versions only
 *   node server/db/migration-inventory.cjs --next       # next available version
 *   node server/db/migration-inventory.cjs --head       # current head version
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function discoverMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /\.sql$/.test(f))
    .sort()
    .map(f => {
      const m = f.match(/^(\d+)_(.+)\.sql$/);
      if (!m) return null;
      const filePath = path.join(MIGRATIONS_DIR, f);
      const sql = fs.readFileSync(filePath, 'utf8');
      return {
        version: m[1],
        name: m[2],
        filename: f,
        filePath,
        size: fs.statSync(filePath).size,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    })
    .filter(Boolean);
}

function getHeadVersion(migrations) {
  if (!migrations.length) return '0000';
  return migrations[migrations.length - 1].version;
}

function getNextVersion(migrations) {
  if (!migrations.length) return '0017';
  const head = parseInt(migrations[migrations.length - 1].version, 10);
  return String(head + 1).padStart(4, '0');
}

function buildInventory() {
  const migrations = discoverMigrations();
  return {
    generatedAt: new Date().toISOString(),
    headVersion: getHeadVersion(migrations),
    nextVersion: getNextVersion(migrations),
    count: migrations.length,
    migrations,
  };
}

function main() {
  const args = process.argv.slice(2);
  const inv = buildInventory();

  if (args.includes('--versions')) {
    console.log(inv.migrations.map(m => m.version).join('\n'));
    return;
  }
  if (args.includes('--next')) {
    console.log(inv.nextVersion);
    return;
  }
  if (args.includes('--head')) {
    console.log(inv.headVersion);
    return;
  }

  // Default: print full JSON
  console.log(JSON.stringify(inv, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { discoverMigrations, getHeadVersion, getNextVersion, buildInventory };
