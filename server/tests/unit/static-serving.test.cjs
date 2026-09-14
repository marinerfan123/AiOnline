'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

test('hashed assets are immutable and gzip-compressed when accepted', () => {
  assert.match(source, /max-age=31536000, immutable/);
  assert.match(source, /Content-Encoding/);
  assert.match(source, /createGzip/);
});

test('static responses stream files instead of blocking readFileSync', () => {
  const start = source.indexOf('function serveStatic');
  const end = source.indexOf('// ─── 本地静态文件', start);
  const body = source.slice(start, end);
  assert.match(body, /fs\.createReadStream/);
  assert.doesNotMatch(body, /fs\.readFileSync/);
});

test('SPA route query strings do not break fallback resolution', () => {
  assert.match(source, /new URL\(req\.url, 'http:\/\/local'\)\.pathname/);
});
