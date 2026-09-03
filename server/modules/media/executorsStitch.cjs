'use strict';
/**
 * G11-stitch — Video segment stitching executor (pure command module),
 * complementing executorsAv.cjs (G06). Single ffmpeg invocation: every
 * segment is decoded as its own -i input, each trimmed to [inMs, outMs)
 * (integer milliseconds → seconds with 3 decimals) with setpts reset, and
 * the trimmed streams are joined through one filter_complex concat:
 *
 *   ffmpeg -y -i seg1 -i seg2 \
 *     -filter_complex "[0:v]trim=start=S0:end=E0,setpts=PTS-STARTPTS[v0];\
 *                      [1:v]trim=start=S1:end=E1,setpts=PTS-STARTPTS[v1];\
 *                      [v0][v1]concat=n=2:v=1:a=0[v]" \
 *     -map "[v]" out.mp4
 *
 * Runner contract (same as executorsAv runners, kind = 'stitch'):
 *   exit 0                     → { ok:true,  result:{ output, segments } }
 *   spawn throws/emits ENOENT  → { ok:false, code:'MEDIA_FFMPEG_UNAVAILABLE' }
 *   non-zero exit              → { ok:false, code:'MEDIA_STITCH_FAILED', message }
 *   timeout (kill SIGKILL)     → { ok:false, code:'MEDIA_STITCH_TIMEOUT', message }
 *   missing segment source     → { ok:false, code:'MEDIA_SOURCE_MISSING' }
 */

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_SEGMENTS = 20;

/** Integer milliseconds → ffmpeg seconds with exactly 3 decimals (2000→"2.000"). */
function msToSeconds(ms) {
  return (ms / 1000).toFixed(3);
}

/** Structural validation shared by buildStitchCommand. Throws on the first violation. */
function validateSegments(segments) {
  if (!Array.isArray(segments)) throw new Error('stitch requires a segments array');
  if (segments.length < 1) throw new Error('stitch requires at least one segment');
  if (segments.length > MAX_SEGMENTS) {
    throw new Error(`stitch supports at most ${MAX_SEGMENTS} segments (got ${segments.length})`);
  }
  segments.forEach((seg, i) => {
    if (!seg || typeof seg.source !== 'string' || seg.source.length === 0) {
      throw new Error(`segment ${i} requires a source`);
    }
    const { inMs, outMs } = seg;
    if (!Number.isInteger(inMs) || inMs < 0) {
      throw new Error(`segment ${i} inMs must be an integer ≥ 0 (got ${inMs})`);
    }
    if (!Number.isInteger(outMs) || outMs <= inMs) {
      throw new Error(`segment ${i} outMs must be an integer > inMs (got ${outMs})`);
    }
  });
}

/**
 * ffmpeg args for a trim+concat stitch of up to 20 video segments.
 * Every segment source becomes a `-i` input; the filter_complex graph trims
 * each [i:v] to its [inMs, outMs) window (seconds, 3 decimals), resets the
 * PTS timeline per stream, then concats them (video only, a=0).
 * Returns { args, output, segments, filter }.
 */
function buildStitchCommand({ segments, outKey } = {}) {
  validateSegments(segments);
  if (typeof outKey !== 'string' || outKey.length === 0) {
    throw new Error('stitch requires an outKey output path');
  }
  const args = ['-y'];
  const parts = [];
  segments.forEach((seg, i) => {
    args.push('-i', seg.source);
    parts.push(`[${i}:v]trim=start=${msToSeconds(seg.inMs)}:end=${msToSeconds(seg.outMs)},setpts=PTS-STARTPTS[v${i}]`);
  });
  const inputs = segments.map((_, i) => `[v${i}]`).join('');
  parts.push(`${inputs}concat=n=${segments.length}:v=1:a=0[v]`);
  const filter = parts.join(';');
  args.push('-filter_complex', filter, '-map', '[v]', outKey);
  return { args, output: outKey, segments: segments.length, filter };
}

/**
 * Shared stitch runner mirroring executorsAv.runFfmpeg (kind = 'stitch'):
 * spawn('ffmpeg', cmd.args), collect stdout/stderr, map per the header
 * contract. `spawn` and `timeoutMs` are injectable for tests.
 */
function runFfmpeg({ spawn = require('child_process').spawn, timeoutMs = DEFAULT_TIMEOUT_MS }, cmd) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
      resolve({ ok: false, code: 'MEDIA_STITCH_TIMEOUT', message: `stitch ffmpeg did not finish within ${timeoutMs}ms` });
    }, timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const unavailable = (e) => ({ ok: false, code: 'MEDIA_FFMPEG_UNAVAILABLE', message: String((e && e.message) || e) });
    const failed = (e) => ({ ok: false, code: 'MEDIA_STITCH_FAILED', message: String((e && e.message) || e).slice(0, 500) });

    let proc;
    try {
      // Create job-scoped output dirs upfront (ffmpeg does not make parents).
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
      return done({ ok: true, result: { output: cmd.output, segments: cmd.segments } });
    });
  });
}

/**
 * Stitch executor: { segments:[{source,inMs,outMs}], outKey?, spawn?, timeoutMs? }.
 * Guards MEDIA_SOURCE_MISSING up front (segments array empty / a segment
 * without source), then delegates to ffmpeg per the header contract.
 */
function runStitch(ctx = {}) {
  const segments = Array.isArray(ctx.segments) ? ctx.segments : [];
  if (segments.length === 0) {
    return Promise.resolve({ ok: false, code: 'MEDIA_SOURCE_MISSING', message: 'stitch executor requires segments (at least one segment with a source)' });
  }
  for (const seg of segments) {
    if (!seg || typeof seg.source !== 'string' || seg.source.length === 0) {
      return Promise.resolve({ ok: false, code: 'MEDIA_SOURCE_MISSING', message: 'stitch executor requires a source for every segment' });
    }
  }
  let cmd;
  try {
    cmd = buildStitchCommand(ctx);
  } catch (e) {
    // Structural parameter violations (outMs<=inMs, >20 segments, ...) surface
    // deterministically as MEDIA_STITCH_FAILED with the validation message.
    return Promise.resolve({ ok: false, code: 'MEDIA_STITCH_FAILED', message: String((e && e.message) || e) });
  }
  return runFfmpeg(ctx, cmd);
}

module.exports = {
  buildStitchCommand,
  runStitch,
  msToSeconds,
  MAX_SEGMENTS,
};
