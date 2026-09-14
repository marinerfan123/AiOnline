'use strict';
/**
 * G09 ③-annotate — Native text-overlay (annotate) executor, the sibling of
 * executorsGrid.cjs (G09) / executorsFrame.cjs (G12) / executorsAv.cjs (G06).
 * Paints one line of text over the source still via an ffmpeg drawtext pass:
 *
 *   ffmpeg -y -i source \
 *     -vf "drawtext=text='<escaped>':x=<..|center>:y=<..|center>:fontfile=<opt>:fontsize=28:fontcolor=white" \
 *     out.png
 *
 * GEOMETRY (registry ANNOTATE_SCHEMA semantics, imageToolsRegistry.cjs):
 *   text        required, non-empty, ≤ 500 chars (MAX_TEXT_LENGTH below is a
 *               belt-and-braces mirror of the registry maxLength — dispatch
 *               already double-guards the schema surface upstream)
 *   x / y       optional integer px; OMITTED → drawtext centers on that axis
 *               (x=(w-text_w)/2, y=(h-text_h)/2 — matches the schema wording
 *               "Omit for horizontal/vertical center")
 *   fontSizePx  optional integer px in [8, 200]; omitted → DEFAULT_FONTSIZE 28
 *               (the G09-③ canonical drawtext size)
 *   opacity     optional ratio in [0, 1]; rendered as fontcolor=white@<alpha>
 *               when below 1, plain fontcolor=white otherwise
 *
 * FONT PREFLIGHT — drawtext renders through libfreetype: WITHOUT a font it is
 * dead on hosts that have no fontconfig/fonts (the deploy container may lack
 * both). buildAnnotateCommand therefore still GENERATES a fontfile-less
 * command (pure, testable), but runAnnotate REFUSES to spawn unless a font is
 * resolvable, in this order:
 *   1. ctx.fontFile                       (explicit path in the job envelope)
 *   2. process.env.ANNOTATE_FONT_PATH     (operator-declared host font)
 *   neither → { ok:false, code:'MEDIA_ANNOTATE_FONT_UNAVAILABLE' } BEFORE any
 *   spawn. Tests inject ctx.env to exercise both branches without mutating
 *   process.env; real callers omit it and read the true environment.
 *
 * TEXT ESCAPING — the text value lives inside a single-quoted drawtext option
 * inside the -vf filter string, which ffmpeg tokenizes on unquoted `:` with
 * `'` quoting and `\` escaping. escapeDrawText() makes a value inert against
 * that parser (backslash first, then `'` and `:`):
 *     \  →  \\          '  →  \'          :  →  \:
 * `:` and `'` therefore can never close the option or the quote early, and a
 * backslash can never swallow the escape of the character that follows it.
 * The same escape protects the fontfile path (a `:` there would otherwise be
 * read as an option separator).
 *
 * Runner contract (mirrors the grid/frame/stitch runners, kind='annotate'):
 *   exit 0                     → { ok:true,  result:{ output, text, fontFile, fontSize } }
 *   fontFile missing everywhere → { ok:false, code:'MEDIA_ANNOTATE_FONT_UNAVAILABLE' } (no spawn)
 *   spawn throws/emits ENOENT  → { ok:false, code:'MEDIA_FFMPEG_UNAVAILABLE' }
 *   non-zero exit              → { ok:false, code:'MEDIA_ANNOTATE_FAILED', message }
 *   timeout (kill SIGKILL)     → { ok:false, code:'MEDIA_ANNOTATE_TIMEOUT', message }
 *   missing/empty source       → { ok:false, code:'MEDIA_SOURCE_MISSING' }
 *   structural param violations (overlong/empty text, bad geometry, missing
 *   outKey, …) → { ok:false, code:'MEDIA_ANNOTATE_FAILED', message }
 */

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TEXT_LENGTH = 500; // registry ANNOTATE_SCHEMA.text.maxLength
const DEFAULT_FONTSIZE = 28; // G09-③ canonical drawtext fontsize
const FONT_SIZE_MIN = 8;     // registry fontSizePx closed interval [8, 200]
const FONT_SIZE_MAX = 200;
const POS_MIN = 0;           // registry x / y closed interval [0, 100000]
const POS_MAX = 100000;
const DEFAULT_FONT_COLOR = 'white';
const FONT_ENV = 'ANNOTATE_FONT_PATH';

/** True for a non-empty string that may serve as a path. */
function isPathString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Escape a string so it is inert inside a single-quoted ffmpeg filter option
 * (see header). Deterministic: backslash doubled FIRST so a source backslash
 * can never neutralise the escaping added for `'` / `:`.
 */
function escapeDrawText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

/**
 * Resolve the font this run will draw with: ctx fontFile wins, then the
 * ANNOTATE_FONT_PATH environment variable (operator-declared host font).
 * Returns null when neither names a usable path.
 */
function resolveFontFile(fontFile, env = process.env) {
  if (isPathString(fontFile)) return fontFile;
  const fromEnv = env && typeof env === 'object' ? env[FONT_ENV] : undefined;
  if (isPathString(fromEnv)) return fromEnv;
  return null;
}

/**
 * Build the ffmpeg drawtext command. fontFile is OPTIONAL here — the command
 * is still produced without one (pure builder, keeps drawtext-escape tests
 * independent of font resolution); runAnnotate is the layer that refuses to
 * spawn without a resolvable font.
 *
 * Returns { args, output, filter, text, fontFile, fontSize, x, y }.
 * Throws on structural violations (mirrors validateGrid / buildFrameCommand
 * wording): missing/empty source, missing/empty/overlong text, non-string
 * geometry, out-of-range fontSizePx/x/y/opacity, missing outKey, a provided
 * but unusable fontFile.
 */
function buildAnnotateCommand({ source, text, outKey, fontFile, x, y, fontSizePx, opacity } = {}) {
  if (!isPathString(source)) {
    throw new Error('annotate requires a source image path/URL');
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('annotate requires a non-empty text');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`annotate text must be ≤ ${MAX_TEXT_LENGTH} chars (got ${text.length})`);
  }
  if (!isPathString(outKey)) {
    throw new Error('annotate requires an outKey output path');
  }
  if (fontFile !== undefined && fontFile !== null && !isPathString(fontFile)) {
    throw new Error('annotate fontFile must be a non-empty font path');
  }

  const fontSize = fontSizePx === undefined ? DEFAULT_FONTSIZE : fontSizePx;
  if (!Number.isInteger(fontSize) || fontSize < FONT_SIZE_MIN || fontSize > FONT_SIZE_MAX) {
    throw new Error(`annotate fontSizePx must be an integer in the closed interval [${FONT_SIZE_MIN}, ${FONT_SIZE_MAX}] (got ${fontSizePx})`);
  }
  for (const [label, v, lo, hi] of [['x', x, POS_MIN, POS_MAX], ['y', y, POS_MIN, POS_MAX]]) {
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new Error(`annotate ${label} must be an integer in the closed interval [${lo}, ${hi}] (got ${v})`);
    }
  }
  let color = DEFAULT_FONT_COLOR;
  if (opacity !== undefined && opacity !== null) {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new Error(`annotate opacity must be a ratio in the closed interval [0, 1] (got ${opacity})`);
    }
    if (opacity < 1) color = `${DEFAULT_FONT_COLOR}@${opacity}`;
  }

  const esc = escapeDrawText;
  let filter = `drawtext=text='${esc(text)}'`;
  // Schema semantics: x / y omitted → center that axis.
  filter += Number.isInteger(x) ? `:x=${x}` : ':x=(w-text_w)/2';
  filter += Number.isInteger(y) ? `:y=${y}` : ':y=(h-text_h)/2';
  if (fontFile) filter += `:fontfile=${esc(fontFile)}`;
  filter += `:fontsize=${fontSize}:fontcolor=${color}`;

  const args = ['-y', '-i', source, '-vf', filter, outKey];
  return {
    args,
    output: outKey,
    filter,
    text,
    fontFile: fontFile || null,
    fontSize,
    x: Number.isInteger(x) ? x : null,
    y: Number.isInteger(y) ? y : null,
  };
}

/**
 * Shared runner mirroring executorsGrid/executorsFrame.runFfmpeg but mapped to
 * the annotate error codes of the header contract.
 */
function runFfmpeg({ spawn = require('child_process').spawn, timeoutMs = DEFAULT_TIMEOUT_MS }, cmd) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
      resolve({ ok: false, code: 'MEDIA_ANNOTATE_TIMEOUT', message: `annotate ffmpeg did not finish within ${timeoutMs}ms` });
    }, timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const unavailable = (e) => ({ ok: false, code: 'MEDIA_FFMPEG_UNAVAILABLE', message: String((e && e.message) || e) });
    const failed = (e) => ({ ok: false, code: 'MEDIA_ANNOTATE_FAILED', message: String((e && e.message) || e).slice(0, 500) });

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

    const err = [];
    proc.stdout.on('data', (d) => { /* drain — drawtext diagnostics land on stderr */ });
    proc.stderr.on('data', (d) => { err.push(Buffer.isBuffer(d) ? d.toString('utf8') : String(d)); });
    proc.on('error', (e) => {
      if (e && e.code === 'ENOENT') return done(unavailable(e));
      return done(failed(e));
    });
    proc.on('close', (code) => {
      if (code !== 0) return done(failed(err.join('') || `ffmpeg exited with code ${code}`));
      return done({ ok: true, result: { output: cmd.output, text: cmd.text, fontFile: cmd.fontFile, fontSize: cmd.fontSize } });
    });
  });
}

/**
 * Annotate executor: { source, text, x?, y?, fontSizePx?, opacity?,
 * fontFile?, env?, outKey?, spawn?, timeoutMs? } → outcome per header.
 * NON-THROWING by contract. Font preflight (MEDIA_ANNOTATE_FONT_UNAVAILABLE)
 * happens after structural validation but BEFORE spawn — a command is always
 * generated first so builder/escape bugs surface as MEDIA_ANNOTATE_FAILED,
 * but ffmpeg is never started for an annotation no font can render.
 */
function runAnnotate(ctx = {}) {
  if (!isPathString(ctx.source)) {
    return Promise.resolve({ ok: false, code: 'MEDIA_SOURCE_MISSING', message: 'annotate executor requires a source image path/URL' });
  }
  // ctx.env is a TEST SEAM for font preflight; real callers omit it and the
  // executor reads the true process.env (ANNOTATE_FONT_PATH).
  const env = ctx.env && typeof ctx.env === 'object' ? ctx.env : process.env;
  const fontFile = resolveFontFile(ctx.fontFile, env);

  let cmd;
  try {
    cmd = buildAnnotateCommand({
      source: ctx.source,
      text: ctx.text,
      outKey: ctx.outKey,
      fontFile: fontFile || undefined,
      x: ctx.x,
      y: ctx.y,
      fontSizePx: ctx.fontSizePx,
      opacity: ctx.opacity,
    });
  } catch (e) {
    return Promise.resolve({ ok: false, code: 'MEDIA_ANNOTATE_FAILED', message: String((e && e.message) || e) });
  }

  if (!fontFile) {
    return Promise.resolve({
      ok: false,
      code: 'MEDIA_ANNOTATE_FONT_UNAVAILABLE',
      message: 'annotate needs a font: pass fontFile or set ANNOTATE_FONT_PATH to a font file (none available on this host)',
    });
  }
  const spawn = typeof ctx.spawn === 'function' ? ctx.spawn : require('child_process').spawn;
  const timeoutMs = ctx.timeoutMs !== undefined ? ctx.timeoutMs : DEFAULT_TIMEOUT_MS;
  return runFfmpeg({ spawn, timeoutMs }, cmd);
}

module.exports = {
  buildAnnotateCommand,
  runAnnotate,
  escapeDrawText,
  resolveFontFile,
  DEFAULT_TIMEOUT_MS,
  MAX_TEXT_LENGTH,
  DEFAULT_FONTSIZE,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  POS_MIN,
  POS_MAX,
  DEFAULT_FONT_COLOR,
  FONT_ENV,
};
