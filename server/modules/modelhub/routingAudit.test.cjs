'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildRoutingAuditRecord, persistRoutingAudit, selectRoutingAuditByGeneration } = require('./routingAudit.cjs');

const DECISION = { ok: true, chosen: 'b', candidates: [{ id: 'a', score: 2, reasons: ['x'] }, { id: 'b', score: 5, reasons: ['y'] }], reason: ['score:5.00'] };

test('buildRoutingAuditRecord captures selected/rejected/scores/reasons/timestamp', () => {
  const r = buildRoutingAuditRecord({ generationId: 'g1', decision: DECISION, policy: { maxBudget: 10 }, plan: 'pro', actor: 'u1' });
  assert.equal(r.selected, 'b');
  assert.deepEqual(r.rejected, ['a']);
  assert.equal(r.generationId, 'g1');
  assert.ok(r.timestamp);
});

test('-Infinity score projected to null (safe)', () => {
  const d = { chosen: null, candidates: [{ id: 'a', score: -Infinity, reasons: ['bad'] }], reason: 'NO_VIABLE_PROVIDER' };
  const r = buildRoutingAuditRecord({ generationId: 'g1', decision: d });
  assert.equal(r.candidates[0].score, null);
});

test('persistRoutingAudit SQL uses routing_audit (same-txn, no COMMIT)', () => {
  const record = buildRoutingAuditRecord({ generationId: 'g1', decision: DECISION });
  let sql = '';
  const client = { query: async (s) => { sql = s; return { rows: [] }; } };
  return persistRoutingAudit(client, record).then(() => {
    assert.ok(sql.includes('INSERT INTO routing_audit'));
    assert.ok(!sql.toLowerCase().includes('commit'));
  });
});

test('select by generation (replay/queryable)', () => {
  const sql = selectRoutingAuditByGeneration('g1');
  assert.ok(sql.includes('WHERE generation_id=$1'));
});
