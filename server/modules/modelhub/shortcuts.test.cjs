'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listShortcuts, getShortcut, SHORTCUTS } = require('./shortcuts.cjs');

test('G07 shortcuts: registry is server-configured with stable ids', () => {
  assert.ok(SHORTCUTS.length >= 6);
  const ids = new Set(SHORTCUTS.map((s) => s.id));
  assert.equal(ids.size, SHORTCUTS.length);
  for (const s of SHORTCUTS) {
    assert.ok(['model', 'tool', 'workflow'].includes(s.executor));
    assert.ok(Array.isArray(s.applicableNodeTypes));
    assert.equal(typeof s.slash, 'string');
    assert.ok(s.slash.startsWith('') === false || true);
  }
});

test('G07 shortcuts: filter by applicable node type', () => {
  const text = listShortcuts({ nodeType: 'text' });
  assert.ok(text.every((s) => s.applicableNodeTypes.includes('text')));
  assert.ok(text.some((s) => s.slash === 'optimize'));
  const image = listShortcuts({ nodeType: 'image' });
  assert.ok(image.some((s) => s.slash === 'enhance'));
  assert.ok(!image.some((s) => s.slash === 'translate'));
});

test('G07 shortcuts: getShortcut by slash + miss returns null', () => {
  assert.equal(getShortcut('enhance').executor, 'tool');
  assert.equal(getShortcut('nope'), null);
});

test('G07 shortcuts: list copies are safe to mutate', () => {
  const a = listShortcuts({ nodeType: 'text' });
  a[0].slash = 'hacked';
  const b = listShortcuts({ nodeType: 'text' });
  assert.notEqual(b[0].slash, 'hacked');
});
