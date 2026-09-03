'use strict';
/**
 * W3-02 — Prompt Compiler core.
 * Compiles a Prompt IR (W3-01) into a versioned, reproducible provider prompt string, recording the
 * source IR + version. Pure module (no I/O); deterministic (same IR → same output + hash).
 */
const crypto = require('crypto');
const { IR_VERSION, validatePromptIr } = require('./promptIr.cjs');

const COMPILER_VERSION = 1;
// Capabilities the compiler can express. Anything else → INVALID_CAPABILITY.
const SUPPORTED = new Set(['amper', 'kling', 'genmo', 'openai', 'internal', 'genny']);

function pathCount(intent, references, camera) {
  let n = 0;
  for (const k of ['subject', 'action', 'mood', 'composition']) if (intent && intent[k]) n++;
  n += (references || []).length;
  if (camera && (camera.lens || camera.angle || camera.movement || camera.shotSize)) n++;
  return n;
}

/** Compile a Prompt IR into a provider prompt. Returns {ok, prompt?, version?} or {ok:false,error}. */
function compilePrompt(ir, { capability = 'internal' } = {}) {
  if (!SUPPORTED.has(capability)) {
    return { ok: false, error: { code: 'INVALID_CAPABILITY', capability, supported: [...SUPPORTED] } };
  }
  const v = validatePromptIr(ir);
  if (!v.ok) return { ok: false, error: { code: 'INVALID_IR', errors: v.errors } };
  const { shot, intent, camera, references, deliverySpec, continuity } = ir;

  const parts = [];
  if (shot && shot.title) parts.push(`Title: ${shot.title}`);
  if (shot && shot.storyIntent) parts.push(`Story: ${shot.storyIntent.synopsis || JSON.stringify(shot.storyIntent)}`);
  if (intent && intent.subject) parts.push(`Subject: ${intent.subject}`);
  if (intent && intent.action) parts.push(`Action: ${intent.action}`);
  if (intent && intent.mood) parts.push(`Mood: ${intent.mood}`);
  if (intent && intent.composition) parts.push(`Composition: ${intent.composition}`);
  if (intent && Array.isArray(intent.keyVisuals) && intent.keyVisuals.length) parts.push(`Key visuals: ${intent.keyVisuals.slice(0, 6).join(', ')}`);

  const cam = (ir.camera || {});
  const camBits = [];
  if (cam.lens) camBits.push(`lens ${cam.lens}`);
  if (cam.angle) camBits.push(`angle ${cam.angle}`);
  if (cam.movement) camBits.push(`movement ${cam.movement}`);
  if (cam.shotSize) camBits.push(`shot size ${cam.shotSize}`);
  if (camBits.length) parts.push(`Camera: ${camBits.join(', ')}`);

  const refs = (references || []).slice(0, 8).map((r) => {
    const b = `${r.type ? r.type + ' ' : ''}${r.name || ''}`.trim();
    return r.role ? `${b} (${r.role})` : b;
  });
  if (refs.length) parts.push(`References: ${refs.join('; ')}`);

  const sp = deliverySpec || {};
  const spBits = [];
  if (sp.aspectRatio) spBits.push(`aspect ${sp.aspectRatio}`);
  if (sp.resolution) spBits.push(`${sp.resolution}`);
  if (sp.duration) spBits.push(`${sp.duration}s`);
  if (sp.fps) spBits.push(`${sp.fps}fps`);
  if (sp.platform) spBits.push(`platform ${sp.platform}`);
  if (spBits.length) parts.push(`Spec: ${spBits.join(', ')}`);

  const cont = continuity || {};
  if (Array.isArray(cont.placeholders) && cont.placeholders.length) {
    parts.push(`Continuity: ${cont.placeholders.map((p) => `$${p.key || '?'} ${p.desc || ''}`.trim()).join('; ')}`);
  }

  const compiled = parts.join('\n').trim();
  const hash = crypto.createHash('sha256').update(compiled).digest('hex').slice(0, 16);
  return {
    ok: true,
    prompt: compiled,
    version: COMPILER_VERSION,
    sourceIrVersion: IR_VERSION,
    sourceIrHash: crypto.createHash('sha256').update(JSON.stringify(ir)).digest('hex').slice(0, 16),
    deterministicHash: hash,
    capability,
  };
}

module.exports = { compilePrompt, COMPILER_VERSION, SUPPORTED };
