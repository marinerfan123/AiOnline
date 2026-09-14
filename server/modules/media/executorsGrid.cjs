'use strict';
/**
 * G09-grid — Native grid / contact-sheet executor (pure local ffmpeg montage),
 * sibling of executorsAv.cjs (G06), executorsStitch.cjs (G11) and
 * executorsFrame.cjs (G12). Given 1..9 source images it tiles them row-major
 * into ONE still output. All inputs are first scaled to a uniform 720px cell
 * height (`scale=trunc(iw*720/ih/2)*2:720` keeps every cell width EVEN so the
 * sheet stays valid for lossy encoders too), normalized (`setsar=1,
 * format=rgb24` — xstack demands identical pixel formats across inputs), then
 * stacked through ONE xstack filter_complex:
 *
 *   ffmpeg -y -i s1 -i s2 -i s3 \
 *     -filter_complex "[0:v]scale=trunc(iw*720/ih/2)*2:720,setsar=1,format=rgb24[s0];\
 *                      [1:v]scale=trunc(iw*720/ih/2)*2:720,setsar=1,format=rgb24[s1];\
 *                      [2:v]scale=trunc(iw*720/ih/2)*2:720,setsar=1,format=rgb24[s2];\
 *                      [s0][s1][s2]xstack=inputs=3:layout=0_0|w0_0|0_720[v]" \
 *     -map "[v]" out.png
 *
 * LAYOUT MATH: uniform 720px cells make every row exactly 720px tall, so the
 * row-major y offset of row r is the literal r*720. Widths still vary with the
 * source aspect, so each cell's x is the running SUM of the scaled widths of
 * its predecessors IN THE SAME ROW via xstack's wN variables (0_0|w0_0|0_720
 * → cols=2 rows=2; w0+w1_0 → third tile of a row). Because xstack itself
 * requires ≥ 2 inputs (inputs=1 is out of range), a 1-source grid is the same
 * uniform-height scale WITHOUT xstack (single-cell sheet).
 *
 * Parameter contract is kept in the registry family (imageToolsRegistry.cjs
 * GRID_SCHEMA): cols is an integer in the registry's closed interval [1, 10]
 * (default 2); sources is capped at 9 tiles; rows is DERIVED as
 * ceil(sources.length / cols) instead of being taken from the request — a
 * contact sheet must not leave layout holes.
 *
 * Runner contract (same as the stitch/frame runners, kind = 'grid'):
 *   exit 0                     → { ok:true,  result:{ output, sources, cols, rows } }
 *   spawn throws/emits ENOENT  → { ok:false, code:'MEDIA_FFMPEG_UNAVAILABLE' }
 *   non-zero exit              → { ok:false, code:'MEDIA_GRID_FAILED', message }
 *   timeout (kill SIGKILL)     → { ok:false, code:'MEDIA_GRID_TIMEOUT', message }
 *   missing/empty source list  → { ok:false, code:'MEDIA_SOURCE_MISSING' }
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_COLS = 2;
const MAX_SOURCES = 9; // grid tiles capped at 9 (3x3 max useful sheet)
const MAX_COLS = 10;   // registry GRID_SCHEMA cols closed interval [1, 10]
const CELL_HEIGHT = 720; // uniform cell height → rows tile without gaps
/** Even-width uniform-height scale expression (w even → yuv420p safe). */
const SCALE_CHAIN = `scale=trunc(iw*${CELL_HEIGHT}/ih/2)*2:${CELL_HEIGHT},setsar=1,format=rgb24`;

/**
 * Structural validation shared by buildGridCommand. Throws on the first
 * violation (mirrors validateSegments / validateToolRequest wording style).
 */
function validateGrid({ sources, cols }) {
  if (!Array.isArray(sources)) throw new Error('grid requires a sources array');
  if (sources.length < 1) throw new Error('grid requires at least one source');
  if (sources.length > MAX_SOURCES) {
    throw new Error(`grid supports at most ${MAX_SOURCES} sources (got ${sources.length})`);
  }
  sources.forEach((src, i) => {
    if (typeof src !== 'string' || src.trim().length === 0) {
      throw new Error(`source ${i} must be a non-empty path/URL`);
    }
  });
  const c = cols === undefined ? DEFAULT_COLS : cols;
  if (!Number.isInteger(c)) {
    throw new Error(`grid cols must be an integer (got ${c})`);
  }
  if (c < 1 || c > MAX_COLS) {
    throw new Error(`grid cols must be in the closed interval [1, ${MAX_COLS}] (got ${c})`);
  }
  return c;
}

/**
 * ffmpeg args for a row-major contact sheet of up to 9 sources, every cell
 * pre-scaled to a uniform 720px height. Sources ≥ 2 go through one xstack
 * layout; a single source is the same scale chain alone (xstack min inputs
 * is 2). Returns { args, output, sources, cols, rows, filter }.
 * Throws on structural violations: non-array/empty/oversized sources, a
 * non-string source, non-integer or out-of-[1,10] cols, missing outKey.
 */
function buildGridCommand({ sources, outKey, cols } = {}) {
  const c = validateGrid({ sources, cols });
  if (typeof outKey !== 'string' || outKey.length === 0) {
    throw new Error('grid requires an outKey output path');
  }
  const n = sources.length;
  const rows = Math.ceil(n / c);

  if (n === 1) {
    const vf = SCALE_CHAIN;
    const args = ['-y', '-i', sources[0], '-vf', vf, outKey];
    return { args, output: outKey, sources: n, cols: c, rows, filter: vf };
  }

  const parts = sources.map((_, i) => `[${i}:v]${SCALE_CHAIN}[s${i}]`);
  // Row-major placement: y = r*720 (uniform cells), x = sum of same-row
  // predecessors' scaled widths via xstack wN variables.
  const cells = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / c);
    const col = i % c;
    let x = '0';
    if (col > 0) {
      const preds = [];
      for (let j = 0; j < col; j++) preds.push(`w${r * c + j}`);
      x = preds.join('+');
    }
    cells.push(`${x}_${r * CELL_HEIGHT}`);
  }
  const layout = cells.join('|');
  parts.push(`${sources.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${n}:layout=${layout}[v]`);
  const filter = parts.join(';');
  const args = ['-y'];
  for (const src of sources) args.push('-i', src);
  args.push('-filter_complex', filter, '-map', '[v]', outKey);
  return { args, output: outKey, sources: n, cols: c, rows, filter, layout };
}

/**
 * Shared grid runner mirroring executorsStitch/executorsFrame.runFfmpeg
 * (kind = 'grid'): spawn('ffmpeg', cmd.args), collect stdout/stderr, map per
 * the header contract. `spawn` and `timeoutMs` are injectable for tests.
 */
function runFfmpeg({ spawn = require('child_process').spawn, timeoutMs = DEFAULT_TIMEOUT_MS }, cmd) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
      resolve({ ok: false, code: 'MEDIA_GRID_TIMEOUT', message: `grid ffmpeg did not finish within ${timeoutMs}ms` });
    }, timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const unavailable = (e) => ({ ok: false, code: 'MEDIA_FFMPEG_UNAVAILABLE', message: String((e && e.message) || e) });
    const failed = (e) => ({ ok: false, code: 'MEDIA_GRID_FAILED', message: String((e && e.message) || e).slice(0, 500) });

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
      return done({ ok: true, result: { output: cmd.output, sources: cmd.sources, cols: cmd.cols, rows: cmd.rows } });
    });
  });
}

/**
 * Grid executor: { sources:[path|url, ...], cols?=2, outKey?, spawn?,
 * timeoutMs? }. Guards MEDIA_SOURCE_MISSING up front (sources missing / empty
 * / any entry without a path), then delegates to ffmpeg per the header
 * contract. Structural param violations (cols out of range, > 9 sources,
 * missing outKey, ...) surface deterministically as MEDIA_GRID_FAILED.
 */
function runGrid(ctx = {}) {
  const sources = Array.isArray(ctx.sources) ? ctx.sources : [];
  if (sources.length === 0) {
    return Promise.resolve({ ok: false, code: 'MEDIA_SOURCE_MISSING', message: 'grid executor requires sources (at least one source image)' });
  }
  for (const src of sources) {
    if (typeof src !== 'string' || src.trim().length === 0) {
      return Promise.resolve({ ok: false, code: 'MEDIA_SOURCE_MISSING', message: 'grid executor requires a non-empty source for every entry' });
    }
  }
  let cmd;
  try {
    cmd = buildGridCommand(ctx);
  } catch (e) {
    return Promise.resolve({ ok: false, code: 'MEDIA_GRID_FAILED', message: String((e && e.message) || e) });
  }
  return runFfmpeg(ctx, cmd);
}

module.exports = {
  buildGridCommand,
  runGrid,
  DEFAULT_COLS,
  MAX_SOURCES,
  MAX_COLS,
  CELL_HEIGHT,
};
