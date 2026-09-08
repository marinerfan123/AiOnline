'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSingleFlight } = require('../../single-flight.cjs');

test('single-flight skips overlapping ticks and allows the next tick after completion', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = createSingleFlight(async () => { calls += 1; await gate; return calls; });

  const first = run();
  const overlap = await run();
  assert.deepEqual(overlap, { skipped: true });
  assert.equal(calls, 1);

  release();
  assert.equal(await first, 1);
  assert.equal(await run(), 2);
});
