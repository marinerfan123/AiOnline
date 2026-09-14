'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { compilePrompt, COMPILER_VERSION } = require('./promptCompiler.cjs');
const { buildPromptIr } = require('./promptIr.cjs');

const IR = buildPromptIr({
  shot: { id: 's1', seq: 1, title: 'Opening', storyIntent: { synopsis: 'A hero rises' } },
  deliverySpec: { aspect_ratio: '9:16', resolution: '1080x1920', duration: 30, fps: 30, platform: 'douyin' },
  references: [{ type: 'character', name: 'Neo', role: 'hero' }, { type: 'style', name: 'neo-noir' }],
  camera: { lens: '35mm', angle: 'low', movement: 'slow dolly', shotSize: 'medium' },
});

test('compilePrompt: versioned + reproducible + golden snapshot (same IR -> same prompt+hash)', () => {
  const a = compilePrompt(IR);
  const b = compilePrompt(IR);
  assert.equal(a.ok, true);
  assert.equal(a.version, COMPILER_VERSION);
  assert.equal(a.deterministicHash, b.deterministicHash);
  assert.equal(a.prompt, b.prompt);
  assert.equal(a.sourceIrVersion, 1, 'records source IR version');
  assert.ok(a.prompt.includes('Subject') || a.prompt.includes('Story'));
});

test('golden snapshot: stable output shape/fields for a known IR', () => {
  const r = compilePrompt(IR, { capability: 'internal' });
  assert.match(r.prompt, /Title: Opening/);
  assert.match(r.prompt, /Story: A hero rises/);
  assert.match(r.prompt, /Camera: lens 35mm, angle low, movement slow dolly, shot size medium/);
  assert.match(r.prompt, /References: character Neo \(hero\); style neo-noir/);
  assert.match(r.prompt, /Spec: aspect 9:16, 1080x1920, 30s, 30fps, platform douyin/);
});

test('invalid capability rejected', () => {
  const r = compilePrompt(IR, { capability: 'vibe-engine' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_CAPABILITY');
  assert.equal(r.error.capability, 'vibe-engine');
});

test('invalid IR rejected', () => {
  const bad = buildPromptIr({ shot: { id: 's1' }, deliverySpec: {} });
  const r = compilePrompt(bad);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_IR');
});

test('reproducible: deterministicHash stable across calls', () => {
  const r1 = compilePrompt(IR).deterministicHash;
  const r2 = compilePrompt(IR).deterministicHash;
  assert.equal(r1, r2);
});
