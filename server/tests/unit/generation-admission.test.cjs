'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUserActiveLimit, checkUserGenerationCapacity } = require('../../generation-admission.cjs');

test('generation admission clamps configured per-user active limit', () => {
  assert.equal(resolveUserActiveLimit({ GEN_USER_MAX_ACTIVE: '8' }), 8);
  assert.equal(resolveUserActiveLimit({ GEN_USER_MAX_ACTIVE: '0' }), 8);
  assert.equal(resolveUserActiveLimit({ GEN_USER_MAX_ACTIVE: '999' }), 64);
});

test('generation admission rejects users already at active limit', async () => {
  const pg = { lastSql: '', query: async (sql) => { pg.lastSql = sql; return { rows: [{ active: '8' }] }; } };
  assert.deepEqual(await checkUserGenerationCapacity(pg, 'u1', 8), { allowed: false, active: 8, limit: 8 });
  assert.match(pg.lastSql, /status IN \('running','waiting'\)/);
  assert.match(pg.lastSql, /user_id=\$1/);
});

test('generation admission allows users below active limit', async () => {
  const pg = { query: async () => ({ rows: [{ active: '7' }] }) };
  assert.deepEqual(await checkUserGenerationCapacity(pg, 'u1', 8), { allowed: true, active: 7, limit: 8 });
});
