'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const inventory = require('./migration-inventory.cjs');
const allocatorPath = path.join(__dirname, 'migration-allocator.cjs');
const allocator = require(allocatorPath);
const preflight = require('./migration-preflight.cjs');
const dirs = [];
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moling-migration-')); dirs.push(dir); return dir; }
function useRegistry() { const file = path.join(tempDir(), 'reservations.json'); process.env.MIGRATION_RESERVATION_FILE = file; return file; }
function candidate(name, sql) { const file = path.join(tempDir(), `0017_${name}.sql`); fs.writeFileSync(file, sql); return file; }
afterEach(() => { delete process.env.MIGRATION_RESERVATION_FILE; while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

test('inventory recognizes immutable history, historical 0015 gap, and next P1 allocation', () => {
  const result = inventory.buildInventory();
  assert.equal(result.headVersion, '0016'); assert.equal(result.nextVersion, '0017'); assert.equal(result.count, 15);
  assert.deepEqual(result.history.gaps, ['0015']); assert.deepEqual(result.history.duplicateVersions, []);
  assert.match(result.history.gapPolicy, /Historical gaps/);
});

test('allocator requires valid identity/reason and enforces holder ownership', () => {
  useRegistry();
  assert.equal(allocator.acquire('0017', 'unknown', 'reason').acquired, false);
  assert.equal(allocator.acquire('0017', 'writer-a', '').acquired, false);
  assert.equal(allocator.acquire('0018', 'writer-a', 'gap').acquired, false);
  assert.equal(allocator.acquire('0017', 'writer-a', 'feature').acquired, true);
  assert.equal(allocator.acquire('0017', 'writer-b', 'collision').acquired, false);
  assert.equal(allocator.release('0017', 'writer-b').released, false);
  assert.equal(allocator.verifyReservation('0017', 'writer-a').valid, true);
});

test('atomic directory lock admits exactly one of concurrent writers', async () => {
  const registry = useRegistry();
  const workerSource = `const { parentPort, workerData } = require('worker_threads'); process.env.MIGRATION_RESERVATION_FILE = workerData.registry; const allocator = require(workerData.module); parentPort.postMessage(allocator.acquire('0017', workerData.id, 'race test'));`;
  const workers = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { registry, module: allocatorPath, id: `writer-${index}` } });
    worker.once('message', value => resolve({ code: value.acquired ? 0 : 1, value })); worker.once('error', reject);
  }));
  const results = await Promise.all(workers);
  assert.equal(results.filter(result => result.value.acquired).length, 1);
  assert.equal(results.filter(result => result.code === 0).length, 1);
  assert.equal(allocator.listReservations().length, 1);
});

test('preflight rejects unreserved, duplicate, gap, transaction control and destructive SQL', () => {
  useRegistry();
  assert.equal(preflight.runPreflight(candidate('additive', 'CREATE TABLE IF NOT EXISTS x (id int);'), { worktreeId: 'writer' }).passed, false);
  assert.equal(preflight.runPreflight(path.join(__dirname, 'migrations/0016_studio_run_engine.sql'), { requireReservation: false }).passed, false);
  const gap = path.join(tempDir(), '0018_gap.sql'); fs.writeFileSync(gap, 'CREATE TABLE x (id int);');
  assert.equal(preflight.runPreflight(gap, { requireReservation: false }).passed, false);
  const tx = preflight.runPreflight(candidate('tx', 'BEGIN; CREATE TABLE x (id int); COMMIT;'), { requireReservation: false });
  assert.equal(tx.passed, false); assert.ok(tx.errors.some(error => error.includes('transaction control')));
  const destructive = preflight.runPreflight(candidate('drop', 'DROP TABLE x;'), { requireReservation: false, rollbackDocsDir: tempDir() });
  assert.equal(destructive.classification, 'IRREVERSIBLE'); assert.ok(destructive.errors.some(error => error.includes('forward-fix/restore')));
});

test('reserved additive migration passes and reports lock-risk warnings', () => {
  useRegistry(); allocator.acquire('0017', 'writer', 'additive');
  const result = preflight.runPreflight(candidate('additive', 'ALTER TABLE media ADD COLUMN IF NOT EXISTS foo text; CREATE INDEX IF NOT EXISTS idx_media_foo ON media(foo);'), { worktreeId: 'writer' });
  assert.equal(result.passed, true, result.errors.join('; ')); assert.equal(result.classification, 'REVERSIBLE');
  assert.ok(result.warnings.some(warning => warning.includes('ACCESS EXCLUSIVE'))); assert.ok(result.warnings.some(warning => warning.includes('CONCURRENTLY')));
});

test('irreversible migration can pass only with explicit forward-fix/restore plan', () => {
  useRegistry(); allocator.acquire('0017', 'writer', 'data change');
  const docs = tempDir(); fs.writeFileSync(path.join(docs, '0017_backfill.md'), '# Strategy\nForward-fix or point-in-time restore; no down migration.');
  const result = preflight.runPreflight(candidate('backfill', "UPDATE users SET status = 'migrated';"), { worktreeId: 'writer', rollbackDocsDir: docs });
  assert.equal(result.classification, 'IRREVERSIBLE'); assert.equal(result.passed, true, result.errors.join('; '));
});
