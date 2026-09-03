'use strict';
/**
 * W3-03/W3-04 — Provider compiler adapters (image + video).
 * Take the compiled prompt (W3-02) + provider + delivery spec -> provider-specific request payload.
 * Pure module (no I/O); unknown provider -> INVALID_PROVIDER.
 */
const SUPPORTED_PROVIDERS = new Set(['amper', 'kling', 'genmo', 'openai', 'genny']);
const UNKNOWN = Symbol('unknown');

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

/** Video adapter: prompt -> {provider, payload} for video generation (duration/fps). */
function adaptVideo(compiledPrompt, { provider, deliverySpec = {}, model } = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) return { ok: false, error: { code: 'INVALID_PROVIDER', provider } };
  const dims = aspectDimensions(deliverySpec.aspect_ratio || deliverySpec.aspectRatio);
  const payload = {
    prompt: compiledPrompt.prompt,
    model: model || null,
    width: dims.width,
    height: dims.height,
    duration: deliverySpec.duration != null ? Number(deliverySpec.duration) : 5,
    fps: deliverySpec.fps != null ? Number(deliverySpec.fps) : 30,
    provider: 'video',
  };
  return { ok: true, provider, kind: 'video', payload };
}

module.exports = { adaptImage, adaptVideo, SUPPORTED_PROVIDERS };
