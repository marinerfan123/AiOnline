'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  buildAnnotateCommand,
  runAnnotate,
  escapeDrawText,
  resolveFontFile,
  MAX_TEXT_LENGTH,
  DEFAULT_FONTSIZE,
  DEFAULT_FONT_COLOR,
  FONT_ENV,
} = require('./executorsAnnotate.cjs');

/** Fake spawn matching executorsGrid.test.cjs (EventEmitter child + streams). */
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

/** Pull the -vf value out of an args array ({ v: value|null }). */
function vfOf(args) {
  const vi = args.indexOf('-vf');
  return vi === -1 ? null : args[vi + 1];
}

// ─── escapeDrawText: single quotes / colons / backslashes ────────────────────

test('escapeDrawText: quotes, colons and backslashes are made inert for the ffmpeg filter parser', () => {
  assert.equal(escapeDrawText("O'Brien: Take 2"), "O\\'Brien\\: Take 2");
  // backslash is doubled FIRST so it cannot swallow a later \' escape
  assert.equal(escapeDrawText("C:\\temp\\a'b"), "C\\:\\\\temp\\\\a\\'b");
  assert.equal(escapeDrawText('plain'), 'plain');
  assert.equal(escapeDrawText(''), '');
  assert.equal(escapeDrawText(42), '42');
});

// ─── buildAnnotateCommand: happy paths ───────────────────────────────────────

test('buildAnnotateCommand: default drawtext shape (center x/y, fontsize 28, white) with quoted escaped text', () => {
  const cmd = buildAnnotateCommand({
    source: '/img/scene.png',
    text: "O'Brien: Take 2",
    outKey: '/tmp/scene.annotated.png',
  });
  assert.equal(cmd.output, '/tmp/scene.annotated.png');
  assert.equal(cmd.fontFile, null);
  assert.equal(cmd.fontSize, DEFAULT_FONTSIZE);
  assert.equal(cmd.args[0], '-y');
  assert.equal(cmd.args[1], '-i');
  assert.equal(cmd.args[2], '/img/scene.png');
  assert.equal(cmd.args[cmd.args.length - 1], '/tmp/scene.annotated.png');
  const filter = vfOf(cmd.args);
  assert.ok(filter, 'annotate must carry -vf');
  assert.equal(filter, cmd.filter);
  assert.equal(
    filter,
    "drawtext=text='O\\'Brien\\: Take 2':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=28:fontcolor=white",
    'single quotes and colons in text must be escaped inside the single-quoted drawtext value'
  );
  assert.ok(!filter.includes('fontfile='), 'no fontfile segment when none is provided');
});

test('buildAnnotateCommand: explicit x/y/fontSizePx/opacity/fontFile are wired through in spec option order', () => {
  const cmd = buildAnnotateCommand({
    source: 'a.png',
    text: 'Scene 1',
    outKey: 'o.png',
    fontFile: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    x: 40,
    y: 120,
    fontSizePx: 48,
    opacity: 0.5,
  });
  assert.equal(cmd.fontFile, '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  assert.equal(cmd.fontSize, 48);
  assert.equal(cmd.x, 40);
  assert.equal(cmd.y, 120);
  const filter = vfOf(cmd.args);
  assert.ok(filter.startsWith("drawtext=text='Scene 1':x=40:y=120:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontsize=48:fontcolor=white@0.5"),
    `options must follow text→x→y→fontfile→fontsize→fontcolor order (got "${filter}")`);
});

test('buildAnnotateCommand: opacity omitted or 1 keeps plain fontcolor=white', () => {
  const a = buildAnnotateCommand({ source: 'a.png', text: 'x', outKey: 'o.png' });
  assert.ok(a.filter.includes(`:fontcolor=${DEFAULT_FONT_COLOR}`));
  assert.ok(!a.filter.includes('@'));
  const b = buildAnnotateCommand({ source: 'a.png', text: 'x', outKey: 'o.png', opacity: 1 });
  assert.equal(b.filter, a.filter);
});

test('buildAnnotateCommand: text exactly at the 500-char cap is accepted; 501 is rejected', () => {
  const ok = 'a'.repeat(MAX_TEXT_LENGTH);
  const cmd = buildAnnotateCommand({ source: 'a.png', text: ok, outKey: 'o.png' });
  assert.equal(cmd.text.length, MAX_TEXT_LENGTH);
  assert.throws(
    () => buildAnnotateCommand({ source: 'a.png', text: 'a'.repeat(MAX_TEXT_LENGTH + 1), outKey: 'o.png' }),
    /≤ 500 chars \(got 501\)/
  );
});

// ─── buildAnnotateCommand: structural violations ─────────────────────────────

test('buildAnnotateCommand: throws on missing source / text / outKey', () => {
  assert.throws(() => buildAnnotateCommand({ text: 'hi', outKey: 'o.png' }), /source/);
  assert.throws(() => buildAnnotateCommand({ source: '', text: 'hi', outKey: 'o.png' }), /source/);
  assert.throws(() => buildAnnotateCommand({ source: 'a.png', outKey: 'o.png' }), /non-empty text/);
  assert.throws(() => buildAnnotateCommand({ source: 'a.png', text: '   ', outKey: 'o.png' }), /non-empty text/);
  assert.throws(() => buildAnnotateCommand({ source: 'a.png', text: 'hi' }), /outKey/);
  assert.throws(() => buildAnnotateCommand({ source: 'a.png', text: 'hi', outKey: '' }), /outKey/);
});

test('buildAnnotateCommand: throws on out-of-range / non-integer geometry and a bad fontFile', () => {
  const base = { source: 'a.png', text: 'hi', outKey: 'o.png' };
  assert.throws(() => buildAnnotateCommand({ ...base, fontSizePx: 7 }), /fontSizePx/);
  assert.throws(() => buildAnnotateCommand({ ...base, fontSizePx: 201 }), /fontSizePx/);
  assert.throws(() => buildAnnotateCommand({ ...base, fontSizePx: 28.5 }), /fontSizePx/);
  assert.throws(() => buildAnnotateCommand({ ...base, fontSizePx: '28' }), /fontSizePx/);
  assert.throws(() => buildAnnotateCommand({ ...base, x: -1 }), /x/);
  assert.throws(() => buildAnnotateCommand({ ...base, x: 100001 }), /x/);
  assert.throws(() => buildAnnotateCommand({ ...base, x: 1.5 }), /x/);
  assert.throws(() => buildAnnotateCommand({ ...base, y: 3.7 }), /y/);
  assert.throws(() => buildAnnotateCommand({ ...base, opacity: -0.1 }), /opacity/);
  assert.throws(() => buildAnnotateCommand({ ...base, opacity: 1.1 }), /opacity/);
  assert.throws(() => buildAnnotateCommand({ ...base, opacity: 'high' }), /opacity/);
  assert.throws(() => buildAnnotateCommand({ ...base, fontFile: '' }), /fontFile/);
  assert.throws(() => buildAnnotateCommand({ ...base, fontFile: 42 }), /fontFile/);
});

// ─── resolveFontFile: explicit path wins over ANNOTATE_FONT_PATH ─────────────

test('resolveFontFile: fontFile param wins, env path is the fallback, none → null', () => {
  assert.equal(resolveFontFile('/fonts/a.ttf', {}), '/fonts/a.ttf');
  assert.equal(resolveFontFile('', { [FONT_ENV]: '/env/b.ttf' }), '/env/b.ttf');
  assert.equal(resolveFontFile(undefined, { [FONT_ENV]: '/env/b.ttf' }), '/env/b.ttf');
  assert.equal(resolveFontFile(undefined, {}), null);
  assert.equal(resolveFontFile(undefined, undefined), null);
  assert.equal(resolveFontFile('   ', { [FONT_ENV]: '/env/b.ttf' }), '/env/b.ttf');
  assert.equal(resolveFontFile('/fonts/a.ttf', { [FONT_ENV]: '/env/b.ttf' }), '/fonts/a.ttf');
});

// ─── runAnnotate: font preflight (no spawn when no font is resolvable) ──────

test('runAnnotate: no fontFile and no ANNOTATE_FONT_PATH → MEDIA_ANNOTATE_FONT_UNAVAILABLE, never spawns', async () => {
  const spawn = makeFakeSpawn();
  const r = await runAnnotate({
    source: 'a.png',
    text: 'hi',
    outKey: '/tmp/o.png',
    env: {}, // isolated env seam — no host font interference
    spawn,
    timeoutMs: 2000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_ANNOTATE_FONT_UNAVAILABLE');
  assert.ok(r.message.includes(FONT_ENV), 'message must point at ANNOTATE_FONT_PATH');
  assert.equal(spawn.calls.length, 0, 'no ffmpeg may spawn without a resolvable font');
});

test('runAnnotate: env seam with ANNOTATE_FONT_PATH set → real run, fontfile from env', async () => {
  const spawn = makeFakeSpawn();
  const r = await runAnnotate({
    source: 'a.png',
    text: 'env font',
    outKey: '/tmp/o.png',
    env: { [FONT_ENV]: '/env/fonts/Custom.ttf' },
    spawn,
    timeoutMs: 2000,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.output, '/tmp/o.png');
  assert.equal(r.result.fontFile, '/env/fonts/Custom.ttf');
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const filter = vfOf(spawn.calls[0].args);
  assert.ok(filter.includes('fontfile=/env/fonts/Custom.ttf'), `env font must reach drawtext (got "${filter}")`);
});

test('runAnnotate: explicit fontFile beats env, exit 0 → ok with escaped drawtext args', async () => {
  const spawn = makeFakeSpawn();
  const r = await runAnnotate({
    source: '/img/scene.png',
    text: "O'Brien: Take 2",
    outKey: '/tmp/scene.annotated.png',
    fontFile: '/fonts/DejaVuSans.ttf',
    env: { [FONT_ENV]: '/env/ignored.ttf' },
    spawn,
    timeoutMs: 2000,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.output, '/tmp/scene.annotated.png');
  assert.equal(r.result.text, "O'Brien: Take 2");
  assert.equal(r.result.fontFile, '/fonts/DejaVuSans.ttf');
  assert.equal(r.result.fontSize, DEFAULT_FONTSIZE);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].bin, 'ffmpeg');
  const args = spawn.calls[0].args;
  assert.equal(args[0], '-y');
  assert.ok(args.includes('-i') && args.includes('/img/scene.png'));
  assert.equal(args[args.length - 1], '/tmp/scene.annotated.png');
  const filter = vfOf(args);
  assert.equal(
    filter,
    "drawtext=text='O\\'Brien\\: Take 2':x=(w-text_w)/2:y=(h-text_h)/2:fontfile=/fonts/DejaVuSans.ttf:fontsize=28:fontcolor=white"
  );
});

// ─── runAnnotate: structural guards + failure mapping ───────────────────────

test('runAnnotate: overlong text (501) → MEDIA_ANNOTATE_FAILED, no spawn (text cap enforced before ffmpeg)', async () => {
  const spawn = makeFakeSpawn();
  const r = await runAnnotate({
    source: 'a.png',
    text: 'a'.repeat(MAX_TEXT_LENGTH + 1),
    outKey: '/tmp/o.png',
    fontFile: '/fonts/DejaVuSans.ttf',
    env: {},
    spawn,
    timeoutMs: 2000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_ANNOTATE_FAILED');
  assert.ok(/≤ 500 chars \(got 501\)/.test(r.message));
  assert.equal(spawn.calls.length, 0);
});

test('runAnnotate: missing source → MEDIA_SOURCE_MISSING; structural violations → MEDIA_ANNOTATE_FAILED (no spawn)', async () => {
  const spawn = makeFakeSpawn();
  const r1 = await runAnnotate({ text: 'hi', outKey: '/tmp/o.png', fontFile: '/fonts/a.ttf', env: {}, spawn });
  assert.equal(r1.code, 'MEDIA_SOURCE_MISSING');
  const r2 = await runAnnotate({ source: 'a.png', text: '', outKey: '/tmp/o.png', fontFile: '/fonts/a.ttf', env: {}, spawn });
  assert.equal(r2.code, 'MEDIA_ANNOTATE_FAILED');
  const r3 = await runAnnotate({ source: 'a.png', text: 'hi', fontFile: '/fonts/a.ttf', env: {}, spawn });
  assert.equal(r3.code, 'MEDIA_ANNOTATE_FAILED');
  const r4 = await runAnnotate({ source: 'a.png', text: 'hi', outKey: '/tmp/o.png', x: 999999999, fontFile: '/fonts/a.ttf', env: {}, spawn });
  assert.equal(r4.code, 'MEDIA_ANNOTATE_FAILED');
  assert.equal(spawn.calls.length, 0, 'structural violations must never reach ffmpeg');
});

test('runAnnotate: spawn ENOENT → MEDIA_FFMPEG_UNAVAILABLE', async () => {
  const spawn = makeFakeSpawn({ enoent: true });
  const r = await runAnnotate({ source: 'a.png', text: 'hi', outKey: '/tmp/o.png', fontFile: '/fonts/a.ttf', env: {}, spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_FFMPEG_UNAVAILABLE');
  assert.ok(r.message.length > 0);
});

test('runAnnotate: non-zero exit → MEDIA_ANNOTATE_FAILED with stderr message', async () => {
  const spawn = makeFakeSpawn({ exitCode: 1, stderrData: [Buffer.from('Cannot find a valid font for the family')] });
  const r = await runAnnotate({ source: 'a.png', text: 'hi', outKey: '/tmp/o.png', fontFile: '/fonts/a.ttf', env: {}, spawn, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_ANNOTATE_FAILED');
  assert.ok(r.message.includes('Cannot find a valid font'));
});

test('runAnnotate: no close within timeoutMs → kill() + MEDIA_ANNOTATE_TIMEOUT', async () => {
  const spawn = makeFakeSpawn({ emitClose: false });
  const r = await runAnnotate({ source: 'a.png', text: 'hi', outKey: '/tmp/o.png', fontFile: '/fonts/a.ttf', env: {}, spawn, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MEDIA_ANNOTATE_TIMEOUT');
  assert.equal(spawn.calls.length, 1);
  assert.ok(spawn.calls[0].child.killed, 'child.kill() must have been called on timeout');
});

test('runAnnotate: reads the REAL process.env.ANNOTATE_FONT_PATH when no ctx.env/fontFile given', async () => {
  const before = process.env[FONT_ENV];
  process.env[FONT_ENV] = '/env/real-ttf.ttf';
  try {
    const spawn = makeFakeSpawn();
    const r = await runAnnotate({ source: 'a.png', text: 'real env', outKey: '/tmp/o.png', spawn, timeoutMs: 2000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(vfOf(spawn.calls[0].args).includes('fontfile=/env/real-ttf.ttf'));
  } finally {
    if (before === undefined) delete process.env[FONT_ENV];
    else process.env[FONT_ENV] = before;
  }
});

// ─── real ffmpeg smoke test (run only when ffmpeg + drawtext + a font exist) ─

test('annotate real-ffmpeg smoke: drawtext overlays text onto a generated PNG (fontFile path)', { timeout: 60000 }, async (t) => {
  const hasFfmpeg = await new Promise((resolve) => {
    try {
      const p = require('node:child_process').spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (c) => resolve(c === 0));
    } catch { resolve(false); }
  });
  if (!hasFfmpeg) { t.skip('ffmpeg not installed on this host — real smoke test not run'); return; }
  const hasDrawtext = await new Promise((resolve) => {
    try {
      const p = require('node:child_process').spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString('utf8'); });
      p.on('error', () => resolve(false));
      p.on('close', () => resolve(/drawtext/.test(out)));
    } catch { resolve(false); }
  });
  if (!hasDrawtext) { t.skip('this ffmpeg build has no drawtext filter — real smoke test not run'); return; }
  const fontCandidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ];
  const fontPath = fontCandidates.find((f) => fs.existsSync(f));
  if (!fontPath) { t.skip('no TrueType font found on this host — real smoke test not run'); return; }

  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-smoke-'));
  try {
    const src = path.join(jobDir, 'src.png');
    const gen = await new Promise((resolve) => {
      const p = require('node:child_process').spawn(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=steelblue:s=640x360', '-frames:v', '1', src],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      p.stderr.resume();
      p.on('close', resolve);
    });
    assert.equal(gen, 0, 'ffmpeg must generate the fixture');

    // Text that would break an UNESCAPED drawtext value: single quotes + colons.
    const out = path.join(jobDir, 'annotated.png');
    const r = await runAnnotate({
      source: src,
      text: "O'Brien: Take 2 — real",
      outKey: out,
      fontFile: fontPath,
      x: 10,
      y: 10,
      timeoutMs: 30000,
    });
    assert.equal(r.ok, true, `real drawtext annotate must succeed (${JSON.stringify(r)})`);
    assert.equal(r.result.output, out);
    assert.equal(r.result.fontFile, fontPath);
    assert.ok(fs.existsSync(out), 'annotated output must exist');
    const buf = fs.readFileSync(out);
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'output must be a real PNG');
    assert.ok(buf.length > 0, 'annotated output must not be empty');
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
