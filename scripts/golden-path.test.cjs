'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const temporaryDirs = [];
function tempEvidence() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moling-gp-')); temporaryDirs.push(dir); return dir; }
afterEach(() => { while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true }); });

for (const [id, file, count] of [['GP01','gp01-short-drama.cjs',8],['GP02','gp02-commercial.cjs',7],['GP03','gp03-ecommerce.cjs',6]]) {
  test(`${id} retains ${count} NOT_READY steps and evidence`, () => {
    const result = require(path.join(root, 'harness/runners', file)).run({ evidenceDir: tempEvidence() });
    assert.equal(result.status, 'NOT_READY');
    assert.equal(result.steps.length, count);
    assert.ok(result.steps.every(step => step.status === 'NOT_READY'));
    assert.ok(result.evidence_file && path.isAbsolute(result.evidence_file));
    assert.ok(fs.existsSync(result.evidence_file));
  });
}

test('aggregate preserves steps, evidence paths and footprint', () => {
  const evidenceDir = tempEvidence();
  const paths = {};
  for (const [key, file] of [['GP01','gp01-short-drama.cjs'],['GP02','gp02-commercial.cjs'],['GP03','gp03-ecommerce.cjs']]) paths[key] = require(path.join(root, 'harness/runners', file)).run({ evidenceDir });
  const output = require(path.join(root, 'harness/aggregator.cjs')).aggregate({ paths, evidence_dir: evidenceDir, metrics: {} });
  assert.deepEqual(output.summary, { total: 3, pass: 0, fail: 0, not_ready: 3, overall: 'NOT_READY' });
  assert.deepEqual([output.metrics.GOLDEN_PATH_GP01, output.metrics.SMOKE_GP02, output.metrics.SMOKE_GP03], ['NOT_READY','NOT_READY','NOT_READY']);
  assert.equal(output.metrics.BROWSER_E2E, 'NOT_READY');
  assert.equal(output.metrics.BACKUP_RESTORE_TEST, 'NOT_READY');
  for (const key of ['P0_COUNT','P1_COUNT','FAILED_MIGRATIONS','UNRECONCILED_GENERATION_JOBS','LEDGER_INCONSISTENCIES','CRITICAL_ORPHAN_ASSETS']) assert.equal(output.metrics[key], null);
  assert.deepEqual(Object.values(output.paths).map(p => p.steps.length), [8,7,6]);
  assert.ok(Object.values(output.paths).every(p => p.evidence_file));
  assert.ok(output.footprint.length >= 7);
  assert.ok(output.footprint.some(file => file.endsWith('results.json')));
});

test('exit mapping keeps NOT_READY distinct and faults FAIL', () => {
  const { runnerExitToStatus } = require(path.join(root, 'harness/aggregator.cjs'));
  assert.equal(runnerExitToStatus(2), 'NOT_READY');
  assert.equal(runnerExitToStatus(1), 'FAIL');
  assert.equal(runnerExitToStatus(null, new Error('timeout')), 'FAIL');
});

test('CLI writes only to requested temporary evidence directory', () => {
  const evidenceDir = tempEvidence();
  const result = spawnSync(process.execPath, ['scripts/golden-path.cjs', '--evidence-dir', evidenceDir], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'results.json'), 'utf8'));
  assert.deepEqual(output.summary, { total: 3, pass: 0, fail: 0, not_ready: 3, overall: 'NOT_READY' });
  assert.deepEqual(Object.values(output.paths).map(p => p.steps.length), [8,7,6]);
  assert.ok(output.footprint.length > 0);
});

test('default CLI invocation leaves tracked Git source unchanged', () => {
  const before = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  assert.equal(before.status, 0, before.stderr);

  const result = spawnSync(process.execPath, ['scripts/golden-path.cjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);

  const after = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, before.stdout);
});

test('schema permits null for the six unknown counts', () => {
  const metrics = JSON.parse(fs.readFileSync(path.join(root, 'harness/results-schema.json'), 'utf8')).properties.metrics.properties;
  for (const key of ['P0_COUNT','P1_COUNT','FAILED_MIGRATIONS','UNRECONCILED_GENERATION_JOBS','LEDGER_INCONSISTENCIES','CRITICAL_ORPHAN_ASSETS']) assert.deepEqual(metrics[key].type, ['integer','null']);
});
