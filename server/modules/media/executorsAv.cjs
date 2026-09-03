'use strict';
/**
 * G06-AV — Audio/video media job executors (thumbnail / proxy / waveform),
 * complementing executors.cjs (probe). All runners shell out to `ffmpeg` with
 * an injectable spawn (tests pass an EventEmitter fake), collect stdout/stderr,
 * and resolve deterministically:
 *   exit 0                     → { ok:true,  result:{...} }
 *   spawn throws ENOENT        → { ok:false, code:'MEDIA_FFMPEG_UNAVAILABLE' }
 *   non-zero exit              → { ok:false, code:'MEDIA_<KIND>_FAILED', message }
 *   timeout (kill SIGKILL)     → { ok:false, code:'MEDIA_<KIND>_TIMEOUT', message }
 * Sources may be local paths or http(s) OSS URLs — passed straight to ffmpeg.
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|tiff?)$/i;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PROXY_WIDTH = 1280;
const DEFAULT_PROXY_FPS = 24;
const WAVEFORM_BUCKETS = 400;
const WAVEFORM_SAMPLE_RATE = 1000;
const WAVEFORM_CHANNELS = 1;

/** Last path segment without query/hash (safe for http(s) OSS URLs too). */
function basenameOf(source) {
  const s = String(source || '');
  const noQuery = s.split(/[?#]/)[0];
  const seg = noQuery.slice(noQuery.lastIndexOf('/') + 1).trim();
  return seg || '';
}

/** Detect whether an input is a still image by filename extension. */
function detectInputKind(source) {
  const name = basenameOf(source);
  return IMAGE_EXT_RE.test(name) ? 'image' : 'video';
}

function extOf(source) {
  const name = basenameOf(source);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function stemOf(source) {
  const name = basenameOf(source);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Default local output path derived from the source name (suffix + ext).
 *  With a jobId the file lands in /tmp/media-jobs/<jobId>/ so concurrent jobs
 *  with the same source basename never collide (audit MEDIUM-4 fix). */
function defaultOut(source, suffix, ext, jobId) {
  const stem = stemOf(source) || 'media';
  const name = `${stem}.${suffix}.${ext || 'jpg'}`;
  if (!jobId) return name;
  const dir = `/tmp/media-jobs/${String(jobId).replace(/[^\w.\-]/g, '_')}`;
  return `${dir}/${name}`;
}

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * ffmpeg args for a still thumbnail of an image or video input.
 * Image:  -vf scale=-2:512 → png/jpg
 * Video:  same scale plus '-frames:v 1' (single frame) → jpg
 * Returns { args, output, inputKind }.
 */
function buildThumbnailCommand({ source, outKey, jobId }) {
  const inputKind = detectInputKind(source);
  const imageExt = extOf(source);
  const output = outKey || defaultOut(source, 'thumb', inputKind === 'image' ? (imageExt || 'jpg') : 'jpg', jobId);
  const args = ['-y', '-i', String(source), '-vf', 'scale=-2:512'];
  if (inputKind === 'video') args.push('-frames:v', '1');
  args.push(output);
  return { args, output, inputKind };
}

/**
 * ffmpeg args for a browser-friendly mp4 proxy of a video input:
 * scale to ≤1280 wide (width override), 24 fps (fps override),
 * libx264 preset veryfast crf 23, yuv420p for player compatibility.
 * Returns { args, output, width, fps }.
 */
function buildProxyCommand({ source, outKey, width, fps, jobId }) {
  const w = clampInt(width, DEFAULT_PROXY_WIDTH, 2, 7680);
  const f = clampInt(fps, DEFAULT_PROXY_FPS, 1, 120);
  const output = outKey || defaultOut(source, 'proxy', 'mp4', jobId);
  const args = [
    '-y', '-i', String(source),
    '-vf', `scale=${w % 2 === 0 ? w : w - 1}:-2`,
    '-r', String(f),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    output,
  ];
  return { args, output, width: w % 2 === 0 ? w : w - 1, fps: f };
}

/**
 * ffmpeg args that decode the input to mono f32le PCM at 1000 Hz on stdout
 * (pipe:1) — raw samples are decoded in JS into peak buckets.
 * Returns { args, output: null }.
 */
function buildWaveformCommand({ source }) {
  const args = [
    '-y', '-i', String(source),
    '-f', 'f32le', '-ac', String(WAVEFORM_CHANNELS), '-ar', String(WAVEFORM_SAMPLE_RATE),
    'pipe:1',
  ];
  return { args, output: null };
}

/**
 * Split a f32le byte buffer into `buckets` peak buckets.
 * Bucket i covers samples [floor(n*i/B), floor(n*(i+1)/B)) so exactly B
 * buckets come back; non-finite samples are skipped (empty buckets → 0/0).
 * Returns { peaks, sampleCount } with peaks: [{ i, min, max }].
 */
function decodePeaks(buf, buckets = WAVEFORM_BUCKETS) {
  const byteLen = buf && buf.length ? buf.length : 0;
  const sampleCount = Math.floor(byteLen / 4);
  const peaks = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((sampleCount * i) / buckets);
    const end = Math.floor((sampleCount * (i + 1)) / buckets);
    let min = 0;
    let max = 0;
    let have = false;
    for (let j = start; j < end; j++) {
      const v = buf.readFloatLE(j * 4);
      if (!Number.isFinite(v)) continue;
      if (!have) {
        min = v;
        max = v;
        have = true;
      } else {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    peaks.push({ i, min, max });
  }
  return { peaks, sampleCount };
}

/**
 * Shared runner: spawn('ffmpeg', cmd.args), collect stdout/stderr, map the
 * outcome per the contract above. `makeResult(stdoutBuffer)` builds the
 * ok:true result payload (only runs on exit code 0).
 */
function runFfmpeg({ spawn = require('child_process').spawn, timeoutMs = DEFAULT_TIMEOUT_MS }, kind, cmd, makeResult) {
  return new Promise((resolve) => {
    const KIND = String(kind).toUpperCase();
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
      resolve({ ok: false, code: `MEDIA_${KIND}_TIMEOUT`, message: `${kind} ffmpeg did not finish within ${timeoutMs}ms` });
    }, timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const unavailable = (e) => ({ ok: false, code: 'MEDIA_FFMPEG_UNAVAILABLE', message: String((e && e.message) || e) });
    const failed = (e) => ({ ok: false, code: `MEDIA_${KIND}_FAILED`, message: String((e && e.message) || e).slice(0, 500) });

    let proc;
    try {
      // Ensure the output directory exists when a job-scoped path is used
      // (ffmpeg does not create parent dirs). No-op for pipe:1 waveform.
      const outPath = cmd && cmd.output ? String(cmd.output) : '';
      if (outPath.startsWith('/tmp/media-jobs/')) {
        const dir = outPath.slice(0, outPath.lastIndexOf('/'));
        try { require('node:fs').mkdirSync(dir, { recursive: true }); } catch (_e) { /* best-effort */ }
      }
      proc = spawn('ffmpeg', cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (e && e.code === 'ENOENT') return done(unavailable(e));
      return done(failed(e));
    }

    const outChunks = [];
    let err = '';
    proc.stdout.on('data', (d) => { outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); });
    proc.stderr.on('data', (d) => { err += Buffer.isBuffer(d) ? d.toString('utf8') : String(d); });
    proc.on('error', (e) => {
      if (e && e.code === 'ENOENT') return done(unavailable(e));
      return done(failed(e));
    });
    proc.on('close', (code) => {
      if (code !== 0) return done(failed(err || `ffmpeg exited with code ${code}`));
      let result;
      try {
        result = makeResult(Buffer.concat(outChunks));
      } catch (e) {
        return done(failed(e));
      }
      return done({ ok: true, result });
    });
  });
}

/** Thumbnail executor: { source, outKey?, spawn?, timeoutMs? } */
function runThumbnail(ctx = {}) {
  const cmd = buildThumbnailCommand(ctx);
  return runFfmpeg(ctx, 'thumbnail', cmd, () => ({ output: cmd.output, inputKind: cmd.inputKind }));
}

/** Proxy executor: { source, outKey?, width?, fps?, spawn?, timeoutMs? } */
function runProxy(ctx = {}) {
  const cmd = buildProxyCommand(ctx);
  return runFfmpeg(ctx, 'proxy', cmd, () => ({ output: cmd.output, width: cmd.width, fps: cmd.fps }));
}

/**
 * Waveform executor: { source, spawn?, timeoutMs? } — decodes pipe stdout
 * f32le (mono 1000 Hz) into 400 [{i,min,max}] peak buckets.
 */
function runWaveform(ctx = {}) {
  const cmd = buildWaveformCommand(ctx);
  return runFfmpeg(ctx, 'waveform', cmd, (stdout) => {
    const { peaks, sampleCount } = decodePeaks(stdout, WAVEFORM_BUCKETS);
    return {
      peaks,
      buckets: WAVEFORM_BUCKETS,
      sampleRate: WAVEFORM_SAMPLE_RATE,
      channels: WAVEFORM_CHANNELS,
      sampleCount,
      durationMs: sampleCount, // 1000 Hz → 1 sample per integer ms
    };
  });
}

module.exports = {
  buildThumbnailCommand,
  buildProxyCommand,
  buildWaveformCommand,
  runThumbnail,
  runProxy,
  runWaveform,
};
