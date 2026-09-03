'use strict';
/**
 * G06 — Media job executors (Blueprint 03 §24, 04 §16).
 * Deterministic runners for media_jobs kinds. `probe` is implemented via
 * ffprobe JSON (injectable spawn for tests). Other kinds register their
 * contract; executors that need binaries not yet present on the host return a
 * deterministic MEDIA_*_UNAVAILABLE code (never a fake success).
 */
const { normalizeMediaMeta } = require('./mediaMeta.cjs');

function runProbe({ source, spawn = require('child_process').spawn, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, code: e.code === 'ENOENT' ? 'MEDIA_PROBE_UNAVAILABLE' : 'MEDIA_PROBE_FAILED', message: e.message });
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* noop */ } }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: e.code === 'ENOENT' ? 'MEDIA_PROBE_UNAVAILABLE' : 'MEDIA_PROBE_FAILED', message: e.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, code: 'MEDIA_PROBE_FAILED', message: (err || `exit ${code}`).slice(0, 500) });
      try {
        const json = JSON.parse(out);
        const streams = Array.isArray(json.streams) ? json.streams : [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');
        const meta = normalizeMediaMeta({
          duration: json.format && json.format.duration,
          width: video && video.width,
          height: video && video.height,
          fpsNum: video && video.avg_frame_rate && video.avg_frame_rate.split('/')[0],
          fpsDen: video && video.avg_frame_rate && video.avg_frame_rate.split('/')[1],
          videoCodec: video && video.codec_name,
          audioCodec: audio && audio.codec_name,
          sampleRate: audio && audio.sample_rate,
          channels: audio && audio.channels,
          rotation: video && video.rotation,
        });
        return resolve({ ok: true, result: { format: json.format, meta } });
      } catch (e) {
        return resolve({ ok: false, code: 'MEDIA_PROBE_PARSE', message: e.message });
      }
    });
  });
}

/** Executor registry: kind → runner (others pending until binary/infra gate). */
const EXECUTORS = {
  probe: runProbe,
  thumbnail: null,
  proxy: null,
  waveform: null,
  transcode: null,
  frame_extract: null,
  render: null,
};

function execute(kind, ctx) {
  const fn = EXECUTORS[kind];
  if (!fn) return Promise.resolve({ ok: false, code: `MEDIA_${kind.toUpperCase().replace('_', '_')}_EXECUTOR_PENDING`, message: `${kind} executor not yet wired (infra gate)` });
  return fn(ctx);
}

module.exports = { runProbe, EXECUTORS, execute };
