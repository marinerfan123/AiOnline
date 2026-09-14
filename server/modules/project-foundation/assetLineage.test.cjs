'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLineageGraph, resolveLineage, buildShotAssetBinding } = require('./assetLineage.cjs');

const VERSIONS = [
  { version_id: 'v1', kind: 'upload' },
  { version_id: 'v2', kind: 'generated', derived_from: 'v1', generation_id: 'g1' },
  { version_id: 'v3', kind: 'derived', derived_from: 'v2' },
];

test('buildLineageGraph builds adjacency + edges', () => {
  const g = buildLineageGraph(VERSIONS);
  assert.deepEqual(g.edges, [{ from: 'v1', to: 'v2' }, { from: 'v2', to: 'v3' }]);
  assert.deepEqual(g.children['v1'], ['v2']);
});

test('resolveLineage traces source (origin = root upload) + generation id', () => {
  const g = buildLineageGraph(VERSIONS);
  const r = resolveLineage(VERSIONS[2], g); // v3 -> v2 -> v1 (v2 has generation g1)
  assert.equal(r.ok, true);
  assert.equal(r.originId, 'v1');
  assert.equal(r.originKind, 'upload');
  assert.deepEqual(r.path, ['v2', 'v1']);
  assert.equal(r.sourceGenerationId, 'g1'); // nearest generation (v2) traced
  const r2 = resolveLineage(VERSIONS[1], g); // v2 has its own generation
  assert.equal(r2.sourceGenerationId, 'g1');
  const r3 = resolveLineage(VERSIONS[0], g); // v1 upload root
  assert.equal(r3.sourceGenerationId, null);
});

test('lineage cycle detected', () => {
  const cyc = [
    { version_id: 'a', kind: 'upload', derived_from: 'b' },
    { version_id: 'b', kind: 'generated', derived_from: 'a' },
  ];
  const g = buildLineageGraph(cyc);
  const r = resolveLineage(cyc[0], g);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'LINEAGE_CYCLE');
});

test('W3-13: binding is deterministic + requires both fields', () => {
  const r = buildShotAssetBinding({ shotId: 's1', assetVersionId: 'v3' });
  assert.equal(r.ok, true);
  assert.equal(r.binding.shotId, 's1');
  assert.equal(r.binding.assetVersionId, 'v3');
  assert.equal(buildShotAssetBinding({ shotId: 's1' }).ok, false);
});
