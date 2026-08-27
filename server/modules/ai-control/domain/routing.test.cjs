'use strict';
/**
 * M02-A — Routing Decision (audit contract) tests.
 * Normalizes modelhub/router.routeBindings output into an auditable record.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDecisionId, toRoutingDecision } = require('./routing.cjs');

function fakeRouteResult() {
  return {
    chosen: { bindingId: 'b-1', modelId: 'kling-x', providerId: 'agnes', score: 0.82, components: { successRate: 0.9 }, reasons: ['成功率 0.90'] },
    ranking: [
      { bindingId: 'b-1', modelId: 'kling-x', providerId: 'agnes', score: 0.82, components: {} },
      { bindingId: 'b-2', modelId: 'kling-x', providerId: 'supplier-b', score: 0.71, components: {} },
    ],
    rejected: [{ bindingId: 'b-3', modelId: 'kling-x', providerId: 'dead', rejectedAt: 'circuitOk', rejectReason: '熔断开启' }],
    weights: { successRate: 0.3 }, seed: 1,
  };
}

test('routing: decision id is unique + prefixed', () => {
  const a = newDecisionId();
  const b = newDecisionId();
  assert.notEqual(a, b);
  assert.ok(a.startsWith('rd-'));
});

test('routing: toRoutingDecision captures selected + fallback + rejected + reason', () => {
  const d = toRoutingDecision(fakeRouteResult(), { model_id: 'kling-x', capability: 'video', now: 1000 });
  assert.equal(d.routing_decision_id.slice(0, 3), 'rd-');
  assert.equal(d.model_id, 'kling-x');
  assert.equal(d.capability, 'video');
  assert.equal(d.ts, 1000);
  assert.equal(d.selected.bindingId, 'b-1');
  assert.equal(d.selected.providerId, 'agnes');
  assert.equal(d.selected.score, 0.82);
  // fallback = ranking minus chosen
  assert.deepEqual(d.fallback_candidates.map((f) => f.bindingId), ['b-2']);
  assert.equal(d.rejected.length, 1);
  assert.equal(d.rejected[0].rejectedAt, 'circuitOk');
  assert.ok(d.reason.length > 0);
});

test('routing: no chosen → null selected + fallback = full ranking + reason says no eligible', () => {
  const d = toRoutingDecision(
    { chosen: null, ranking: [{ bindingId: 'b-9', modelId: 'm', providerId: 'p', score: 0.1 }], rejected: [{ bindingId: 'b-9', modelId: 'm', providerId: 'p', rejectedAt: 'rateLimitOk', rejectReason: '限流' }] },
    { model_id: 'm' }
  );
  assert.equal(d.selected, null);
  assert.equal(d.fallback_candidates.length, 1);
  assert.ok(/no eligible/.test(d.reason));
});

test('routing: empty result → null selected, empty lists, reason no candidates', () => {
  const d = toRoutingDecision({}, { model_id: 'm' });
  assert.equal(d.selected, null);
  assert.deepEqual(d.fallback_candidates, []);
  assert.deepEqual(d.rejected, []);
  assert.ok(/no candidates/.test(d.reason));
});

test('routing: decision never carries a credential', () => {
  const d = toRoutingDecision(fakeRouteResult(), { model_id: 'kling-x' });
  const s = JSON.stringify(d);
  assert.ok(!/sk-|api_key|credential|secret/i.test(s), 'no secret material in decision record');
});
