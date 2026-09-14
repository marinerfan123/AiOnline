'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'pages', 'Admin', 'SystemSettingsPage.tsx'), 'utf8');

test('settings PUT merges JSON atomically in PostgreSQL', () => {
  assert.match(source, /SET value=settings\.value \|\| EXCLUDED\.value/);
  assert.doesNotMatch(source.slice(source.indexOf("url === '\/api\/settings' && method === 'PUT'"), source.indexOf('// ── OSS', source.indexOf("url === '\/api\/settings' && method === 'PUT'"))), /const existing =/);
});

test('system settings sends only owned fields and cannot replay stale unrelated fields', () => {
  assert.match(page, /await apiSaveSettings\(next\)/);
  assert.doesNotMatch(page, /apiSaveSettings\(\{ \.\.\.cur/);
});
