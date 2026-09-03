'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { GATES, discoverSpecs, dryRun, mapGateToSpecs } = require('./goldenPathHarness.cjs');

test('all golden-path / release gates are declared', () => {
  const ids = GATES.map((g) => g.id);
  for (const id of ['GP-01', 'GP-02', 'GP-03', 'persistence', 'review_rejection', 'failure_recovery', 'ledger_orphan_restore']) {
    assert.ok(ids.includes(id), `missing gate ${id}`);
  }
});

test('test discovery finds e2e specs', () => {
  const specs = discoverSpecs();
  assert.ok(specs.length > 0, 'expected at least one e2e spec');
  assert.ok(specs.some((s) => s.file.includes('m00-smoke')), 'm00-smoke spec present');
});

test('dry-run calls NO production providers', () => {
  const r = dryRun();
  assert.equal(r.dry_run, true);
  assert.equal(r.production_providers_called, 0); // skeleton never calls a provider
  assert.ok(Array.isArray(r.gates));
});

test('gate->spec mapping is deterministic', () => {
  const specs = discoverSpecs();
  for (const gate of GATES) {
    const a = mapGateToSpecs(gate, specs);
    const b = mapGateToSpecs(gate, specs);
    assert.deepEqual(a, b, `mapping for ${gate.id} not deterministic`);
  }
});

test('harness is a single definition of done', () => {
  const r = dryRun();
  assert.equal(typeof r.golden_path_ready, 'boolean');
  assert.equal(r.gates.length, GATES.length);
});
