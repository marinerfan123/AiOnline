'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateTimeline, validateClip, reorderClips } = require('./timeline.cjs');

test('validateTimeline requires project/workspace/name', () => {
  assert.equal(validateTimeline({ project_id: 'p1', workspace_id: 'w1', name: 't' }).ok, true);
  assert.equal(validateTimeline({ project_id: 'p1', name: 't' }).ok, false);
});

test('validateClip: track + positive duration', () => {
  assert.equal(validateClip({ track_id: 't1', start_ms: 0, duration_ms: 1000 }).ok, true);
  assert.equal(validateClip({ track_id: 't1', duration_ms: 0 }).ok, false);
  assert.equal(validateClip({ duration_ms: 1000 }).ok, false);
});

test('reorderClips dense per track by start_ms', () => {
  const clips = [
    { track_id: 't1', id: 'c1', order_index: 9, start_ms: 5000 },
    { track_id: 't1', id: 'c2', order_index: 0, start_ms: 1000 },
    { track_id: 't2', id: 'c3', order_index: 5, start_ms: 0 },
  ];
  const out = reorderClips(clips);
  const t1 = out.filter((c) => c.track_id === 't1').sort((a, b) => a.order_index - b.order_index);
  assert.equal(t1[0].id, 'c2');
  assert.equal(t1[0].order_index, 0);
  assert.equal(t1[1].order_index, 1);
  assert.equal(out.filter((c) => c.track_id === 't2')[0].order_index, 0);
});
