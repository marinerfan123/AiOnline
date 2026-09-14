'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyMigration } = require('./migrate.cjs');

test('additive migration classifies additive', () => {
  const c = classifyMigration('ALTER TABLE shots ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;');
  assert.equal(c.kind, 'additive');
});

test('data migration (INSERT backfill) classifies data', () => {
  const c = classifyMigration('INSERT INTO users (id) VALUES (1);');
  assert.equal(c.kind, 'data');
});

test('DROP TABLE IF EXISTS (idempotent guard) is NOT destructive', () => {
  const c = classifyMigration('DROP TABLE IF EXISTS foo;');
  assert.equal(c.kind, 'additive');
  assert.equal(c.ops.length, 0);
});

test('DROP TABLE without guard IS destructive (non-destructive default)', () => {
  const c = classifyMigration('DROP TABLE foo;');
  assert.equal(c.kind, 'destructive');
  assert.ok(c.ops.includes('DROP TABLE'));
});

test('DROP COLUMN without IF EXISTS is destructive', () => {
  const c = classifyMigration('ALTER TABLE t DROP COLUMN c;');
  assert.equal(c.kind, 'destructive');
});

test('TRUNCATE is destructive', () => {
  const c = classifyMigration('TRUNCATE t;');
  assert.equal(c.kind, 'destructive');
});
