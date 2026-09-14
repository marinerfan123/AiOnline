'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { recordAuditWithinTxn, validateAudit } = require('./audit.cjs');

function fakeClient() {
  const calls = [];
  return { client: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; } }, calls };
}

test('record audit: complete actor/workspace/object/before/after/action in same txn (no COMMIT)', async () => {
  const { client, calls } = fakeClient();
  const r = await recordAuditWithinTxn(client, { actor: 'u1', workspaceId: 'w1', action: 'shot.update', objectType: 'shot', objectId: 's1', before: { seq: 1 }, after: { seq: 2 } });
  const ins = calls.find((c) => c.sql.includes('INSERT INTO business_audit'));
  assert.ok(ins, 'INSERT ran');
  assert.ok(!ins.sql.toLowerCase().includes('commit'), 'does not COMMIT (caller owns txn)');
  assert.equal(ins.params[0], r.id);
  assert.equal(ins.params[1], 'u1');
  assert.equal(ins.params[2], 'w1');
  assert.equal(ins.params[4], 'shot');
  assert.deepEqual(JSON.parse(ins.params[6]), { seq: 1 }); // before
  assert.deepEqual(JSON.parse(ins.params[7]), { seq: 2 }); // after
});

test('audit completeness: every critical action must carry actor/action/objectType/objectId', () => {
  assert.equal(validateAudit({ actor: 'u1', action: 'x', objectType: 'shot' }).ok, false); // missing objectId
  assert.equal(validateAudit({ actor: 'u1', action: 'x' }).ok, false);
  const ok = validateAudit({ actor: 'u1', action: 'shot.update', objectType: 'shot', objectId: 's1' });
  assert.equal(ok.ok, true);
});
