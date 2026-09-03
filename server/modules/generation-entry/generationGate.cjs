'use strict';
/**
 * W1-08 — Generation-entry gate for Brief + DeliverySpec.
 *
 * Credit-safety gate: generation spends credits, so before ANY reserve/job is created we must
 * prove the project is generation-eligible (complete Creative Brief + DeliverySpec). When the
 * gate fails it returns machine-readable missing fields and the caller MUST NOT create a
 * reserve/job. Pure module (no I/O) for unit-testability + no-spend enforcement.
 */

const { validateCreativeBrief } = require('../project-foundation/creativeBrief.cjs');
const { validateDeliverySpec } = require('../project-foundation/deliverySpec.cjs');

// Field requirement paths (machine-readable, e.g. ['brief.goal', 'delivery_spec.aspect_ratio']).
const BRIEF_REQUIRED = ['goal', 'audience'];
const SPEC_REQUIRED = ['aspect_ratio', 'duration', 'platform'];

/** Evaluate generation eligibility. Returns {eligible, missing[]}. */
function evaluateEligibility({ brief, deliverySpec } = {}) {
  const missing = [];
  const briefOk = validateCreativeBrief(brief || {}).ok;
  if (!brief) missing.push('brief');
  for (const f of BRIEF_REQUIRED) {
    if (!brief || !brief[f] || (typeof brief[f] === 'string' && !brief[f].trim())) missing.push(`brief.${f}`);
  }
  for (const f of SPEC_REQUIRED) {
    const v = deliverySpec && deliverySpec[f];
    if (v === undefined || v === null || v === '') missing.push(`delivery_spec.${f}`);
  }
  const specOk = validateDeliverySpec(deliverySpec || {}, {}).ok; // ignore default-merge; eligibility reads raw fields
  return { eligible: missing.length === 0 && briefOk && specOk, missing };
}

module.exports = { evaluateEligibility, BRIEF_REQUIRED, SPEC_REQUIRED };
