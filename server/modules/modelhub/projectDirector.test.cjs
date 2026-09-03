'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { proposeActions } = require('./projectDirector.cjs');

test('empty narrative project -> propose shot leaf + seed shots', () => {
  const r = proposeActions({ projectType: 'narrative', structure: [], shots: [] });
  assert.equal(r.ok, true);
  assert.ok(r.proposals.some((p) => p.type === 'CREATE_STRUCTURE_SHOT_LEAF'));
  assert.ok(r.proposals.some((p) => p.type === 'SEED_SHOTS'));
});

test('structure with shot leaf + existing shots -> no seed/shot-leaf proposals', () => {
  const r = proposeActions({ projectType: 'narrative', structure: [{ id: 'n1', type: 'shot', order_index: 0 }], shots: [{ id: 's1' }] });
  const types = r.proposals.map((p) => p.type);
  assert.ok(!types.includes('SEED_SHOTS'));
  assert.ok(!types.includes('CREATE_STRUCTURE_SHOT_LEAF'));
});

test('characters without continuity -> APPLY_CONTINUITY', () => {
  const r = proposeActions({ projectType: 'narrative', structure: [{ type: 'shot' }], shots: [{ id: 's1' }], references: [{ type: 'character', id: 'c1' }] });
  assert.ok(r.proposals.some((p) => p.type === 'APPLY_CONTINUITY' && p.characters.includes('c1')));
});
