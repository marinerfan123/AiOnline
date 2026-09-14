'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateTree, typeSetForMode, NARRATIVE_TYPES } = require('./structureNode.cjs');

// Build a 10-shot narrative fixture: story > act > sequence > scene > shot.
function narrativeFixture(nShots = 10) {
  const nodes = [{ id: 'story1', parent_id: null, type: 'story', order_index: 0 }];
  nodes.push({ id: 'act1', parent_id: 'story1', type: 'act', order_index: 0 });
  nodes.push({ id: 'seq1', parent_id: 'act1', type: 'sequence', order_index: 0 });
  for (let s = 0; s < 3; s++) {
    const sid = `scene${s}`;
    nodes.push({ id: sid, parent_id: 'seq1', type: 'scene', order_index: s, label: `scene ${s}` });
    for (let i = 0; i < 4 && nodes.filter((x) => x.type === 'shot').length < nShots; i++) {
      const shotId = `shot-${s}-${i}`;
      nodes.push({ id: shotId, parent_id: sid, type: 'shot', order_index: i, shot_id: `row-${s}-${i}` });
    }
  }
  return nodes;
}

test('typeSetForMode maps modes to type sets', () => {
  assert.deepEqual(typeSetForMode('narrative'), NARRATIVE_TYPES);
  assert.deepEqual(typeSetForMode('advertising'), ['brief', 'concept', 'sequence', 'scene', 'shot']);
  assert.deepEqual(typeSetForMode('ecommerce'), ['product', 'selling_point', 'segment', 'scene', 'shot']);
  assert.deepEqual(typeSetForMode('other'), NARRATIVE_TYPES);
});

test('narrative tree with 10+ shots validates OK', () => {
  const nodes = narrativeFixture(10);
  assert.ok(nodes.filter((x) => x.type === 'shot').length >= 10);
  const r = validateTree(nodes, 'narrative');
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('disallowed type for mode rejected', () => {
  const nodes = narrativeFixture(3);
  nodes.push({ id: 'bad', parent_id: 'story1', type: 'product', order_index: 9 });
  const r = validateTree(nodes, 'narrative');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("not allowed for mode 'narrative'")));
});

test('illegal parent-child adjacency rejected', () => {
  const nodes = narrativeFixture(3);
  nodes.push({ id: 'seq-parent', parent_id: 'act1', type: 'sequence', order_index: 1 });
  nodes.push({ id: 'act-child', parent_id: 'seq-parent', type: 'act', order_index: 0 }); // act under sequence illegal
  const r = validateTree(nodes, 'narrative');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("cannot contain")));
});

test('shot node must converge on shotId', () => {
  const nodes = narrativeFixture(3);
  nodes.push({ id: 'shot-x', parent_id: 'scene0', type: 'shot', order_index: 99 }); // no shot_id
  const r = validateTree(nodes, 'narrative');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('must converge on a shotId')));
});

test('invalid order_index rejected', () => {
  const nodes = narrativeFixture(3);
  nodes[0].order_index = -1;
  const r = validateTree(nodes, 'narrative');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('invalid order_index')));
});

test('ad + ecommerce fixtures validate under their modes', () => {
  const ad = [
    { id: 'brief', parent_id: null, type: 'brief', order_index: 0 },
    { id: 'concept', parent_id: 'brief', type: 'concept', order_index: 0 },
    { id: 'sc0', parent_id: 'concept', type: 'scene', order_index: 0 },
    { id: 'sh0', parent_id: 'sc0', type: 'shot', order_index: 0, shot_id: 'x' },
  ];
  assert.equal(validateTree(ad, 'advertising').ok, true);
  const ec = [
    { id: 'prod', parent_id: null, type: 'product', order_index: 0 },
    { id: 'sp', parent_id: 'prod', type: 'selling_point', order_index: 0 },
    { id: 'seg', parent_id: 'sp', type: 'segment', order_index: 0 },
    { id: 'ec0', parent_id: 'seg', type: 'scene', order_index: 0 },
    { id: 'esh', parent_id: 'ec0', type: 'shot', order_index: 0, shot_id: 'y' },
  ];
  assert.equal(validateTree(ec, 'ecommerce').ok, true);
});
