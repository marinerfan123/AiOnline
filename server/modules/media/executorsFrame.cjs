'use strict';
/**
 * G12-frame — Frame-extraction executor (single still from a video at a
 * timestamp), the sibling of executorsAv.cjs (G06) and executorsStitch.cjs
 * (G11). Shells out to `ffmpeg` with an injectable spawn (tests pass an
 * EventEmitter fake), collects stderr, resolves deterministically:
 *   exit 0                     → { ok:true,  result:{ output } }
 *   spawn throws/emits ENOENT  → { ok:false, code:'MEDIA_FFMPEG_UNAVAILABLE' }
 *   non-zero exit              → { ok:false, code:'MEDIA_FRAME_FAILED', message }
 *   timeout (kill SIGKILL)     → { ok:false, code:'MEDIA_FRAME_TIMEOUT', message }
 *   missing/empty source       → { ok:false, code:'MEDIA_SOURCE_MISSING' }
 *
 * Fast seek is used: the seek lands BEFORE -i so ffmpeg seeks the container
 * rather than decoding from 0:
 *   ffmpeg -y -ss 0.500 -i source -frames:v 1 -q:v 2 out.png
 * timeMs is validated as an integer ≥ 0 and rendered as seconds with exactly
 * 3 decimals ((ms / 1000).toFixed(3)) — 500 → "0.500". Outputs default into
 * the caller's jobDir (created on demand) so concurrent jobs stay isolated.
 */

const { assertSafeOutputPath, sanitizeJobScope } = require('./executorsPathGuard.cjs');

const DEFAULT_TIMEOUT_MS = 15000;

/** Integer milliseconds → ffmpeg seconds with exactly 3 decimals (500→"0.500"). */
function msToSeconds(ms) {
  return (ms / 1000).toFixed(3);
}

/** Last path segment without query/hash (safe for http(s) OSS URLs too). */
function basenameOf(source) {
  const s = String(source || '');
  const noQuery = s.split(/[?#]/)[0];
  const seg = noQuery.slice(noQuery.lastIndexOf('/') + 1).trim();
  return seg || '';
}

function stemOf(source) {
  const name = basenameOf(source);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Default output when no outKey is given. Frames are per-timestamp, so the
 * ms is embedded in the name (clip.mp4 @ 500ms → clip.frame.500ms.png) — two
 * frames of the same source never overwrite each other. Honors an explicit
 * jobDir first, else the AV convention /tmp/media-jobs/<jobId>/.
 */
function defaultOutKey(source, timeMs, jobDir, jobId) {
  const stem = stemOf(source) || 'frame';
  const name = `${stem}.frame.${String(timeMs)}ms.png`;
  if (jobDir) return `${sanitizeJobScope(jobDir)}/${name}`;
  if (jobId) return `/tmp/media-jobs/${sanitizeJobScope(jobId)}/${name}`;
  return name;
}

/**
 * ffmpeg args for a single still frame: fast-seek `-ss <seconds>` before -i,
 * grab exactly one video frame, JPEG-grade quality scale. Returns
 * { args, output, timeMs, seconds }.
 * Throws on structural violations: missing source, or timeMs not an
 * integer ≥ 0.
 */
function buildFrameCommand({ source, timeMs, outKey, jobDir, jobId } = {}) {
  if (typeof source !== 'string' || String(source).trim().length === 0) {
    throw new Error('frame requires a source');
  }
  if (!Number.isInteger(timeMs) || timeMs < 0) {
    throw new Error(`frame timeMs must be an integer ≥ 0 (got ${timeMs})`);
  }
  const seconds = msToSeconds(timeMs);
  const output =
    typeof outKey === 'string' && outKey.length > 0
      ? outKey
      : defaultOutKey(source, timeMs, jobDir, jobId);
  assertSafeOutputPath(output, 'frame output path');
  const args = [
    '-y',
    '-ss', seconds,
    '-i', String(source),
    '-frames:v', '1',
    '-q:v', '2',
    output,
  ];
  return { args, output, timeMs, seconds };
}

/**
 * Shared runner mirroring executorsAv/executorsStitch.runFfmpeg (kind 'frame'):
 * spawn('ffmpeg', cmd.args), collect stdout/stderr, map per the header
 * contract. `spawn` and `timeoutMs` are injectable for tests. The output's
 * parent directory (the jobDir) is created upfront — ffmpeg does not make
 * parents and the frame must land inside the job's isolated dir.
 */
function runFfmpeg({ spawn = require('child_process').spawn, timeoutMs = DEFAULT_TIMEOUT_MS }, cmd) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
      resolve({ ok: false, code: 'MEDIA_FRAME_TIMEOUT', message: `frame ffmpeg did not finish within ${timeoutMs}ms` });
    }, timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const unavailable = (e) => ({ ok: false, code: 'MEDIA_FFMPEG_UNAVAILABLE', message: String((e && e.message) || e) });
    const failed = (e) => ({ ok: false, code: 'MEDIA_FRAME_FAILED', message: String((e && e.message) || e).slice(0, 500) });

    let proc;
    try {
      const outPath = cmd && cmd.output ? String(cmd.output) : '';
      const slash = outPath.lastIndexOf('/');
      if (slash > 0) {
        try { require('node:fs').mkdirSync(outPath.slice(0, slash), { recursive: true }); } catch (_e) { /* best-effort */ }
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
      return done({ ok: true, result: { output: cmd.output } });
    });
  });
}

/**
 * Frame executor: { source, timeMs, outKey?, jobDir?, jobId?, spawn?, timeoutMs? }.
 * Guards MEDIA_SOURCE_MISSING up front (never spawns), surfaces structural
 * violations (bad timeMs) deterministically as MEDIA_FRAME_FAILED, then
 * delegates to ffmpeg per the header contract.
 */
function runFrame(ctx = {}) {
  if (typeof ctx.source !== 'string' || String(ctx.source).trim().length === 0) {
    return Promise.resolve({ ok: false, code: 'MEDIA_SOURCE_MISSING', message: 'frame executor requires a source video path or URL' });
  }
  let cmd;
  try {
    cmd = buildFrameCommand(ctx);
  } catch (e) {
    return Promise.resolve({ ok: false, code: 'MEDIA_FRAME_FAILED', message: String((e && e.message) || e) });
  }
  return runFfmpeg(ctx, cmd);
}

module.exports = {
  buildFrameCommand,
  runFrame,
  msToSeconds,
  defaultOutKey,
};
