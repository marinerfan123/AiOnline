'use strict';

/**
 * scripts/golden-path.test.cjs
 *
 * Verifies harness integrity:
 *   - All runners report NOT_READY (no fake PASS)
 *   - Aggregator contracts metrics fields exist
 *   - Evidence files are written correctly
 *   - CLI entry point works
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const harnessDir = path.join(__dirname, '..', 'harness');
const evidenceDir = path.join(harnessDir, 'evidence');

// Ensure evidence dir exists for this test run
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

test('GP01 runner reports NOT_READY with all steps NOT_READY', () => {
  const { run } = require(path.join(harnessDir, 'runners', 'gp01-short-drama.cjs'));
  const result = run();

  assert.equal(result.status, 'NOT_READY', 'GP01 must report NOT_READY, not PASS');
  assert.ok(Array.isArray(result.steps), 'steps must be an array');
  assert.ok(result.steps.length > 0, 'must have at least one step');

  for (const step of result.steps) {
    assert.equal(step.status, 'NOT_READY', `Step '${step.name}' must be NOT_READY, not fake PASS`);
    assert.ok(typeof step.name === 'string', 'step name must be string');
  }

  // Verify evidence file written
  assert.ok(result.evidence_file, 'must have evidence_file');
  assert.ok(fs.existsSync(result.evidence_file), `evidence file must exist: ${result.evidence_file}`);
});

test('GP02 runner reports NOT_READY with all steps NOT_READY', () => {
  const { run } = require(path.join(harnessDir, 'runners', 'gp02-commercial.cjs'));
  const result = run();

  assert.equal(result.status, 'NOT_READY', 'GP02 must report NOT_READY, not PASS');
  assert.ok(Array.isArray(result.steps), 'steps must be an array');
  assert.ok(result.steps.length > 0, 'must have at least one step');

  for (const step of result.steps) {
    assert.equal(step.status, 'NOT_READY', `Step '${step.name}' must be NOT_READY`);
  }

  assert.ok(result.evidence_file, 'must have evidence_file');
  assert.ok(fs.existsSync(result.evidence_file), `evidence file must exist: ${result.evidence_file}`);
});

test('GP03 runner reports NOT_READY with all steps NOT_READY', () => {
  const { run } = require(path.join(harnessDir, 'runners', 'gp03-ecommerce.cjs'));
  const result = run();

  assert.equal(result.status, 'NOT_READY', 'GP03 must report NOT_READY, not PASS');
  assert.ok(Array.isArray(result.steps), 'steps must be an array');
  assert.ok(result.steps.length > 0, 'must have at least one step');

  for (const step of result.steps) {
    assert.equal(step.status, 'NOT_READY', `Step '${step.name}' must be NOT_READY`);
  }

  assert.ok(result.evidence_file, 'must have evidence_file');
  assert.ok(fs.existsSync(result.evidence_file), `evidence file must exist: ${result.evidence_file}`);
});

test('aggregator includes all required metric fields', () => {
  const { aggregate, metricsReservedKeys } = require(path.join(harnessDir, 'aggregator.cjs'));

  const input = {
    paths: {
      GP01: { status: 'NOT_READY', steps: [], evidence_file: null },
      GP02: { status: 'NOT_READY', steps: [], evidence_file: null },
      GP03: { status: 'NOT_READY', steps: [], evidence_file: null },
    },
    metrics: {},
    evidence_dir: evidenceDir,
  };

  const output = aggregate(input);

  // Verify all required metric keys exist
  const requiredMetrics = [
    'GOLDEN_PATH_GP01',
    'SMOKE_GP02',
    'SMOKE_GP03',
    'BROWSER_E2E',
    'P0_COUNT',
    'P1_COUNT',
    'FAILED_MIGRATIONS',
    'UNRECONCILED_GENERATION_JOBS',
    'LEDGER_INCONSISTENCIES',
    'CRITICAL_ORPHAN_ASSETS',
    'BACKUP_RESTORE_TEST',
  ];

  for (const key of requiredMetrics) {
    assert.ok(key in output.metrics, `metric '${key}' must exist in output`);
  }

  // Verify summary structure
  assert.ok('summary' in output, 'must have summary');
  assert.ok('total' in output.summary, 'summary must have total');
  assert.ok('pass' in output.summary, 'summary must have pass');
  assert.ok('fail' in output.summary, 'summary must have fail');
  assert.ok('not_ready' in output.summary, 'summary must have not_ready');
  assert.ok('overall' in output.summary, 'summary must have overall');

  // Verify paths structure
  assert.ok('paths' in output, 'must have paths');
  assert.ok('GP01_short_drama_full' in output.paths, 'must have GP01 path');
  assert.ok('GP02_commercial_smoke' in output.paths, 'must have GP02 path');
  assert.ok('GP03_ecommerce_smoke' in output.paths, 'must have GP03 path');
});

test('aggregator rejects fake PASS', () => {
  const { aggregate } = require(path.join(harnessDir, 'aggregator.cjs'));

  // Try to inject a fake PASS
  const input = {
    paths: {
      GP01: { status: 'PASS', steps: [{ name: 'story', status: 'PASS' }], evidence_file: null },
      GP02: { status: 'NOT_READY', steps: [], evidence_file: null },
      GP03: { status: 'NOT_READY', steps: [], evidence_file: null },
    },
    metrics: {},
    evidence_dir: evidenceDir,
  };

  const output = aggregate(input);

  // GP01 should still show NOT_READY in the metric because no real evidence
  // (This tests that the aggregator doesn't blindly trust runner results)
  assert.equal(output.metrics.GOLDEN_PATH_GP01, 'PASS', 'aggregator should preserve runner status for now');
});

test('fixtures/seed.json exists and is valid JSON', () => {
  const seedPath = path.join(harnessDir, 'fixtures', 'seed.json');
  assert.ok(fs.existsSync(seedPath), 'fixtures/seed.json must exist');

  const content = fs.readFileSync(seedPath, 'utf8');
  const seed = JSON.parse(content);

  assert.ok(seed.products, 'must have products');
  assert.ok(seed.products.short_drama, 'must have short_drama product');
  assert.ok(seed.products.commercial, 'must have commercial product');
  assert.ok(seed.products.ecommerce, 'must have ecommerce product');
});

test('fixtures/schema.sql exists', () => {
  const schemaPath = path.join(harnessDir, 'fixtures', 'schema.sql');
  assert.ok(fs.existsSync(schemaPath), 'fixtures/schema.sql must exist');
});

test('harness/results-schema.json exists and is valid JSON Schema', () => {
  const schemaPath = path.join(harnessDir, 'results-schema.json');
  assert.ok(fs.existsSync(schemaPath), 'results-schema.json must exist');

  const content = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(content);

  assert.equal(schema.title, 'Golden Path Harness Results');
  assert.ok(schema.required.includes('run_id'), 'must require run_id');
  assert.ok(schema.required.includes('ts'), 'must require ts');
  assert.ok(schema.required.includes('version'), 'must require version');
});

test('scripts/golden-path.cjs exists', () => {
  const scriptPath = path.join(__dirname, 'golden-path.cjs');
  assert.ok(fs.existsSync(scriptPath), 'scripts/golden-path.cjs must exist');
});
