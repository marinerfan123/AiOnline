'use strict';
/**
 * M05-D1 — TEST-ONLY deterministic fake executors for the Studio Run engine.
 *
 * This module is wired exclusively through explicit dependency injection
 * (`createStudioExecutorRegistry({ executors: {...} })`) inside the test
 * harness. It is never referenced by production code paths and never
 * activated by environment state.
 *
 * Behaviors available (all deterministic):
 *  - success with optional fixed delay
 *  - fail the first N attempts (then succeed)
 *  - permanent failure
 *  - simulated timeout (executor outlives its lease)
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testExecutor(options = {}) {
  const { delayMs = 0, failFirstN = 0, permanentFail = false, code = 'TEST_FAILURE', resultValue = null, record = null } = options;
  let attempts = 0;
  return {
    kind: 'test-fake',
    async execute(ctx) {
      if (record) record.push({ nodeId: ctx.nodeId, attempt: ctx.attempt, at: Date.now() });
      attempts += 1;
      if (delayMs > 0) await sleep(delayMs);
      if (permanentFail) {
        throw Object.assign(new Error(`simulated permanent failure: ${code}`), { code, retryable: false });
      }
      if (attempts <= failFirstN) {
        throw Object.assign(new Error(`simulated transient failure ${attempts}/${failFirstN}`), { code: 'TEST_TRANSIENT', retryable: true });
      }
      const value = resultValue !== null ? resultValue : { testValue: `ok-${ctx.nodeId}`, attempt: attempts };
      return { ok: true, result: value };
    },
  };
}

/** An executor that never finishes — simulates a crashed/hung worker. */
function hangExecutor() {
  return {
    kind: 'test-hang',
    async execute() {
      await new Promise(() => {}); // never resolves; lease must expire
    },
  };
}

module.exports = { testExecutor, hangExecutor, sleep };
