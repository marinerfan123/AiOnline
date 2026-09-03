'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { enqueueWithinTxn, claimReady, markDelivered, markFailed } = require('./outboxWrapper.cjs');

// Use a real in-memory fake: a pg client that runs the actual statements against the real
// generation_outbox via the test DB is heavy; here we assert SQL shape + idempotency semantics.
function fakeClient({ conflicts = {} } = {}) {
  const rows = [];
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      // idempotent path keyed on the ON CONFLICT return
      if (sql.includes('ON CONFLICT')) {
        if (conflicts[params[1]]) return { rows: [], rowCount: 0 };
        rows.push({ id: params[0] });
        return { rows: rows.slice(-1), rowCount: 1 };
      }
      if (sql.includes('SELECT id FROM event_outbox WHERE idempotency_key')) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (sql.includes("status='delivering'")) return { rows: [{ id: 'e1', envelope: { in: 'x' }, delivery_attempts: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

const ENV = { id: 'ev1', type: 'shot.updated', actor: { id: 'u' }, object: { id: 's1', type: 'shot' }, workspace: 'w1', project: 'p1', timestamp: 'now', metadata: {} };

test('enqueue uses same-transaction INSERT (no COMMIT) with JSON envelope', async () => {
  const { client, calls } = fakeClient();
  await enqueueWithinTxn(client, { id: 'ev1', idempotencyKey: 'ik1', envelope: ENV });
  const ins = calls.find((c) => c.sql.includes('INSERT INTO event_outbox'));
  assert.ok(ins, 'an INSERT ran');
  assert.ok(ins.sql.includes('event_outbox'));
  assert.ok(!ins.sql.toLowerCase().includes('commit'), 'enqueue does not commit (caller owns txn)');
  assert.ok(ins.params[2] === JSON.stringify(ENV), 'envelope persisted as JSON');
  assert.ok(ins.params[0] === 'ev1' && ins.params[1] === 'ik1');
});

test('duplicate idempotency_key is a no-op (ON CONFLICT DO NOTHING)', async () => {
  const { client, calls } = fakeClient({ conflicts: { ik1: true } });
  const r = await enqueueWithinTxn(client, { id: 'ev1', idempotencyKey: 'ik1', envelope: ENV });
  assert.equal(r.idempotent, true);
});

test('claimReady skips non-due / selects ready with SKIP LOCKED + attempts bump', async () => {
  const { client, calls } = fakeClient();
  await claimReady(client, { limit: 10 });
  const cl = calls.find((c) => c.sql.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(cl, 'claim uses SKIP LOCKED + FOR UPDATE');
  assert.ok(/status IN \('pending','failed'\)/i.test(cl.sql));
  assert.ok(/delivery_attempts = delivery_attempts \+ 1/i.test(cl.sql));
  assert.equal(cl.params[0], 10);
});

test('markDelivered / markFailed manage retry state', async () => {
  const { client, calls } = fakeClient();
  await markDelivered(client, 'e1');
  const d = calls.find((c) => c.sql.includes(`status='delivered'`));
  assert.ok(d && d.sql.includes('delivered_at'));
  await markFailed(client, { id: 'e2', error: 'boom', nextAttemptAt: new Date(Date.now() + 60000) });
  const f = calls.find((c) => c.sql.includes(`status='failed'`));
  assert.ok(f && f.sql.includes('next_attempt_at') && f.sql.includes('last_error'));
});
