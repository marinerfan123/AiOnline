'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { adaptLegacyCharacter, validateCharacter } = require('./character.cjs');

test('legacy adapter maps old fields to current shape (non-destructive defaults)', () => {
  const c = adaptLegacyCharacter({ id: 'c1', project_id: 'p1', name: 'Neo', appearance: { eyes: 'green' }, wardrobe: { top: 'coat' } });
  assert.equal(c.id, 'c1');
  assert.equal(c.project_id, 'p1');
  assert.equal(c.name, 'Neo');
  assert.deepEqual(c.canonical_appearance, { eyes: 'green' });
  assert.deepEqual(c.current_wardrobe, {});
  assert.deepEqual(c.reference_ids, []);
});

test('legacy adapter accepts old key names + string-encoded references', () => {
  const c = adaptLegacyCharacter({ char_id: 'c2', projectId: 'p2', display_name: 'Trinity', references: 'r1,r2' });
  assert.equal(c.id, 'c2');
  assert.equal(c.project_id, 'p2');
  assert.equal(c.name, 'Trinity');
  assert.deepEqual(c.reference_ids, ['r1', 'r2']);
});

test('legacy adapter never throws on empty', () => {
  const c = adaptLegacyCharacter();
  assert.equal(c.id, undefined);
  assert.equal(c.name, '');
});

test('validateCharacter requires workspace/project scope', () => {
  assert.equal(validateCharacter({ name: 'x' }).ok, false);
  const w = validateCharacter({ workspace_id: 'w1', project_id: 'p1', name: 'Neo' });
  assert.equal(w.ok, true);
});

test('validateCharacter: canonical_appearance must be a JSON object', () => {
  const r = validateCharacter({ workspace_id: 'w1', project_id: 'p1', name: 'Neo', canonical_appearance: [1, 2] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('canonical_appearance')));
});

test('validateCharacter: reference_ids must be an array', () => {
  const r = validateCharacter({ workspace_id: 'w1', project_id: 'p1', name: 'Neo', reference_ids: 'bad' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('reference_ids')));
});
