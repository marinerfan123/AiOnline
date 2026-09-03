'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getSnapshot, upsertSnapshot, removeSnapshot, resolveCharacter } = require('./continuityStore.cjs');

function mockPg(opts = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO production_continuity_snapshots/.test(sql)) return { rowCount: 1 };
      if (/DELETE FROM production_continuity_snapshots/.test(sql)) return { rowCount: opts.removed === false ? 0 : 1 };
      if (/FROM production_continuity_snapshots/.test(sql)) {
        return opts.snapshot ? { rows: [opts.snapshot] } : { rows: [] };
      }
      if (/FROM project_characters/.test(sql)) return { rows: opts.characters || [] };
      return { rows: [] };
    },
  };
}

test('G14: upsert validates before writing (bad record → ok:false, no INSERT)', async () => {
  const pg = mockPg();
  const r = await upsertSnapshot(pg, { record: { characterStates: 'nope' } });
  assert.equal(r.ok, false);
  assert.equal(pg.calls.length, 0);
});

test('G14: upsert writes row with JSON params (derive source default)', async () => {
  const pg = mockPg();
  const rec = { shot_id: 's-1', project_id: 'p-1', characterStates: [{ characterId: 'c-1', name: 'Luo' }], environmentStates: [] };
  const r = await upsertSnapshot(pg, { record: rec });
  assert.equal(r.ok, true);
  assert.equal(pg.calls.length, 1);
  assert.ok(pg.calls[0].sql.includes('ON CONFLICT (shot_id) DO UPDATE'));
  assert.deepEqual(pg.calls[0].params[3], JSON.stringify(rec.characterStates));
});

test('G14: getSnapshot round-trips a stored row (JSONB decoded)', async () => {
  const row = { shot_id: 's-1', project_id: 'p-1', mode: 'narrative', character_states: [{ characterId: 'c-1', name: 'Luo' }], environment_states: [], source: 'manual', captured_by: 'u-1', captured_at: '2026-09-03T00:00:00Z' };
  const pg = mockPg({ snapshot: row });
  const got = await getSnapshot(pg, { projectId: 'p-1', shotId: 's-1' });
  assert.equal(got.shot_id, 's-1');
  assert.deepEqual(got.characterStates, row.character_states);
  assert.equal(got.source, 'manual');
  assert.equal(got.capturedBy, 'u-1');
});

test('G14: getSnapshot miss → null', async () => {
  const got = await getSnapshot(mockPg(), { projectId: 'p-1', shotId: 'missing' });
  assert.equal(got, null);
});

test('G14: removeSnapshot reports removed', async () => {
  assert.equal((await removeSnapshot(mockPg(), { projectId: 'p-1', shotId: 's-1' })).removed, true);
  assert.equal((await removeSnapshot(mockPg({ removed: false }), { projectId: 'p-1', shotId: 's-1' })).removed, false);
});

test('G14: resolveCharacter — exact name wins over alias; alias matches via aliases array; none', async () => {
  const chars = [
    { id: 'c-1', name: 'Luo Zong', aliases: ['A-Luo', 'LZ'] },
    { id: 'c-2', name: 'Xiao Wu', aliases: ['XW'] },
  ];
  let r = await resolveCharacter(mockPg({ characters: chars }), { projectId: 'p-1', query: 'A-Luo' });
  assert.equal(r.resolution, 'alias');
  assert.equal(r.matches[0].characterId, 'c-1');
  assert.equal(r.matches[0].via, 'alias');
  r = await resolveCharacter(mockPg({ characters: chars }), { projectId: 'p-1', query: 'Luo Zong' });
  assert.equal(r.resolution, 'exact');
  assert.equal(r.matches.length, 1);
  r = await resolveCharacter(mockPg({ characters: chars }), { projectId: 'p-1', query: 'Ghost' });
  assert.equal(r.resolution, 'none');
  r = await resolveCharacter(mockPg({ characters: chars }), { projectId: 'p-1', query: '  ' });
  assert.equal(r.resolution, 'none');
});
