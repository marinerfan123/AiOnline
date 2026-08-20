'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { GENERATION_V2_SCHEMA_SQL, applyGenerationV2Schema } = require('./schema.cjs');

test('V2 schema 定义父批次、单图子任务、单图账务 hold、attempt 与 outbox', () => {
  for (const table of [
    'generation_batches_v2',
    'generation_items_v2',
    'generation_item_attempts_v2',
    'generation_credit_holds_v2',
    'generation_outbox_v2',
  ]) {
    assert.match(GENERATION_V2_SCHEMA_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

test('V2 schema 保证批次幂等、单图序号、单图账务唯一', () => {
  assert.match(GENERATION_V2_SCHEMA_SQL, /UNIQUE\s*\(user_id, idempotency_key\)/i);
  assert.match(GENERATION_V2_SCHEMA_SQL, /UNIQUE\s*\(batch_id, item_index\)/i);
  assert.match(GENERATION_V2_SCHEMA_SQL, /item_id TEXT NOT NULL UNIQUE/i);
});

test('V2 item 状态覆盖排队、租约、上游不确定、上传与终态', () => {
  for (const status of [
    'queued', 'leased', 'generating', 'provider_accepted', 'reconciling',
    'generated', 'uploading', 'retry_wait', 'review_required',
    'done', 'failed', 'canceled',
  ]) {
    assert.ok(GENERATION_V2_SCHEMA_SQL.includes(`'${status}'`), `缺少 item 状态 ${status}`);
  }
});

test('V2 item 包含 lease fencing token 与可领取索引', () => {
  assert.match(GENERATION_V2_SCHEMA_SQL, /lease_version BIGINT NOT NULL DEFAULT 0/i);
  assert.match(GENERATION_V2_SCHEMA_SQL, /lease_expires_at TIMESTAMPTZ/i);
  assert.match(GENERATION_V2_SCHEMA_SQL, /CREATE INDEX IF NOT EXISTS idx_generation_items_v2_claim/i);
});

test('applyGenerationV2Schema 执行完整 schema SQL', async () => {
  const calls = [];
  const pg = { async query(sql) { calls.push(sql); return { rowCount: 0 }; } };
  await applyGenerationV2Schema(pg);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], GENERATION_V2_SCHEMA_SQL);
});
