'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  buildGridCommand,
  runGrid,
  DEFAULT_COLS,
  MAX_SOURCES,
  MAX_COLS,
  CELL_HEIGHT,
} = require('./executorsGrid.cjs');

/** Fake spawn matching executorsStitch.test.cjs (EventEmitter child + streams). */
function makeFakeSpawn(opts = {}) {
  const {
    enoent = false,
    exitCode = 0,
    stdoutData = [],
    stderrData = [],
    errorAfterSpawn = null,
    emitClose = true,
    async: emitAsync = true,
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
    child.kill = (sig) => { child.killed = { sig }; };
    fn.calls.push({ bin, args, child });
    const fire = () => {
      if (errorAfterSpawn) { child.emit('error', errorAfterSpawn); return; }
      for (const d of stdoutData) child.stdout.emit('data', d);
      for (const d of stderrData) child.stderr.emit('data', d);
      if (emitClose) child.emit('close', exitCode);
    };
    if (emitAsync) setImmediate(fire); else fire();
    return child;
  };
  fn.calls = [];
  return fn;
}

/** Pull the -filter_complex value out of an args array ({ v: value|null }). */
function filterOf(args) {
  const fi = args.indexOf('-filter_complex');
  return fi === -1 ? null : args[fi + 1];
}

// ─── buildGridCommand: happy paths ───────────────────────────────────────────

test('buildGridCommand: 4 sources cols=2 → one xstack, uniform-720 scale chain, row-major layout', () => {
  const cmd = buildGridCommand({
    sources: ['/img/a.png', '/img/b.jpg', '/img/c.png', '/img/d.jpg'],
    outKey: '/tmp/sheet.png',
  });
  assert.equal(cmd.output, '/tmp/sheet.png');
  assert.equal(cmd.sources, 4);
  assert.equal(cmd.cols, DEFAULT_COLS);
  assert.equal(cmd.rows, 2);

  const args = cmd.args;
  assert.equal(args[0], '-y');
  assert.equal(args.filter((a) => a === '-i').length, 4, 'one -i per source');
  assert.ok(args.includes('/img/a.png') && args.includes('/img/d.jpg'));
  assert.equal(args[args.length - 1], '/tmp/sheet.png');

  const filter = filterOf(args);
  assert.ok(filter, 'multi-source grid must carry -filter_complex');
  assert.equal(filter, cmd.filter);
  assert.ok(filter.includes('xstack=inputs=4:'), 'filter must contain xstack with inputs=4');
  assert.ok(filter.includes('layout='), 'filter must contain an xstack layout');
  // every input pre-scaled to uniform 720 cell height, width forced even
  const scaleCount = (filter.match(/scale=trunc\(iw\*720\/ih\/2\)\*2:720/g) || []).length;
  assert.equal(scaleCount, 4, 'every source must be scaled to a uniform 720px height first');
  // 2x2 row-major: cell0 (0,0), cell1 (right of w0), cell2 (row1), cell3 (row1, right of w2)
  assert.ok(filter.endsWith('[s0][s1][s2][s3]xstack=inputs=4:layout=0_0|w0_0|0_720|w2_720[v]'),
    `2x2 layout must be 0_0|w0_0|0_720|w2_720 (got "${cmd.layout}")`);
  // -map [v] precedes the output path
  const mapI = args.indexOf('-map');
  assert.ok(mapI !== -1);
  assert.equal(args[mapI + 1], '[v]');
});

test('buildGridCommand: 3 sources cols=3 → width-accumulating layout for a full row', () => {
  const cmd = buildGridCommand({ sources: ['a.png', 'b.png', 'c.png'], cols: 3, outKey: 'o.png' });
  assert.equal(cmd.rows, 1);
  assert.ok(cmd.filter.endsWith('xstack=inputs=3:layout=0_0|w0_0|w0+w1_0[v]'),
    `3-wide row must accumulate widths (got "${cmd.layout}")`);
});

test('buildGridCommand: 5 sources cols=2 → rows=3, ragged last row keeps row-local sums', () => {
  const cmd = buildGridCommand({ sources: ['a', 'b', 'c', 'd', 'e'], outKey: 'o.png' });
  assert.equal(cmd.rows, 3);
  assert.equal(cmd.layout, '0_0|w0_0|0_720|w2_720|0_1440');
  assert.ok(cmd.filter.endsWith('[s0][s1][s2][s3][s4]xstack=inputs=5:layout=0_0|w0_0|0_720|w2_720|0_1440[v]'));
});

test('buildGridCommand: cols defaults to 2 and may be given explicitly at max', () => {
  const a = buildGridCommand({ sources: ['a', 'b'], outKey: 'o.png' });
  assert.equal(a.cols, DEFAULT_COLS);
  const b = buildGridCommand({ sources: ['a', 'b'], cols: 1, outKey: 'o.png' });
  assert.equal(b.rows, 2);
  assert.equal(b.layout, '0_0|0_720');
  const c = buildGridCommand({ sources: Array.from({ length: 9 }, (_, i) => `s${i}`), cols: MAX_COLS, outKey: 'o.png' });
  assert.equal(c.cols, MAX_COLS);
  assert.equal(c.rows, 1);
});

test('buildGridCommand: single source → same uniform-height scale chain, no xstack (xstack min inputs is 2)', () => {
  const cmd = buildGridCommand({ sources: ['only.png'], outKey: 'o.png' });
  assert.equal(cmd.sources, 1);
  assert.equal(cmd.rows, 1);
  assert.ok(filterOf(cmd.args) === null, 'single source must not use -filter_complex/xstack');
  const vfI = cmd.args.indexOf('-vf');
  assert.ok(vfI !== -1);
  assert.ok(cmd.args[vfI + 1].includes(`scale=trunc(iw*${CELL_HEIGHT}/ih/2)*2:${CELL_HEIGHT}`));
  assert.equal(cmd.args[0], '-y');
  assert.equal(cmd.args[1], '-i');
  assert.equal(cmd.args[2], 'only.png');
  assert.equal(cmd.args[cmd.args.length - 1], 'o.png');
});

test('buildGridCommand: scale chain normalizes SAR and pixel format before stacking', () => {
  const cmd = buildGridCommand({ sources: ['a.png', 'b.png'], outKey: 'o.png' });
  const chain = cmd.filter.slice(0, cmd.filter.indexOf(';'));
  assert.ok(chain.endsWith('setsar=1,format=rgb24[s0]'), 'each chain must force setsar=1 + rgb24 so xstack inputs agree');
});

// ─── buildGridCommand: validation failures ───────────────────────────────────

test('buildGridCommand: throws when sources is missing or not an array', () => {
  assert.throws(() => buildGridCommand({ outKey: 'o.png' }), /sources array/);
  assert.throws(() => buildGridCommand({ sources: 'nope', outKey: 'o.png' }), /sources array/);
  assert.throws(() => buildGridCommand({ sources: null, outKey: 'o.png' }), /sources array/);
});

test('buildGridCommand: throws on fewer than 1 source and above 9 sources', () => {
  assert.throws(() => buildGridCommand({ sources: [], outKey: 'o.png' }), /at least one source/);
  const many = Array.from({ length: MAX_SOURCES + 1 }, () => 's.png');
  assert.throws(() => buildGridCommand({ sources: many, outKey: 'o.png' }), /at most 9 sources/);
  const ok = Array.from({ length: MAX_SOURCES }, () => 's.png');
  assert.equal(buildGridCommand({ sources: ok, outKey: 'o.png' }).sources, MAX_SOURCES);
});

test('buildGridCommand: throws when a source entry is not a non-empty string', () => {
  assert.throws(() => buildGridCommand({ sources: ['a.png', 42], outKey: 'o.png' }), /source 1/);
  assert.throws(() => buildGridCommand({ sources: ['a.png', ''], outKey: 'o.png' }), /source 1/);
});

test('buildGridCommand: throws when cols is missing-style invalid (0 / negative / fraction / string / above max)', () => {
  assert.throws(() => buildGridCommand({ sources: ['a', 'b'], cols: 0, outKey: 'o.png' }), /cols/);
  assert.throws(() => buildGridCommand({ sources: ['a', 'b'], cols: -3, outKey: 'o.png' }), /cols/);
  assert.throws(() => buildGridCommand({ sources: ['a', 'b'], cols: 1.5, outKey: 'o.png' }), /cols/);
  assert.throws(() => buildGridCommand({ sources: ['a', 'b'], cols: '2', outKey: 'o.png' }), /cols/);
  assert.throws(() => buildGridCommand({ sources: ['a', 'b'], cols: MAX_COLS + 1, outKey: 'o.png' }), /cols/);
});

test('buildGridCommand: throws without an outKey output path', () => {
  assert.throws(() => buildGridCommand({ sources: ['a.png', 'b.png'] }), /outKey/);
  assert.throws(() => buildGridCommand({ sources: ['a.png', 'b.png'], outKey: '' }), /outKey/);
});

// ─── runGrid: success ────────────────────────────────────────────────────────

test('runGrid: exit 0 → ok with output/sources/cols/rows; ffmpeg receives xstack layout', async () => {
  const spawn = makeFakeSpawn();
  const r = await runGrid({
    sources: ['/img/a.png', '/img/b.png', '/img/c.png', '/img/d.png'],
    outKey: '/tmp/sheet.png',
    spawn,
    timeoutMs: 2000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.output, '/tmp/sheet.png');
  assert.equal(r.result.sources, 4);
  assert.equal(r.result.cols, DEFAULT_COLS);
  assert.equal(r.result.rows, 2);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  const fi = args.indexOf('-filter_complex');
  assert.ok(fi !== -1);
  assert.ok(args[fi + 1].includes('xstack=inputs=4:layout=0_0|w0_0|0_720|w2_720'));
  assert.ok(args.includes('-map') && args.includes('[v]'));
  assert.equal(args[args.length - 1], '/tmp/sheet.png');
});

test('runGrid: single source exits 0 → ok; args carry -vf scale (no xstack)', async () => {
  const spawn = makeFakeSpawn();
  const r = await runGrid({ sources: ['only.png'], outKey: '/tmp/one.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.result.output, '/tmp/one.png');
  assert.equal(r.result.rows, 1);
  assert.ok(spawn.calls[0].args.includes('-vf'));
});

// ─── runGrid: failure paths ──────────────────────────────────────────────────

test('runGrid: spawn ENOENT → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const spawn = makeFakeSpawn({ enoent: true });
  const r = await runGrid({ sources: ['a.png', 'b.png'], outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
  assert.ok(r.message.length > 0);
});

test('runGrid: ENOENT error emitted after spawn → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const e = new Error('spawn ffmpeg ENOENT');
  e.code = 'ENOENT';
  const spawn = makeFakeSpawn({ errorAfterSpawn: e });
  const r = await runGrid({ sources: ['a.png', 'b.png'], outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
});

test('runGrid: non-zero exit → MEDIA_GRID_FAILED with stderr message', async () => {
  const spawn = makeFakeSpawn({ exitCode: 1, stderrData: [Buffer.from('Error initializing complex filters.')] });
  const r = await runGrid({ sources: ['a.png', 'b.png'], outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_GRID_FAILED');
  assert.ok(r.message.includes('Error initializing complex filters.'));
});

test('runGrid: no close within timeoutMs → kill() + MEDIA_GRID_TIMEOUT', async () => {
  const spawn = makeFakeSpawn({ emitClose: false });
  const r = await runGrid({ sources: ['a.png', 'b.png'], outKey: 'o.png', spawn, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_GRID_TIMEOUT');
  assert.equal(spawn.calls.length, 1);
  assert.ok(spawn.calls[0].child.killed, 'child.kill() must have been called on timeout');
});

test('runGrid: missing/empty/short sources or a bad entry → MEDIA_SOURCE_MISSING (no spawn)', async () => {
  const spawn = makeFakeSpawn();
  const r1 = await runGrid({ sources: [], outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'MEDIA_SOURCE_MISSING');
  const r2 = await runGrid({ spawn, timeoutMs: 2000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'MEDIA_SOURCE_MISSING');
  const r3 = await runGrid({ sources: ['a.png', 7], outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'MEDIA_SOURCE_MISSING');
  const r4 = await runGrid({ sources: ['a.png', ''], outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'MEDIA_SOURCE_MISSING');
  assert.equal(spawn.calls.length, 0, 'no ffmpeg spawn may happen when a source is missing');
});

test('runGrid: structural validation violation (cols=0, 10 sources) → MEDIA_GRID_FAILED, no spawn', async () => {
  const spawn = makeFakeSpawn();
  const r1 = await runGrid({ sources: ['a.png', 'b.png'], cols: 0, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'MEDIA_GRID_FAILED');
  assert.ok(/cols/.test(r1.message));
  const many = Array.from({ length: MAX_SOURCES + 1 }, () => 's.png');
  const r2 = await runGrid({ sources: many, outKey: 'o.png', spawn, timeoutMs: 2000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'MEDIA_GRID_FAILED');
  assert.ok(/at most 9 sources/.test(r2.message));
  const r3 = await runGrid({ sources: ['a.png', 'b.png'], outKey: '', spawn, timeoutMs: 2000 });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'MEDIA_GRID_FAILED');
  assert.equal(spawn.calls.length, 0);
});

// ─── runGrid: real ffmpeg smoke test (run only when ffmpeg exists) ──────────

test('grid real-ffmpeg smoke: 5 mixed-aspect PNG+JPG sources → contact sheet PNG with expected canvas', { timeout: 60000 }, async (t) => {
  const hasFfmpeg = await new Promise((resolve) => {
    try {
      const p = require('node:child_process').spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (c) => resolve(c === 0));
    } catch { resolve(false); }
  });
  if (!hasFfmpeg) {
    t.skip('ffmpeg not installed on this host — real smoke test not run');
    return;
  }
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-smoke-'));
  try {
    // Fixtures with DIFFERENT sizes/aspects (incl. one JPG → exercises rgb24 normalize):
    // scaled to 720px cell height: a 320x240→960x720 | b 400x240→1200x720 (row0 w=2160)
    //                                 c 240x180→960x720  | d 500x240→1500x720 (row1 w=2460)
    //                                 e 360x120→2160x720 (row2 w=2160)
    const specs = [
      ['a.png', 'red', '320x240'],
      ['b.jpg', 'green', '400x240'],
      ['c.png', 'blue', '240x180'],
      ['d.png', 'yellow', '500x240'],
      ['e.png', 'cyan', '360x120'],
    ];
    const paths = {};
    for (const [file, color, size] of specs) {
      paths[file] = path.join(jobDir, file);
      const gen = await new Promise((resolve) => {
        const p = require('node:child_process').spawn(
          'ffmpeg',
          ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', paths[file]],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        p.stderr.resume();
        p.on('close', resolve);
      });
      assert.equal(gen, 0, `ffmpeg must generate fixture ${file}`);
    }

    const out = path.join(jobDir, 'sheet.png');
    const r = await runGrid({ sources: Object.values(paths), cols: 2, outKey: out, timeoutMs: 30000 });
    assert.equal(r.ok, true, `real 5-tile grid must succeed (${JSON.stringify(r)})`);
    assert.equal(r.result.output, out);
    assert.equal(r.result.rows, 3);
    assert.ok(fs.existsSync(out), 'grid output file must exist');
    const stat = fs.statSync(out);
    assert.ok(stat.size > 0, 'grid output must not be empty');
    const ihdr = fs.readFileSync(out);
    assert.deepEqual([...ihdr.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'output must be a real PNG');
    const width = ihdr.readUInt32BE(16);
    const height = ihdr.readUInt32BE(20);
    assert.equal(height, 3 * CELL_HEIGHT, `sheet must be 3 rows x 720px tall (got h=${height})`);
    assert.equal(width, 2460, `sheet width must be the widest row 2160/2460 (got w=${width})`);

    // Single-source grid → 720px-tall single cell, no xstack involved.
    const oneOut = path.join(jobDir, 'one.png');
    const one = await runGrid({ sources: [paths['a.png']], outKey: oneOut, timeoutMs: 30000 });
    assert.equal(one.ok, true, `real single-source grid must succeed (${JSON.stringify(one)})`);
    const ihdr1 = fs.readFileSync(oneOut);
    assert.equal(ihdr1.readUInt32BE(20), CELL_HEIGHT, 'single-cell sheet must be 720px tall');

    // Real failure mapping: nonexistent source → non-zero → MEDIA_GRID_FAILED.
    const bad = await runGrid({ sources: [path.join(jobDir, 'nope.png'), paths['a.png']], outKey: path.join(jobDir, 'x.png'), timeoutMs: 30000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'MEDIA_GRID_FAILED');
    assert.ok(bad.message.length > 0);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
