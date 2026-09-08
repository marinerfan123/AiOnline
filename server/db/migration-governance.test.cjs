'use strict';
/**
 * Migration Governance Tests — inventory, allocator, preflight.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { discoverMigrations, getHeadVersion, getNextVersion, getDuplicateVersions, buildInventory } = require('./migration-inventory.cjs');
const { acquire, release, verifyReservation, listReservations, cleanupOrphans } = require('./migration-allocator.cjs');
const { runPreflight, checkVersionFormat, checkNoDuplicate, checkContiguous, classifyMigration } = require('./migration-preflight.cjs');

const RESERVATION_FILE = path.join(__dirname, 'migration-reservations.json');

// Helper: clean up reservations before/after tests
function cleanReservations() {
  try { fs.unlinkSync(RESERVATION_FILE); } catch {}
}

test.afterEach(() => {
  cleanReservations();
});

// === Inventory Tests ===

test('I1: discoverMigrations returns all .sql files sorted', () => {
  const migrations = discoverMigrations();
  assert.ok(migrations.length >= 15, `should find at least 15 migrations, got ${migrations.length}`);
  assert.ok(migrations[0].version === '0001', 'first migration should be 0001');
  // Chain-agnostic: last version is the actual head, not a hardcoded constant
  assert.equal(migrations[migrations.length - 1].version, getHeadVersion(migrations), 'last migration should equal computed head');
  // Verify sorted
  for (let i = 1; i < migrations.length; i++) {
    assert.ok(migrations[i].version > migrations[i - 1].version, 'versions must be strictly increasing (unique sequence)');
  }
});

test('I2: head version is the derived head', () => {
  const migrations = discoverMigrations();
  assert.equal(getHeadVersion(migrations), migrations[migrations.length - 1].version);
});

test('I3: next version is head + 1', () => {
  const migrations = discoverMigrations();
  const expected = String(parseInt(getHeadVersion(migrations), 10) + 1).padStart(4, '0');
  assert.equal(getNextVersion(migrations), expected);
});

test('I4: inventory build includes all required fields', () => {
  const inv = buildInventory();
  assert.ok(inv.generatedAt, 'should have generatedAt timestamp');
  assert.equal(inv.headVersion, getHeadVersion(inv.migrations));
  assert.equal(inv.nextVersion, getNextVersion(inv.migrations));
  assert.equal(inv.count, inv.migrations.length);
  assert.ok(Array.isArray(inv.migrations));
  assert.equal(inv.migrations.length, inv.count);
  // Each migration has required fields
  for (const m of inv.migrations) {
    assert.ok(m.version, 'migration should have version');
    assert.ok(m.name, 'migration should have name');
    assert.ok(m.checksum, 'migration should have checksum');
    assert.ok(m.filePath, 'migration should have filePath');
  }
});

test('I4b: getDuplicateVersions detects duplicate sequences in an existing chain', () => {
  const chain = [
    { version: '0014', filename: '0014_a.sql' },
    { version: '0016', filename: '0016_episodes.sql' },
    { version: '0016', filename: '0016_studio_run_engine.sql' },
    { version: '0017', filename: '0017_shots.sql' },
  ];
  const dups = getDuplicateVersions(chain);
  assert.equal(dups.length, 1, 'should find exactly one duplicate version');
  assert.equal(dups[0].version, '0016', 'duplicate version should be 0016');
  assert.deepEqual(dups[0].files, ['0016_episodes.sql', '0016_studio_run_engine.sql'], 'should list both colliding files');
});

test('I4c: getDuplicateVersions returns [] for a clean chain', () => {
  const clean = [
    { version: '0001', filename: '0001_a.sql' },
    { version: '0002', filename: '0002_b.sql' },
    { version: '0003', filename: '0003_c.sql' },
  ];
  assert.deepEqual(getDuplicateVersions(clean), []);
});

test('I5: the 0016 slot is a recognized historical anchor', () => {
  const migrations = discoverMigrations();
  const m0016 = migrations.find(m => m.version === '0016');
  assert.ok(m0016, '0016 must exist');
  // Chain-agnostic: 0016 is the episodes anchor on current main, studio_run_engine
  // on the older G0-04 base. Either is a legitimate historical anchor.
  assert.ok(['studio_run_engine', 'episodes'].includes(m0016.name), `unexpected 0016 anchor: ${m0016.name}`);
});

// === Allocator Tests ===

test('A1: acquire claims next available version', () => {
  const result = acquire('0017', 'test-worktree', 'test allocation');
  assert.ok(result.acquired, 'should acquire 0017');
  assert.equal(result.version, '0017');
  assert.equal(result.holder, 'test-worktree');
});

test('A2: duplicate acquire rejected', () => {
  acquire('0017', 'worktree-a', 'first claim');
  const result = acquire('0017', 'worktree-b', 'second claim');
  assert.ok(!result.acquired, 'should reject duplicate');
  assert.ok(result.reason.includes('already reserved'), 'should mention existing reservation');
});

test('A3: wrong version rejected (gap)', () => {
  const result = acquire('0018', 'test-worktree', 'skip version');
  assert.ok(!result.acquired, 'should reject gap version');
  assert.ok(result.reason.includes('not available'), 'should explain why');
});

test('A4: invalid version format rejected', () => {
  const result = acquire('abc', 'test-worktree', 'bad format');
  assert.ok(!result.acquired, 'should reject non-numeric version');
});

test('A5: release works for holder', () => {
  acquire('0017', 'worktree-x', 'test');
  const result = release('0017', 'worktree-x');
  assert.ok(result.released, 'should release');
  // Can acquire again after release
  const reacquire = acquire('0017', 'worktree-y', 'reclaim');
  assert.ok(reacquire.acquired, 'should allow re-acquire after release');
});

test('A6: release by non-holder rejected', () => {
  acquire('0017', 'owner', 'test');
  const result = release('0017', 'other');
  assert.ok(!result.released, 'should reject release by non-holder');
});

test('A7: verifyReservation returns valid for active reservation', () => {
  acquire('0017', 'verify-worktree', 'test');
  const result = verifyReservation('0017', 'verify-worktree');
  assert.ok(result.valid, 'should be valid');
});

test('A8: verifyReservation returns invalid for missing reservation', () => {
  const result = verifyReservation('0017', 'no-reservation');
  assert.ok(!result.valid, 'should be invalid');
});

test('A9: listReservations shows active reservations', () => {
  acquire('0017', 'list-worktree', 'test');
  const list = listReservations();
  assert.equal(list.length, 1, 'should have 1 reservation');
  assert.equal(list[0].version, '0017');
});

// === Preflight Tests ===

test('P1: preflight passes for valid additive migration', () => {
  const tmpDir = path.join(__dirname, 'tmp_test_migrations');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, '0017_test_preflight.sql');
  const sql = `CREATE TABLE IF NOT EXISTS test_preflight (id TEXT PRIMARY KEY);`;
  fs.writeFileSync(testFile, sql);
  try {
    const result = runPreflight(testFile);
    assert.ok(result.passed, `should pass preflight, errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.classification, 'REVERSIBLE');
  } finally {
    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  }
});

test('P2: preflight fails for DROP statement', () => {
  const tmpDir = path.join(__dirname, 'tmp_test_migrations');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, '0017_test_drop.sql');
  const sql = `DROP TABLE IF EXISTS some_table;`;
  fs.writeFileSync(testFile, sql);
  try {
    const result = runPreflight(testFile);
    assert.ok(!result.passed, 'should fail on DROP');
    assert.ok(result.errors.some(e => e.includes('DROP') || e.includes('IRREVERSIBLE')), `error should mention DROP: ${JSON.stringify(result.errors)}`);
  } finally {
    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  }
});

test('P3: preflight fails for wrong version format', () => {
  const testFile = path.join(__dirname, 'migrations', 'abc_test.sql');
  const sql = `CREATE TABLE test (id INT);`;
  fs.writeFileSync(testFile, sql);
  try {
    const result = runPreflight(testFile);
    assert.ok(!result.passed, 'should fail on bad version format');
  } finally {
    fs.unlinkSync(testFile);
  }
});

test('P4: preflight fails for duplicate version', () => {
  const testFile = path.join(__dirname, 'migrations', '0001_duplicate.sql');
  const sql = `CREATE TABLE test (id INT);`;
  fs.writeFileSync(testFile, sql);
  try {
    const result = runPreflight(testFile);
    assert.ok(!result.passed, 'should fail on duplicate version');
  } finally {
    fs.unlinkSync(testFile);
  }
});

test('P5: preflight requires reservation when flag set', () => {
  const tmpDir = path.join(__dirname, 'tmp_test_migrations');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, '0017_test_reserve.sql');
  const sql = `CREATE TABLE IF NOT EXISTS test_reserve (id TEXT);`;
  fs.writeFileSync(testFile, sql);
  try {
    const result = runPreflight(testFile, { requireReservation: true });
    assert.ok(!result.passed, 'should fail without reservation');
  } finally {
    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
  }
});

test('P6: preflight passes with reservation', () => {
  const tmpDir = path.join(__dirname, 'tmp_test_migrations');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, '0017_test_reserve_ok.sql');
  const sql = `CREATE TABLE IF NOT EXISTS test_reserve_ok (id TEXT);`;
  fs.writeFileSync(testFile, sql);
  const originalWorktree = process.env.GIT_WORKTREE;
  process.env.GIT_WORKTREE = 'preflight-worktree';
  try {
    acquire('0017', 'preflight-worktree', 'test');
    const result = runPreflight(testFile, { requireReservation: true });
    assert.ok(result.passed, `should pass with reservation, errors: ${JSON.stringify(result.errors)}`);
  } finally {
    fs.unlinkSync(testFile);
    fs.rmdirSync(tmpDir);
    release('0017', 'preflight-worktree');
    if (originalWorktree) {
      process.env.GIT_WORKTREE = originalWorktree;
    } else {
      delete process.env.GIT_WORKTREE;
    }
  }
});

// === Classification Tests ===

test('C1: REVERSIBLE classification for additive SQL', () => {
  const sql = `CREATE TABLE IF NOT EXISTS test_rev (id TEXT PRIMARY KEY);`;
  const classification = classifyMigration(sql, []);
  assert.equal(classification, 'REVERSIBLE');
});

test('C2: IRREVERSIBLE classification for DROP', () => {
  const sql = `DROP TABLE test_irrev;`;
  const classification = classifyMigration(sql, []);
  assert.equal(classification, 'IRREVERSIBLE');
});

test('C3: IRREVERSIBLE classification for data migration', () => {
  const sql = `UPDATE users SET status = 'migrated';`;
  const classification = classifyMigration(sql, []);
  assert.equal(classification, 'IRREVERSIBLE');
});
