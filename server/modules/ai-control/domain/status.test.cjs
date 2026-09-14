'use strict';
/**
 * M02-A — Status Normalization tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JOB_STATES, normalizeStatus, isTerminal } = require('./status.cjs');

test('status: canonical enum is closed', () => {
  assert.deepEqual(JOB_STATES, ['QUEUED', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
});

test('status: common raw states normalize correctly', () => {
  assert.equal(normalizeStatus('queued'), 'QUEUED');
  assert.equal(normalizeStatus('pending'), 'QUEUED');
  assert.equal(normalizeStatus('waiting'), 'QUEUED');
  assert.equal(normalizeStatus('submitted'), 'SUBMITTED');
  assert.equal(normalizeStatus('in_progress'), 'PROCESSING');
  assert.equal(normalizeStatus('running'), 'PROCESSING');
  assert.equal(normalizeStatus('generating'), 'PROCESSING');
  assert.equal(normalizeStatus('completed'), 'SUCCEEDED');
  assert.equal(normalizeStatus('success'), 'SUCCEEDED');
  assert.equal(normalizeStatus('done'), 'SUCCEEDED');
  assert.equal(normalizeStatus('failed'), 'FAILED');
  assert.equal(normalizeStatus('error'), 'FAILED');
  assert.equal(normalizeStatus('canceled'), 'CANCELLED'); // one l
  assert.equal(normalizeStatus('cancelled'), 'CANCELLED'); // two l
});

test('status: provider-specific map overrides default', () => {
  const map = { weirdstate: 'SUCCEEDED' };
  assert.equal(normalizeStatus('weirdstate', map), 'SUCCEEDED');
});

test('status: unknown intermediate defaults to PROCESSING (never fabricates terminal)', () => {
  assert.equal(normalizeStatus('something-odd'), 'PROCESSING');
  assert.equal(isTerminal(normalizeStatus('something-odd')), false);
});

test('status: isTerminal only for SUCCEEDED/FAILED/CANCELLED', () => {
  assert.equal(isTerminal('SUCCEEDED'), true);
  assert.equal(isTerminal('FAILED'), true);
  assert.equal(isTerminal('CANCELLED'), true);
  assert.equal(isTerminal('PROCESSING'), false);
  assert.equal(isTerminal('QUEUED'), false);
});
