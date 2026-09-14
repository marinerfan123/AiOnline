'use strict';
/**
 * W3-03/W3-04 — Provider compiler adapters (image + video).
 * Take the compiled prompt (W3-02) + provider + delivery spec -> provider-specific request payload.
 * Pure module (no I/O); unknown provider -> INVALID_PROVIDER.
 */
const SUPPORTED_PROVIDERS = new Set(['amper', 'kling', 'genmo', 'openai', 'genny']);
const UNKNOWN = Symbol('unknown');

// Lazy, cycle-safe lookup of the model schema (modelSchema.cjs has no requires, so this
// cannot form an import cycle). If it is not readable, stay purely local and rely on
// options.maxDurationMs (default 60000) instead.
let normalizeCapabilities = null;
try {
  normalizeCapabilities = require('./modelSchema.cjs').normalizeCapabilities;
} catch {
  normalizeCapabilities = null;
}

function aspectDimensions(aspectRatio) {
  const map = { '9:16': { width: 720, height: 1280 }, '16:9': { width: 1280, height: 720 }, '1:1': { width: 1024, height: 1024 }, '4:3': { width: 1024, height: 768 } };
  return map[aspectRatio] || map['1:1'];
}

/** Image adapter: prompt -> {provider, payload} for image generation. */
function adaptImage(compiledPrompt, { provider, deliverySpec = {}, model } = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) return { ok: false, error: { code: 'INVALID_PROVIDER', provider } };
  const dims = aspectDimensions(deliverySpec.aspect_ratio || deliverySpec.aspectRatio);
  const resolution = deliverySpec.resolution;
  const parsedResolution = resolution ? /(\d+)x(\d+)/.exec(resolution) : null;
  const payload = {
    prompt: compiledPrompt.prompt,
    model: model || null,
    width: parsedResolution ? parseInt(parsedResolution[1], 10) : dims.width,
    height: parsedResolution ? parseInt(parsedResolution[2], 10) : dims.height,
    negative_prompt: deliverySpec.negative_prompt || null,
    n: 1,
    provider: 'image',
  };
  return { ok: true, provider, kind: 'image', payload };
}

/** Resolve the video duration cap (milliseconds): options override > model schema > default 60000. */
function resolveMaxDurationMs(model, options) {
  if (options && typeof options === 'object') {
    const o = Number(options.maxDurationMs);
    if (Number.isFinite(o) && o > 0) return o;
  }
  if (model && typeof model === 'object') {
    const caps = model.capabilities || model;
    const ms = normalizeCapabilities
      ? normalizeCapabilities(caps)['video.maxDurationMs']
      : caps['video.maxDurationMs'];
    const m = Number(ms);
    if (Number.isFinite(m) && m > 0) return m;
  }
  return 60000;
}

/** Video adapter: prompt -> {provider, payload} for video generation (duration/fps). */
function adaptVideo(compiledPrompt, { provider, deliverySpec = {}, model, options = {} } = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) return { ok: false, error: { code: 'INVALID_PROVIDER', provider } };

  // resolution (WxH, positive integers) overrides aspect; both absent -> default 1:1.
  const resolution = deliverySpec.resolution;
  let width;
  let height;
  if (resolution != null && resolution !== '') {
    const m = /^(\d+)x(\d+)$/.exec(String(resolution));
    if (!m || parseInt(m[1], 10) <= 0 || parseInt(m[2], 10) <= 0) {
      return { ok: false, error: { code: 'INVALID_RESOLUTION', resolution } };
    }
    width = parseInt(m[1], 10);
    height = parseInt(m[2], 10);
  } else {
    const dims = aspectDimensions(deliverySpec.aspect_ratio || deliverySpec.aspectRatio);
    width = dims.width;
    height = dims.height;
  }

  // duration: round to integer, then clamp against maxDurationMs (milliseconds).
  const maxDurationMs = resolveMaxDurationMs(model, options);
  let duration;
  if (deliverySpec.durationMs != null) {
    duration = Math.round(Number(deliverySpec.durationMs) / 1000);
  } else {
    duration = deliverySpec.duration != null ? Math.round(Number(deliverySpec.duration)) : 5;
  }
  const maxSeconds = Math.floor(maxDurationMs / 1000);
  if (duration > maxSeconds) duration = maxSeconds;

  const payload = {
    prompt: compiledPrompt.prompt,
    model: model || null,
    width,
    height,
    duration,
    fps: deliverySpec.fps != null ? Number(deliverySpec.fps) : 30,
    provider: 'video',
  };
  return { ok: true, provider, kind: 'video', payload };
}

module.exports = { adaptImage, adaptVideo, SUPPORTED_PROVIDERS };
