'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveAndStoreSnapshot } = require('./continuityDerive.cjs');

/** pg double that dispatches on SQL keywords and records every call. */
function mockPg(opts = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO production_continuity_snapshots/.test(sql)) {
        if (opts.fkOnInsert) {
          const err = new Error('insert or update on table "shots" violates foreign key constraint "fk_..._shot"');
          err.code = '23503';
          throw err;
        }
        return { rowCount: 1 };
      }
      if (/FROM project_characters/.test(sql)) return { rows: opts.characters || [] };
      if (/FROM project_environments/.test(sql)) return { rows: opts.environments || [] };
      return { rows: [] }; // other SQL — never expected in this flow
    },
  };
}

const LUO = {
  id: 'c-1', name: 'Luo',
  canonical_appearance: { hair: 'black', coat: 'red' },
  wardrobe: { outfit: 'canonical A' },
  current_wardrobe: { coat: 'green' }, // real override wins
  voice: { pitch: 'low' },
};
const MEI = {
  id: 'c-2', name: 'Mei',
  canonical_appearance: {},
  wardrobe: { outfit: 'silk' }, // canonical fallback (current_wardrobe empty)
  current_wardrobe: {},
  voice: {},
};
const ALLEY = {
  id: 'e-1', name: 'Night Alley',
  lighting: { mood: 'neon' }, props: { sign: 'glow' }, time_of_day: 'night', palette: { hue: 'cyan' },
};

test('G14①: derive+store maps character/environment rows into states and upserts', async () => {
  const pg = mockPg({ characters: [LUO, MEI], environments: [ALLEY] });
  const res = await deriveAndStoreSnapshot(pg, {
    projectId: 'p-1', shotId: 's-1', characterIds: ['c-1', 'c-2'], environmentId: 'e-1', capturedBy: 'u-1',
  });

  assert.equal(res.ok, true);
  assert.equal(pg.calls.length, 3);
  // 1: characters SELECT scoped by project + id list
  assert.ok(/FROM project_characters/.test(pg.calls[0].sql));
  assert.deepEqual(pg.calls[0].params, ['p-1', ['c-1', 'c-2']]);
  // 2: environment SELECT scoped by id + project
  assert.ok(/FROM project_environments/.test(pg.calls[1].sql));
  assert.deepEqual(pg.calls[1].params, ['e-1', 'p-1']);
  // 3: INSERT with JSON states + provenance
  assert.ok(/INSERT INTO production_continuity_snapshots/.test(pg.calls[2].sql));
  const p = pg.calls[2].params;
  assert.equal(p[0], 's-1');
  assert.equal(p[1], 'p-1');
  assert.equal(p[2], 'narrative');
  assert.deepEqual(JSON.parse(p[3]), [
    // c-1: canonical_appearance → appearance; current_wardrobe (override) → wardrobe; voice passthrough
    { characterId: 'c-1', name: 'Luo', appearance: { hair: 'black', coat: 'red' }, wardrobe: { coat: 'green' }, voice: { pitch: 'low' } },
    // c-2: empty canonical_appearance → {}; empty current_wardrobe falls back to canonical `wardrobe`
    { characterId: 'c-2', name: 'Mei', appearance: {}, wardrobe: { outfit: 'silk' }, voice: {} },
  ]);
  assert.deepEqual(JSON.parse(p[4]), [
    { environmentId: 'e-1', name: 'Night Alley', lighting: { mood: 'neon' }, props: { sign: 'glow' }, timeOfDay: 'night', palette: { hue: 'cyan' } },
  ]);
  assert.equal(p[5], 'derive'); // source default
  assert.equal(p[6], 'u-1');    // capturedBy
});

test('G14①: characterIds empty + environmentId empty → 400 semantics, no SQL', async () => {
  const pg = mockPg();
  const res = await deriveAndStoreSnapshot(pg, { projectId: 'p-1', shotId: 's-1' }); // both defaults
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors, ['characterIds 或 environmentId 至少一个']);
  assert.equal(pg.calls.length, 0);
});

test('G14①: FK 23503 on shot upsert → SHOT_NOT_FOUND', async () => {
  const pg = mockPg({ characters: [LUO], environments: [ALLEY], fkOnInsert: true });
  const res = await deriveAndStoreSnapshot(pg, {
    projectId: 'p-1', shotId: 'ghost-shot', characterIds: ['c-1'], environmentId: 'e-1',
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SHOT_NOT_FOUND');
});

test('G14①: environment-only path derives env state with empty characterStates', async () => {
  const pg = mockPg({ environments: [ALLEY] }); // characterIds default []
  const res = await deriveAndStoreSnapshot(pg, {
    projectId: 'p-1', shotId: 's-2', environmentId: 'e-1',
  });

  assert.equal(res.ok, true);
  assert.equal(pg.calls.length, 2); // env SELECT + INSERT only — no characters query
  assert.ok(/FROM project_environments/.test(pg.calls[0].sql));
  assert.ok(/INSERT INTO production_continuity_snapshots/.test(pg.calls[1].sql));
  const p = pg.calls[1].params;
  assert.equal(p[3], '[]'); // character_states empty
  assert.deepEqual(JSON.parse(p[4]), [
    { environmentId: 'e-1', name: 'Night Alley', lighting: { mood: 'neon' }, props: { sign: 'glow' }, timeOfDay: 'night', palette: { hue: 'cyan' } },
  ]);
});

test('G14①: character ids matching no rows → empty-state snapshot still stored (miss is not an error)', async () => {
  const pg = mockPg(); // no characters, no environments
  const res = await deriveAndStoreSnapshot(pg, {
    projectId: 'p-1', shotId: 's-3', characterIds: ['ghost'], environmentId: null,
  });

  assert.equal(res.ok, true); // guard passed on characterIds; lookup miss just empties states
  assert.equal(pg.calls.length, 2); // characters SELECT + INSERT
  const p = pg.calls[1].params;
  assert.equal(p[3], '[]'); // character_states
  assert.equal(p[4], '[]'); // environment_states
});
