'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateCreativeBrief, sanitizeCreativeBrief, CREATIVE_BRIEF_FIELDS } = require('./creativeBrief.cjs');

test('valid creative brief passes', () => {
  const brief = {
    goal: 'Launch a 30s short drama teaser', audience: 'Gen-Z short-drama viewers',
    platform: 'douyin', duration: 30, aspect_ratio: '9:16', language: 'zh-CN',
    key_message: 'A story of second chances', cta: 'Follow to watch', brand: 'Acme Studio',
    tone: 'warm', style: 'cinematic', references: ['ref://board-1'], budget: 5000,
    deadline: '2026-10-01T00:00:00.000Z', deliverables: ['teaser', 'poster'], restrictions: ['no adult content'],
  };
  assert.equal(validateCreativeBrief(brief).ok, true);
});

test('missing required goal/audience rejected', () => {
  const r = validateCreativeBrief({ platform: 'douyin' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('goal')));
  assert.ok(r.errors.some((e) => e.includes('audience')));
});

test('unknown field rejected', () => {
  const r = validateCreativeBrief({ goal: 'x', audience: 'y', extra: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('extra')));
});

test('bad aspect_ratio / duration / deadline rejected', () => {
  const r = validateCreativeBrief({ goal: 'x', audience: 'y', aspect_ratio: 'invalid', duration: -5, deadline: 'not-a-date' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('aspect_ratio')));
  assert.ok(r.errors.some((e) => e.includes('duration')));
  assert.ok(r.errors.some((e) => e.includes('deadline')));
});

test('bad platform rejected; lowercase accepted', () => {
  assert.equal(validateCreativeBrief({ goal: 'x', audience: 'y', platform: 'tiktok' }).ok, true);
  assert.equal(validateCreativeBrief({ goal: 'x', audience: 'y', platform: 'nope' }).ok, false);
});

test('sanitize drops unknown keys, keeps know fields', () => {
  const out = sanitizeCreativeBrief({ goal: 'x', audience: 'y', secret: 'leak' });
  assert.deepEqual(Object.keys(out).sort(), ['audience', 'goal']);
  assert.equal(out.secret, undefined);
});

test('all W1-01 fields are enumerated', () => {
  for (const f of ['goal', 'audience', 'platform', 'duration', 'aspect_ratio', 'language', 'key_message', 'cta', 'brand', 'tone', 'style', 'references', 'budget', 'deadline', 'deliverables', 'restrictions']) {
    assert.ok(CREATIVE_BRIEF_FIELDS.includes(f), `missing field ${f}`);
  }
});
