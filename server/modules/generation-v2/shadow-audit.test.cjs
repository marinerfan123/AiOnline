'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildShadowAudit, SHADOW_AUDIT_SQL } = require('./shadow-audit.cjs');

test('审计SQL按legacyTaskId关联旧任务并核对count/items/holds/金额', () => {
  assert.match(SHADOW_AUDIT_SQL, /request_payload->>'legacyTaskId'/);
  assert.match(SHADOW_AUDIT_SQL, /JOIN generation_tasks legacy/);
  assert.match(SHADOW_AUDIT_SQL, /COUNT\(DISTINCT i\.item_id\)/);
  assert.match(SHADOW_AUDIT_SQL, /COUNT\(DISTINCT h\.item_id\)/);
  assert.match(SHADOW_AUDIT_SQL, /SUM\(h\.amount\)/);
});

test('buildShadowAudit 汇总一致、缺失和错配', async () => {
  const rows = [
    { batch_id:'b1', legacy_task_id:'g1', legacy_count:4, requested_count:4, item_count:4, hold_count:4, hold_total:'200', reserved_total:'200' },
    { batch_id:'b2', legacy_task_id:'g2', legacy_count:4, requested_count:4, item_count:3, hold_count:3, hold_total:'150', reserved_total:'200' },
    { batch_id:'b3', legacy_task_id:null, legacy_count:null, requested_count:1, item_count:1, hold_count:1, hold_total:'50', reserved_total:'50' },
  ];
  const pg = { async query() { return { rows }; } };
  const report = await buildShadowAudit(pg, { sinceHours: 24 });
  assert.equal(report.total, 3);
  assert.equal(report.consistent, 1);
  assert.equal(report.mismatched, 1);
  assert.equal(report.missingLegacy, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.map(x => x.batchId), ['b2','b3']);
});

test('buildShadowAudit 空数据视为健康但标记sampled=0', async () => {
  const pg = { async query(sql, params) { assert.deepEqual(params, [6]); return { rows: [] }; } };
  const report = await buildShadowAudit(pg, { sinceHours: 6 });
  assert.equal(report.ok, true);
  assert.equal(report.sampled, 0);
});
