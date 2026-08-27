'use strict';
/**
 * M02-A — Provider Health Model tests (5-state derivation).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { HEALTH_STATES, deriveHealth } = require('./health.cjs');

test('health: state enum is closed at 5', () => {
  assert.deepEqual(HEALTH_STATES, ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY', 'DISABLED']);
});

test('health: disabled provider wins over everything', () => {
  assert.equal(deriveHealth({ enabled: false, circuit: 'CLOSED', successRate: 1 }).state, 'DISABLED');
});

test('health: OPEN circuit / connectivity fail / low successRate → UNHEALTHY', () => {
  assert.equal(deriveHealth({ enabled: true, circuit: 'OPEN' }).state, 'UNHEALTHY');
  assert.equal(deriveHealth({ enabled: true, connectivity: 'fail' }).state, 'UNHEALTHY');
  assert.equal(deriveHealth({ enabled: true, successRate: 0.2 }).state, 'UNHEALTHY');
  assert.equal(deriveHealth({ enabled: true, consecutiveFailures: 5 }).state, 'UNHEALTHY');
});

test('health: mid successRate / high latency / rate limited / half-open → DEGRADED', () => {
  assert.equal(deriveHealth({ enabled: true, circuit: 'HALF_OPEN' }).state, 'DEGRADED');
  assert.equal(deriveHealth({ enabled: true, successRate: 0.7 }).state, 'DEGRADED');
  assert.equal(deriveHealth({ enabled: true, p95LatencyMs: 45000 }).state, 'DEGRADED');
  assert.equal(deriveHealth({ enabled: true, rateLimited: true }).state, 'DEGRADED');
  assert.equal(deriveHealth({ enabled: true, keyAvailability: 0.3 }).state, 'DEGRADED');
});

test('health: good signals → HEALTHY', () => {
  const h = deriveHealth({ enabled: true, circuit: 'CLOSED', successRate: 0.99, p95LatencyMs: 2000, keyAvailability: 1 });
  assert.equal(h.state, 'HEALTHY');
  assert.deepEqual(h.reasons, []);
});

test('health: no signals → UNKNOWN', () => {
  assert.equal(deriveHealth({ enabled: true }).state, 'UNKNOWN');
  assert.equal(deriveHealth({}).state, 'UNKNOWN');
});

test('health: UNHEALTHY outranks DEGRADED (both present)', () => {
  const h = deriveHealth({ enabled: true, circuit: 'OPEN', rateLimited: true });
  assert.equal(h.state, 'UNHEALTHY');
  assert.ok(h.reasons.length >= 2);
});
