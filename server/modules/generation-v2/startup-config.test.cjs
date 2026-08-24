'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonConfigFile, loadWorkerStartupConfig, StartupConfigError } = require('./startup-config.cjs');

function tmpFile(name, content) {
  const p = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  if (content !== undefined) fs.writeFileSync(p, content);
  return p;
}

test('readJsonConfigFile returns {} for missing optional file', () => {
  const p = tmpFile('missing');
  assert.deepEqual(readJsonConfigFile(p), {});
});

test('readJsonConfigFile rejects missing required file with structured error', () => {
  const p = tmpFile('missing-required');
  assert.throws(
    () => readJsonConfigFile(p, { required: true, label: 'Evidence' }),
    (err) => err instanceof StartupConfigError && err.code === 'GENERATION_V2_STARTUP_CONFIG_INVALID' && /missing/.test(err.message)
  );
});

test('readJsonConfigFile rejects empty file instead of parsing raw SyntaxError', () => {
  const p = tmpFile('empty', '');
  assert.throws(
    () => readJsonConfigFile(p, { required: true, label: 'Evidence' }),
    (err) => err instanceof StartupConfigError && /empty/.test(err.message) && err.name === 'StartupConfigError'
  );
  fs.unlinkSync(p);
});

test('readJsonConfigFile rejects malformed JSON with structured error', () => {
  const p = tmpFile('bad', '{nope');
  assert.throws(
    () => readJsonConfigFile(p, { required: true, label: 'Evidence' }),
    (err) => Boolean(err instanceof StartupConfigError && /malformed JSON/.test(err.message) && err.details.cause)
  );
  fs.unlinkSync(p);
});

test('readJsonConfigFile accepts valid JSON object', () => {
  const p = tmpFile('valid', '{"unitPass":true}');
  assert.deepEqual(readJsonConfigFile(p, { required: true }), { unitPass: true });
  fs.unlinkSync(p);
});

test('readJsonConfigFile rejects non-object JSON', () => {
  const p = tmpFile('array', '[]');
  assert.throws(() => readJsonConfigFile(p, { required: true }), /JSON object/);
  fs.unlinkSync(p);
});

test('loadWorkerStartupConfig supports environment-only disabled worker', () => {
  assert.deepEqual(loadWorkerStartupConfig({ GENERATION_V2_WORKER_ENABLED: 'false' }), { enabled: false, evidence: {} });
  assert.deepEqual(loadWorkerStartupConfig({}), { enabled: false, evidence: {} });
});

test('loadWorkerStartupConfig validates evidence before subsystem initialization', () => {
  const p = tmpFile('dev-null-standin', '');
  assert.throws(
    () => loadWorkerStartupConfig({ GENERATION_V2_WORKER_ENABLED: 'true', GENERATION_V2_EVIDENCE_FILE: p }),
    (err) => err instanceof StartupConfigError && /empty/.test(err.message)
  );
  fs.unlinkSync(p);
});

test('loadWorkerStartupConfig loads valid enabled worker evidence', () => {
  const p = tmpFile('evidence', '{"unitPass":true}');
  const cfg = loadWorkerStartupConfig({ GENERATION_V2_WORKER_ENABLED: 'true', GENERATION_V2_EVIDENCE_FILE: p });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.evidencePath, p);
  assert.deepEqual(cfg.evidence, { unitPass: true });
  fs.unlinkSync(p);
});
