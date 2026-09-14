'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runShadowMigration } = require('./migrate-shadow.cjs');

test('影子迁移在事务中执行schema并记录版本', async () => {
  const calls = [];
  const pg = { async query(sql, params = []) { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
  const result = await runShadowMigration(pg);
  assert.equal(result.version, 'generation-v2-001');
  assert.match(calls[0].sql, /BEGIN/);
  assert.ok(calls.some((c) => /CREATE TABLE IF NOT EXISTS generation_batches_v2/.test(c.sql)));
  assert.ok(calls.some((c) => /INSERT INTO generation_schema_versions/.test(c.sql)));
  assert.match(calls.at(-1).sql, /COMMIT/);
});

test('影子迁移失败会ROLLBACK', async () => {
  const calls = [];
  const pg = { async query(sql) { calls.push(sql); if (/generation_batches_v2/.test(sql)) throw new Error('ddl failed'); return { rows: [] }; } };
  await assert.rejects(() => runShadowMigration(pg), /ddl failed/);
  assert.ok(calls.some((sql) => /ROLLBACK/.test(sql)));
});
