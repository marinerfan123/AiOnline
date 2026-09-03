'use strict';
/**
 * G06 — Media metadata normalization (Blueprint 04 §16, master §15).
 * Pure functions: canonical metadata shape (integer milliseconds durations —
 * float seconds never enter the DB as the primary time unit), MIME→asset-kind
 * mapping, safe filename + upload MIME sniff policy helpers.
 */

/** Canonical probed metadata (04 §16). All durations integer ms. */
function normalizeMediaMeta(raw = {}) {
  const toMs = (seconds) => {
    if (typeof seconds === 'number' && Number.isFinite(seconds)) return Math.round(seconds * 1000);
    if (typeof seconds === 'string' && seconds.trim() !== '' && !Number.isNaN(Number(seconds))) {
      return Math.round(Number(seconds) * 1000);
    }
    return undefined;
  };
  const pickInt = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const fpsNum = pickInt(raw.fpsNum ?? raw.avg_frame_rate_num ?? raw.fps);
  const fpsDen = pickInt(raw.fpsDen ?? raw.avg_frame_rate_den ?? (raw.fps && Number.isFinite(raw.fps) ? 1000 : undefined));
  return {
    durationMs: pickInt(raw.durationMs) ?? toMs(raw.duration ?? raw.duration_seconds),
    width: pickInt(raw.width),
    height: pickInt(raw.height),
    fpsNum,
    fpsDen,
    videoCodec: raw.videoCodec || raw.codec_name || undefined,
    audioCodec: raw.audioCodec || raw.audio_codec || undefined,
    sampleRate: pickInt(raw.sampleRate ?? raw.sample_rate),
    channels: pickInt(raw.channels),
    colorPrimaries: raw.colorPrimaries || raw.color_primaries || undefined,
    transfer: raw.transfer || raw.color_transfer || undefined,
    rotation: pickInt(raw.rotation ?? raw.rotate),
  };
}

/** MIME sniff: map mime → asset kind; reject unknown with reason (24 §23 upload policy). */
function mimeToKind(mime, filename = '') {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return { kind: 'image', ok: true };
  if (m.startsWith('video/')) return { kind: 'video', ok: true };
  if (m.startsWith('audio/')) return { kind: 'audio', ok: true };
  if (m === 'text/plain' || m === 'application/json' || m === 'application/octet-stream') {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext === 'json') return { kind: 'text', ok: true };
    return { kind: 'other', ok: true };
  }
  return { kind: null, ok: false, reason: 'UNSUPPORTED_MIME' };
}

/** Safe file name: strip path separators/control chars, cap length. */
function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\.{2,}/g, '')
    .replace(/^[._]+/, '')
    .trim();
  return (cleaned || 'asset').slice(0, 180);
}

/** Integer-ms guard: the only accepted DB time form. */
function assertIntegerMs(v) {
  if (v === undefined || v === null) return true;
  return Number.isInteger(v) && v >= 0;
}

module.exports = { normalizeMediaMeta, mimeToKind, safeFileName, assertIntegerMs };
