'use strict';
/**
 * Migration Preflight — validates a new migration before it enters the chain.
 *
 * Checks:
 *   1. Version format: 4-digit number
 *   2. No duplicate versions
 *   3. Contiguous from head (no gaps)
 *   4. SQL syntax sanity (balanced parens, no dangerous drops)
 *   5. Rollback classification (REVERSIBLE vs IRREVERSIBLE)
 *   6. Reservation exists (if --require-reservation flag set)
 *
 * Usage:
 *   node server/db/migration-preflight.cjs --file migrations/0017_*.sql
 *   node server/db/migration-preflight.cjs --file migrations/0017_*.sql --require-reservation
 */

const fs = require('fs');
const path = require('path');
const { discoverMigrations, getHeadVersion, getNextVersion } = require('./migration-inventory.cjs');
const { verifyReservation } = require('./migration-allocator.cjs');

class PreflightResult {
  constructor() {
    this.passed = true;
    this.warnings = [];
    this.errors = [];
    this.classification = null;
  }

  addError(msg) {
    this.passed = false;
    this.errors.push(msg);
  }

  addWarning(msg) {
    this.warnings.push(msg);
  }

  setClassification(classification) {
    this.classification = classification;
  }
}

function checkVersionFormat(filename) {
  const match = filename.match(/^(\d+)_(.+)\.sql$/);
  if (!match) {
    return { valid: false, version: null, name: filename };
  }
  const version = match[1];
  // Must be exactly 4 digits
  if (!/^\d{4}$/.test(version)) {
    return { valid: false, version, name: match[2], error: `Version must be 4 digits, got "${version}"` };
  }
  return { valid: true, version, name: match[2] };
}

function checkNoDuplicate(version, allMigrations) {
  return !allMigrations.some(m => m.version === version);
}

function checkContiguous(version, allMigrations) {
  const expected = getNextVersion(allMigrations);
  return version === expected;
}

function checkSQLSanity(sql) {
  const issues = [];

  // Check for DROP statements (warn, don't block)
  const dropTable = /DROP\s+TABLE/i.test(sql);
  const dropColumn = /DROP\s+COLUMN/i.test(sql);
  const alterDrop = /ALTER\s+TABLE.*DROP/i.test(sql);

  if (dropTable || dropColumn || alterDrop) {
    issues.push({
      severity: 'ERROR',
      message: 'SQL contains DROP statement — classified as IRREVERSIBLE. Requires rollback documentation.',
    });
  }

  // Check for UPDATE/DELETE without WHERE (dangerous)
  const dangerousUpdate = /\bUPDATE\b.*\bSET\b.*\bWHERE\b/i.test(sql) === false &&
                          /\bUPDATE\b/i.test(sql);
  if (dangerousUpdate) {
    issues.push({
      severity: 'WARNING',
      message: 'UPDATE without WHERE clause detected — may be a full-table data migration.',
    });
  }

  // Balanced parentheses (basic check)
  let parenCount = 0;
  for (const ch of sql) {
    if (ch === '(') parenCount++;
    if (ch === ')') parenCount--;
    if (parenCount < 0) {
      issues.push({ severity: 'ERROR', message: 'Unbalanced parentheses detected.' });
      break;
    }
  }
  if (parenCount > 0) {
    issues.push({ severity: 'WARNING', message: `Unbalanced parentheses: ${parenCount} opening(s) unclosed.` });
  }

  // Check for COMMIT/ROLLBACK (should not be in migration files — handled by runner)
  if (/\b(COMMIT|ROLLBACK)\b/i.test(sql)) {
    issues.push({
      severity: 'WARNING',
      message: 'Migration contains COMMIT/ROLLBACK — these should be handled by the migration runner, not the SQL file.',
    });
  }

  return issues;
}

function classifyMigration(sql, issues) {
  const hasDrop = /DROP\s+(TABLE|COLUMN)/i.test(sql);
  const hasAlterDrop = /ALTER\s+TABLE.*DROP/i.test(sql);
  const hasDataMigration = /\b(UPDATE|DELETE)\b.*\bFROM\b/i.test(sql) ||
                           /ON\s+CONFLICT.*DO\s+(UPDATE|INSERT)/i.test(sql);
  const hasTypeChange = /ALTER\s+TABLE.*ALTER\s+COLUMN.*TYPE/i.test(sql);

  if (hasDrop || hasAlterDrop || hasDataMigration || hasTypeChange) {
    return 'IRREVERSIBLE';
  }

  // Check for additive-only pattern
  const isAdditive = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(sql) ||
                     /ALTER\s+TABLE.*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i.test(sql) ||
                     /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i.test(sql);

  if (isAdditive && !/\bDROP\b/i.test(sql)) {
    return 'REVERSIBLE';
  }

  // Default to cautious
  return 'IRREVERSIBLE';
}

function checkReservation(version, requireReservation) {
  if (!requireReservation) return { passed: true };
  const worktree = process.env.GIT_WORKTREE || 'unknown';
  const result = verifyReservation(version, worktree);
  if (!result.valid) {
    return { passed: false, error: result.reason };
  }
  return { passed: true };
}

function runPreflight(filePath, options = {}) {
  const { requireReservation = false } = options;
  const result = new PreflightResult();

  // Read file
  if (!fs.existsSync(filePath)) {
    result.addError(`File not found: ${filePath}`);
    return result;
  }

  const sql = fs.readFileSync(filePath, 'utf8');
  const filename = path.basename(filePath);

  // 1. Version format
  const versionCheck = checkVersionFormat(filename);
  if (!versionCheck.valid) {
    result.addError(versionCheck.error || 'Invalid filename format. Expected: NNNN_name.sql');
    return result;
  }
  const version = versionCheck.version;

  // 2. Get existing migrations
  const allMigrations = discoverMigrations();
  const head = getHeadVersion(allMigrations);

  // 3. No duplicate
  if (!checkNoDuplicate(version, allMigrations)) {
    result.addError(`Version ${version} already exists in migration chain.`);
    return result;
  }

  // 4. Contiguous
  if (!checkContiguous(version, allMigrations)) {
    const next = getNextVersion(allMigrations);
    result.addError(`Version gap detected. Expected ${next}, got ${version}. Head is ${head}.`);
    return result;
  }

  // 5. SQL sanity
  const sqlIssues = checkSQLSanity(sql);
  for (const issue of sqlIssues) {
    if (issue.severity === 'ERROR') {
      result.addError(issue.message);
    } else {
      result.addWarning(issue.message);
    }
  }

  // 6. Classify
  const classification = classifyMigration(sql, sqlIssues);
  result.setClassification(classification);

  if (classification === 'IRREVERSIBLE') {
    result.addWarning(
      'Migration classified as IRREVERSIBLE. Ensure rollback documentation exists at docs/migrations/rollbacks/'
    );
  }

  // 7. Reservation check
  const resCheck = checkReservation(version, requireReservation);
  if (!resCheck.passed) {
    result.addError(resCheck.error);
  }

  // Attach metadata
  result.version = version;
  result.name = versionCheck.name;
  result.headVersion = head;
  result.migrationCount = allMigrations.length;

  return result;
}

function main() {
  const args = process.argv.slice(2);
  let filePath = null;
  let requireReservation = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      filePath = args[++i];
    } else if (args[i] === '--require-reservation') {
      requireReservation = true;
    }
  }

  if (!filePath) {
    console.error('Usage: migration-preflight.cjs --file <path> [--require-reservation]');
    process.exit(1);
  }

  const result = runPreflight(filePath, { requireReservation });

  console.log(`\n=== Migration Preflight Report ===`);
  console.log(`File: ${filePath}`);
  console.log(`Version: ${result.version} (${result.name})`);
  console.log(`Head: ${result.headVersion}`);
  console.log(`Classification: ${result.classification}`);
  console.log(`Migration count: ${result.migrationCount} (+1 after this)`);

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of result.warnings) {
      console.log(`  ⚠  ${w}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    for (const e of result.errors) {
      console.log(`  ✗  ${e}`);
    }
    console.log(`\nResult: FAILED (${result.errors.length} error(s))`);
    process.exit(1);
  }

  console.log('\nResult: PASSED');
  if (requireReservation) {
    console.log('(Reservation verified)');
  }
}

if (require.main === module) {
  main();
}

module.exports = { runPreflight, PreflightResult, checkVersionFormat, checkNoDuplicate, checkContiguous, checkSQLSanity, classifyMigration };
