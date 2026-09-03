'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { dispatchToolRequest, NATIVE_KINDS } = require('./imageToolsExec.cjs');

/** Fake spawn matching executorsGrid.test.cjs (EventEmitter child + streams). */
function makeFakeSpawn(opts = {}) {
  const {
    enoent = false,
    exitCode = 0,
    stderrData = [],
    emitClose = true,
  } = opts;
  const fn = (bin, args) => {
    if (enoent) {
      const e = new Error('spawn ffmpeg ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    fn.calls.push({ bin, args, child });
    const fire = () => {
      for (const d of stderrData) child.stderr.emit('data', d);
      if (emitClose) child.emit('close', exitCode);
    };
    setImmediate(fire);
    return child;
  };
  fn.calls = [];
  return fn;
}

// ─── grid dispatch → executorsGrid (fake spawn injected via ctx) ─────────────

test('dispatch grid: routes to executorsGrid with rows/cols + envelope mapped into an xstack ffmpeg run', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({
    kind: 'grid',
    params: {
      rows: 2, // registry schema surface (validated double-guard)
      cols: 2,
      sources: ['/img/a.png', '/img/b.png', '/img/c.png', '/img/d.png'],
      outKey: '/tmp/sheet.png',
      jobDir: '/tmp/jobs/g1',
      spawn,
      timeoutMs: 2000,
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.output, '/tmp/sheet.png');
  assert.equal(r.result.sources, 4);
  assert.equal(r.result.cols, 2);
  assert.equal(r.result.rows, 2);
  assert.equal(spawn.calls.length, 1, 'grid dispatch must spawn exactly once');
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  assert.equal(args.filter((a) => a === '-i').length, 4, 'one -i per source');
  const fi = args.indexOf('-filter_complex');
  assert.ok(fi !== -1, 'multi-source grid must carry -filter_complex');
  assert.ok(args[fi + 1].includes('xstack=inputs=4:layout=0_0|w0_0|0_720|w2_720'),
    `args must carry the 2x2 row-major xstack layout (got "${args[fi + 1]}")`);
  assert.ok(args.includes('-map') && args.includes('[v]'));
  assert.equal(args[args.length - 1], '/tmp/sheet.png', 'outKey must be the ffmpeg output path');
});

test('dispatch grid: 1 source exits 0 → ok (no xstack, -vf scale only)', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({
    kind: 'grid',
    params: { rows: 1, cols: 2, sources: ['only.png'], outKey: '/tmp/one.png', spawn, timeoutMs: 2000 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.output, '/tmp/one.png');
  assert.ok(spawn.calls[0].args.includes('-vf'));
  assert.ok(!spawn.calls[0].args.includes('-filter_complex'));
});

test('dispatch grid: executor failure codes pass through untouched (non-zero exit → MEDIA_GRID_FAILED)', async () => {
  const spawn = makeFakeSpawn({ exitCode: 1, stderrData: [Buffer.from('boom')] });
  const r = await dispatchToolRequest({
    kind: 'grid',
    params: { rows: 2, cols: 2, sources: ['a.png', 'b.png'], outKey: '/tmp/x.png', spawn, timeoutMs: 2000 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_GRID_FAILED');
  assert.ok(r.message.includes('boom'));
});

// ─── dispatch frame (internal single-frame primitive) ────────────────────────

test('dispatch frame: routes to executorsFrame with a fast-seek single-frame ffmpeg run', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({
    kind: 'frame',
    params: { source: 'clip.mp4', timeMs: 500, outKey: '/tmp/f.png', jobDir: '/tmp/jobs/g1', spawn, timeoutMs: 2000 },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.output, '/tmp/f.png');
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  assert.ok(args.includes('-ss') && args[args.indexOf('-ss') + 1] === '0.500', '500ms must render as fast-seek 0.500');
  assert.ok(args.includes('-frames:v') && args.includes('1'));
});

// ─── dispatch annotate → executorsAnnotate (drawtext + font preflight) ───────

test('dispatch annotate: routes to executorsAnnotate with an escaped drawtext ffmpeg run (fontFile envelope)', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({
    kind: 'annotate',
    params: {
      text: "O'Brien: Take 2", // schema surface (double-guarded)
      x: 40,
      y: 120,
      fontSizePx: 48,
      opacity: 0.9,
      source: '/img/scene.png', // envelope
      fontFile: '/fonts/DejaVuSans.ttf', // envelope — font for the drawtext pass
      outKey: '/tmp/scene.annotated.png',
      spawn,
      timeoutMs: 2000,
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.output, '/tmp/scene.annotated.png');
  assert.equal(r.result.text, "O'Brien: Take 2");
  assert.equal(r.result.fontFile, '/fonts/DejaVuSans.ttf');
  assert.equal(r.result.fontSize, 48, 'schema fontSizePx must reach the drawtext fontsize');
  assert.equal(spawn.calls.length, 1, 'annotate dispatch must spawn exactly once');
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  assert.equal(args[0], '-y');
  assert.equal(args[1], '-i');
  assert.equal(args[2], '/img/scene.png');
  const vfI = args.indexOf('-vf');
  assert.ok(vfI !== -1, 'annotate must carry -vf drawtext');
  assert.equal(
    args[vfI + 1],
    "drawtext=text='O\\'Brien\\: Take 2':x=40:y=120:fontfile=/fonts/DejaVuSans.ttf:fontsize=48:fontcolor=white@0.9"
  );
  assert.equal(args[args.length - 1], '/tmp/scene.annotated.png');
});

test('dispatch annotate: schema-valid but no fontFile and no ANNOTATE_FONT_PATH → MEDIA_ANNOTATE_FONT_UNAVAILABLE, no spawn', async () => {
  const prev = process.env.ANNOTATE_FONT_PATH;
  delete process.env.ANNOTATE_FONT_PATH;
  try {
    const spawn = makeFakeSpawn();
    const r = await dispatchToolRequest({
      kind: 'annotate',
      params: { text: 'Scene 1', source: 'a.png', outKey: '/tmp/o.png', spawn, timeoutMs: 2000 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDIA_ANNOTATE_FONT_UNAVAILABLE');
    assert.ok(r.message.includes('ANNOTATE_FONT_PATH'));
    assert.equal(spawn.calls.length, 0, 'no ffmpeg may spawn without a resolvable font');
  } finally {
    if (prev === undefined) delete process.env.ANNOTATE_FONT_PATH;
    else process.env.ANNOTATE_FONT_PATH = prev;
  }
});

test('dispatch annotate: env ANNOTATE_FONT_PATH supplies the font when no fontFile is passed', async () => {
  const prev = process.env.ANNOTATE_FONT_PATH;
  process.env.ANNOTATE_FONT_PATH = '/env/fonts/DejaVuSans.ttf';
  try {
    const spawn = makeFakeSpawn();
    const r = await dispatchToolRequest({
      kind: 'annotate',
      params: { text: 'env font', source: 'a.png', outKey: '/tmp/o.png', spawn, timeoutMs: 2000 },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const vfI = spawn.calls[0].args.indexOf('-vf');
    assert.ok(spawn.calls[0].args[vfI + 1].includes('fontfile=/env/fonts/DejaVuSans.ttf'),
      'ANNOTATE_FONT_PATH must reach the drawtext fontfile');
  } finally {
    if (prev === undefined) delete process.env.ANNOTATE_FONT_PATH;
    else process.env.ANNOTATE_FONT_PATH = prev;
  }
});

test('dispatch annotate: text over the 500-char registry cap → INVALID_PARAMS, executor never spawns', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({
    kind: 'annotate',
    params: { text: 'a'.repeat(501), source: 'a.png', fontFile: '/fonts/a.ttf', outKey: '/tmp/o.png', spawn, timeoutMs: 2000 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_PARAMS');
  assert.ok(Array.isArray(r.errors) && r.errors.some((e) => e.includes('"text"') && e.includes('500')));
  assert.equal(spawn.calls.length, 0, 'overlong text must be blocked by the double-guard before any executor runs');
});

// ─── NOT_IMPLEMENTED kinds (focus + provider-gated) ─────────────────────────

test('dispatch focus (native, executor missing) → EXECUTOR_NOT_IMPLEMENTED even with valid params', async () => {
  const r = await dispatchToolRequest({ kind: 'focus', params: { region: { x: 1, y: 1, w: 10, h: 10 }, strength: 50 } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXECUTOR_NOT_IMPLEMENTED');
  assert.ok(r.message.includes('focus'));
});

test('dispatch every provider-gated kind (enhance/outpaint/relight/inpaint/remove-bg/upscale) → EXECUTOR_NOT_IMPLEMENTED', async () => {
  const samples = {
    enhance: { strength: 0.5 },
    outpaint: { extendPx: 64 },
    relight: { prompt: 'soft key from the left' },
    inpaint: { region: { x: 1, y: 1, w: 5, h: 5 } },
    'remove-bg': {},
    upscale: { scale: 2 },
  };
  for (const [kind, params] of Object.entries(samples)) {
    const r = await dispatchToolRequest({ kind, params });
    assert.equal(r.ok, false, `kind ${kind} must not be executable`);
    assert.equal(r.code, 'EXECUTOR_NOT_IMPLEMENTED', `kind ${kind}`);
    assert.ok(r.message.includes('not implemented'), `kind ${kind}: ${r.message}`);
  }
});

// ─── unknown kind rejection ──────────────────────────────────────────────────

test('dispatch unknown kind → INVALID_TOOL (never spawns, checked before params)', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({ kind: 'morph', params: { anything: 1, spawn } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_TOOL');
  assert.ok(r.message.includes('morph'));
  assert.equal(spawn.calls.length, 0);
  const r2 = await dispatchToolRequest({ kind: '' });
  assert.equal(r2.code, 'INVALID_TOOL');
});

// ─── double-guard: registry schema surface is re-validated before exec ───────

test('dispatch grid rows=11 (registry [1,10]) → INVALID_PARAMS, executor never spawns', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({
    kind: 'grid',
    params: { rows: 11, cols: 2, sources: ['a.png', 'b.png'], outKey: '/tmp/s.png', spawn, timeoutMs: 2000 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_PARAMS');
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
  assert.ok(r.errors.some((e) => e.includes('"rows"')), `rows must be the flagged param (${r.errors.join(' | ')})`);
  assert.equal(spawn.calls.length, 0, 'an invalid tool param must never reach the executor');
});

test('dispatch grid cols=0 (registry [1,10]) → INVALID_PARAMS; rows/cols missing → INVALID_PARAMS', async () => {
  const spawn = makeFakeSpawn();
  const r1 = await dispatchToolRequest({ kind: 'grid', params: { rows: 2, cols: 0, sources: ['a.png', 'b.png'], outKey: '/tmp/s.png', spawn } });
  assert.equal(r1.code, 'INVALID_PARAMS');
  assert.ok(r1.errors.some((e) => e.includes('"cols"')));
  assert.equal(spawn.calls.length, 0);
  const r2 = await dispatchToolRequest({ kind: 'grid', params: { sources: ['a.png'], outKey: '/tmp/s.png' } });
  assert.equal(r2.code, 'INVALID_PARAMS');
  assert.ok(r2.errors.some((e) => e.includes('"rows"')), 'rows is required by the registry schema surface');
});

// ─── envelope keys are executor concerns (not contract violations) ──────────

test('dispatch grid: schema-valid but empty sources → executor MEDIA_SOURCE_MISSING, no spawn', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({
    kind: 'grid',
    params: { rows: 2, cols: 2, sources: [], outKey: '/tmp/s.png', spawn, timeoutMs: 2000 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_SOURCE_MISSING');
  assert.equal(spawn.calls.length, 0);
  // No params at all → the schema surface misses required rows/cols, so the
  // double-guard blocks it as INVALID_PARAMS before any executor runs.
  const r2 = await dispatchToolRequest({ kind: 'grid' });
  assert.equal(r2.code, 'INVALID_PARAMS');
  assert.ok(r2.errors.some((e) => e.includes('"rows"')));
});

test('dispatch grid: schema-valid but outKey missing → executor MEDIA_GRID_FAILED (structural, no spawn)', async () => {
  const spawn = makeFakeSpawn();
  const r = await dispatchToolRequest({
    kind: 'grid',
    params: { rows: 2, cols: 2, sources: ['a.png', 'b.png'], spawn, timeoutMs: 2000 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_GRID_FAILED');
  assert.ok(/outKey/.test(r.message));
  assert.equal(spawn.calls.length, 0);
});

// ─── module surface sanity ───────────────────────────────────────────────────

test('NATIVE_KINDS exposes exactly the implemented native runners grid + annotate + frame', () => {
  assert.deepEqual(Object.keys(NATIVE_KINDS).sort(), ['annotate', 'frame', 'grid']);
  assert.equal(typeof NATIVE_KINDS.grid.run, 'function');
  assert.equal(typeof NATIVE_KINDS.annotate.run, 'function');
  assert.equal(typeof NATIVE_KINDS.frame.run, 'function');
});
