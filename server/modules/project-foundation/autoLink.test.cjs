'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveToken, resolvePromptTokens } = require('./autoLink.cjs');

function makePg(rows) {
  return {
    async query(sql, params) {
      if (sql.includes('FROM project_characters')) return { rows: rows.characters || [] };
      if (sql.includes('FROM project_references')) return { rows: rows.references || [] };
      return { rows: [] };
    },
  };
}

const ALICE = { id: 'ch-1', name: 'Alice' };
const CAFE = { id: 'rf-1', name: 'Cafe', type: 'environment' };
const CAFE2 = { id: 'rf-2', name: 'Cafe', type: 'environment' };

test('G07 autoLink: exact character match → exact binding', async () => {
  const pg = makePg({ characters: [ALICE] });
  const r = await resolveToken(pg, { projectId: 'p1', token: 'Alice' });
  assert.equal(r.resolution, 'exact');
  assert.equal(r.binding.entityType, 'character');
  assert.equal(r.binding.entityId, 'ch-1');
  assert.equal(r.binding.source, 'autolink');
});

test('G07 autoLink: contains-only match → semantic with confidence', async () => {
  const pg = makePg({ characters: [ALICE] });
  const r = await resolveToken(pg, { projectId: 'p1', token: 'Alic' });
  assert.equal(r.resolution, 'semantic');
  assert.equal(r.confidence, 0.6);
});

test('G07 autoLink: ambiguity surfaces candidates, never silent binding', async () => {
  const pg = makePg({ references: [CAFE, CAFE2] });
  const r = await resolveToken(pg, { projectId: 'p1', token: 'Cafe' });
  assert.equal(r.resolution, 'ambiguous');
  assert.equal(r.candidates.length, 2);
  assert.ok(r.binding === undefined);
});

test('G07 autoLink: no match → none (never bound)', async () => {
  const pg = makePg({ characters: [], references: [] });
  const r = await resolveToken(pg, { projectId: 'p1', token: 'Nobody' });
  assert.equal(r.resolution, 'none');
});

test('G07 autoLink: prompt resolution returns every @token with range', async () => {
  const pg = makePg({ characters: [ALICE], references: [CAFE] });
  const out = await resolvePromptTokens(pg, { projectId: 'p1', text: '让 @Alice 坐在 @Cafe' });
  assert.equal(out.length, 2);
  assert.equal(out[0].binding.entityId, 'ch-1');
  assert.equal(out[1].binding.entityId, 'rf-1');
  assert.equal(out[0].token, 'Alice');
});

test('G07 autoLink: reference type maps to entityType', async () => {
  const pg = makePg({ references: [{ id: 'rf-9', name: 'Vintage', type: 'style' }] });
  const r = await resolveToken(pg, { projectId: 'p1', token: 'Vintage' });
  assert.equal(r.resolution, 'exact');
  assert.equal(r.binding.entityType, 'style');
});
