'use strict';
/**
 * G12-scene — Scene-cut detection executor (pure command module), the sibling
 * of executorsFrame.cjs (G12), executorsStitch.cjs (G11) and executorsAv.cjs
 * (G06). Runs one ffmpeg pass that decodes the source and, per frame, asks
 * `select` to keep only frames whose scene-change score exceeds a threshold
 * (`gt(scene,T)`), tagging each survivor with `showinfo` so its timestamp is
 * logged to stderr:
 *
 *   ffmpeg -y -i source \
 *     -vf "select='gt(scene,0.3)',showinfo" \
 *     -f null -
 *
 * Every frame `select` lets through is the FIRST frame of a new scene, so the
 * showinfo `pts_time:` values in stderr are the scene-cut boundary times.
 * They are parsed into integer-millisecond cut points and expanded into
 * contiguous segments:
 *
 *   pts_time:0.6 + pts_time:2.5  →  [{startMs:0,endMs:600},
 *                                     {startMs:600,endMs:2500},
 *                                     {startMs:2500,endMs:<durationMs|null>}]
 *
 * The tail segment is capped at the caller-provided durationMs when known
 * (e.g. from a prior probe) and left open (endMs:null) when unknown — a null
 * upper bound means "runs to end of source". No cuts at all (a single
 * unbroken scene, or an empty parse) yields one full-length segment.
 *
 * Runner contract (same as executorsAv runners, kind = 'scene'):
 *   exit 0                     → { ok:true,  result:{ segments } }
 *   spawn throws/emits ENOENT  → { ok:false, code:'MEDIA_FFMPEG_UNAVAILABLE' }
 *   non-zero exit              → { ok:false, code:'MEDIA_SCENE_FAILED', message }
 *   timeout (kill SIGKILL)     → { ok:false, code:'MEDIA_SCENE_TIMEOUT', message }
 *   missing/empty source       → { ok:false, code:'MEDIA_SOURCE_MISSING' }
 */

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * ffmpeg args for scene-cut detection. `threshold` (default 0.3) is the
 * minimum scene-change score ffmpeg must see before a frame is treated as a
 * new scene start; the surviving frames are tagged with showinfo which logs
 * `pts_time:<seconds>` per survivor to stderr. Output is discarded (-f null).
 * Returns { args, output, threshold, filter }.
 * Throws on structural violations: missing source, or a threshold that is not
 * a finite number in (0, 1] (scores are normalized to [0, 1] by ffmpeg).
 */
function buildSceneDetectCommand({ source, threshold = 0.3, outKey } = {}) {
  if (typeof source !== 'string' || String(source).trim().length === 0) {
    throw new Error('scene detect requires a source');
  }
  const t = Number(threshold);
  if (!Number.isFinite(t) || t <= 0 || t > 1) {
    throw new Error(`scene threshold must be a finite number in (0, 1] (got ${threshold})`);
  }
  const filter = `select='gt(scene,${String(t)})',showinfo`;
  const args = ['-y', '-i', String(source), '-vf', filter, '-f', 'null', '-'];
  return { args, output: typeof outKey === 'string' && outKey.length > 0 ? outKey : null, threshold: t, filter };
}

/**
 * Parse ffmpeg stderr for showinfo `pts_time:` values (seconds, integer or
 * decimal — ffmpeg renders whole seconds without a decimal point) and return
 * the scene-cut boundary times as sorted, de-duplicated integer milliseconds.
 * Noise lines (progress stats, banner) never contain `pts_time:`, so they are
 * ignored; a boundary at or before 0 is not a cut and is dropped.
 */
function parseSceneDetectOutput(output) {
  const text = String(output || '');
  const re = /pts_time:\s*(-?\d+(?:\.\d+)?)/g;
  const ms = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = Math.round(parseFloat(m[1]) * 1000);
    if (Number.isFinite(v) && v > 0) ms.push(v);
  }
  ms.sort((a, b) => a - b);
  return [...new Set(ms)];
}

/**
 * Expand integer-ms cut boundaries into contiguous segments. A cut at time C
 * starts a new scene, so every segment is [previousBoundary, C) and the tail
 * runs from the last cut to durationMs when known (integer ms ≥ 0) or is left
 * open (endMs:null) when the duration is unknown. Cuts that land at or beyond
 * the duration are clamped/dropped rather than yielding empty segments.
 */
function normalizeCuts(cuts) {
  const vals = [];
  for (const c of Array.isArray(cuts) ? cuts : []) {
    const v = Math.round(Number(c));
    if (Number.isFinite(v) && v > 0) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return vals.filter((v, i) => i === 0 || v !== vals[i - 1]);
}

function buildSegments(cuts, durationMs) {
  const dur =
    Number.isFinite(Number(durationMs)) && Number(durationMs) > 0 ? Math.round(Number(durationMs)) : null;
  const segments = [];
  let prev = 0;
  for (const cut of normalizeCuts(cuts)) {
    let end = cut;
    if (dur !== null && end > dur) end = dur;
    if (end > prev) segments.push({ startMs: prev, endMs: end });
    prev = cut;
  }
  if (dur === null || dur > prev) segments.push({ startMs: prev, endMs: dur });
  return segments;
}

/**
 * Shared scene runner mirroring executorsAv/executorsStitch/executorsFrame
 * (kind = 'scene'): spawn('ffmpeg', cmd.args), collect stderr, map per the
 * header contract. `spawn` and `timeoutMs` are injectable for tests.
 * On exit 0 the collected stderr is parsed into cut points and expanded into
 * segments against `durationMs` (may be null → open-ended tail).
 */
function runFfmpeg({ spawn = require('child_process').spawn, timeoutMs = DEFAULT_TIMEOUT_MS }, cmd, durationMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
      resolve({ ok: false, code: 'MEDIA_SCENE_TIMEOUT', message: `scene detect ffmpeg did not finish within ${timeoutMs}ms` });
    }, timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const unavailable = (e) => ({ ok: false, code: 'MEDIA_FFMPEG_UNAVAILABLE', message: String((e && e.message) || e) });
    const failed = (e) => ({ ok: false, code: 'MEDIA_SCENE_FAILED', message: String((e && e.message) || e).slice(0, 500) });

    let proc;
    try {
      proc = spawn('ffmpeg', cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (e && e.code === 'ENOENT') return done(unavailable(e));
      return done(failed(e));
    }

    let err = '';
    proc.stdout.on('data', () => { /* -f null writes nothing; drain anyway */ });
    proc.stderr.on('data', (d) => { err += Buffer.isBuffer(d) ? d.toString('utf8') : String(d); });
    proc.on('error', (e) => {
      if (e && e.code === 'ENOENT') return done(unavailable(e));
      return done(failed(e));
    });
    proc.on('close', (code) => {
      if (code !== 0) return done(failed(err || `ffmpeg exited with code ${code}`));
      const segments = buildSegments(parseSceneDetectOutput(err), durationMs);
      return done({ ok: true, result: { segments } });
    });
  });
}

/**
 * Scene-detect executor: { source, threshold?, outKey?, durationMs?, spawn?, timeoutMs? }.
 * Guards MEDIA_SOURCE_MISSING up front (never spawns), surfaces structural
 * violations (bad threshold) deterministically as MEDIA_SCENE_FAILED, then
 * delegates to ffmpeg per the header contract.
 */
function runSceneDetect(ctx = {}) {
  if (typeof ctx.source !== 'string' || String(ctx.source).trim().length === 0) {
    return Promise.resolve({ ok: false, code: 'MEDIA_SOURCE_MISSING', message: 'scene detect executor requires a source video path or URL' });
  }
  let cmd;
  try {
    cmd = buildSceneDetectCommand(ctx);
  } catch (e) {
    return Promise.resolve({ ok: false, code: 'MEDIA_SCENE_FAILED', message: String((e && e.message) || e) });
  }
  return runFfmpeg(ctx, cmd, ctx.durationMs);
}

module.exports = {
  buildSceneDetectCommand,
  parseSceneDetectOutput,
  buildSegments,
  runSceneDetect,
};
