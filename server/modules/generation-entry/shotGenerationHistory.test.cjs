'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildShotGenerationHistory } = require('./shotGenerationHistory.cjs');

test('history: success -> committed/settled; tied to shot', () => {
  const ok = buildShotGenerationHistory({ shotId: 's1', generationId: 'g1', route: 'amper', model: 'genny', outcome: 'success', reserve: { reserveId: 'rs1' }, quoteAmount: 2.5 });
  assert.equal(ok.history.status, 'committed');
  assert.equal(ok.history.settlement, 'settled');
  assert.equal(ok.history.shotId, 's1');
  assert.equal(ok.history.amount, 2.5);
});

test('history: failure -> failed + error recorded; finalize release path', () => {
  const fail = buildShotGenerationHistory({ shotId: 's1', outcome: 'failure', reserve: { reserveId: 'rs1' }, error: 'boom' });
  assert.equal(fail.history.status, 'failed');
  assert.equal(fail.history.error, 'boom');
  assert.equal(fail.history.settlement, 'released');
});

test('history: canceled -> released', () => {
  const c = buildShotGenerationHistory({ shotId: 's1', outcome: 'canceled', reserve: { reserveId: 'rs1' } });
  assert.equal(c.history.status, 'released');
});

test('history requires shotId', () => {
  assert.equal(buildShotGenerationHistory({ outcome: 'success' }).ok, false);
});
