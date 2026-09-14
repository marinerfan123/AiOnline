'use strict';
/**
 * P1-08: PostgreSQL TLS mode contract verification.
 *
 * Tests verify that the server.js SSL configuration produces
 * the correct pg.Pool ssl config for each PG_SSLMODE value.
 *
 * Contract:
 *   disable     → no SSL (ssl: undefined)
 *   prefer      → SSL if offered, no cert check (rejectUnauthorized: false)
 *   require     → encrypted transport, no CA check (rejectUnauthorized: false)
 *   verify-ca   → encrypted + CA validation (rejectUnauthorized: true)
 *   verify-full → CA validation + hostname verification
 *                (rejectUnauthorized: true + servername: host)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.resolve(__dirname, 'server.js'), 'utf8');

// Locate the SSL configuration block
const sslStart = serverJs.indexOf('PG SSL/TLS support');
assert.ok(sslStart !== -1, 'SSL configuration block must exist in server.js');
const sslEnd = serverJs.indexOf('pgPool = new Pool', sslStart);
assert.ok(sslEnd !== -1, 'Pool creation must follow SSL block');
const sslBlock = serverJs.slice(sslStart, sslEnd);

test('P1-08A: all SSL modes are handled', () => {
  const modes = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];
  for (const m of modes) {
    assert.ok(sslBlock.includes(`pgSslMode === '${m}'`),
      `Mode '${m}' must be handled in SSL configuration`);
  }
});

test('P1-08B: disable mode sets pgSsl to undefined', () => {
  assert.ok(sslBlock.includes("pgSslMode === 'disable'"), 'disable must exist');
  // Check the disable block contains pgSsl = undefined
  const disableBlock = sslBlock.match(/pgSslMode\s*===\s*'disable'[\s\S]{0,200}/);
  assert.ok(disableBlock, 'disable block must be found');
  assert.ok(disableBlock[0].includes('pgSsl = undefined') ||
            disableBlock[0].includes('pgSsl=undefined') ||
            disableBlock[0].includes("pgSsl = undefined"),
    'disable must set pgSsl to undefined');
});

test('P1-08C: prefer mode uses rejectUnauthorized:false', () => {
  const preferBlock = sslBlock.match(/pgSslMode\s*===\s*'prefer'[\s\S]{0,200}/);
  assert.ok(preferBlock, 'prefer block must be found');
  assert.ok(preferBlock[0].includes('rejectUnauthorized: false'),
    'prefer must use rejectUnauthorized:false');
});

test('P1-08D: require mode uses rejectUnauthorized:false (encryption-only)', () => {
  const requireBlock = sslBlock.match(/pgSslMode\s*===\s*'require'[\s\S]{0,200}/);
  assert.ok(requireBlock, 'require block must be found');
  assert.ok(requireBlock[0].includes('rejectUnauthorized: false'),
    'require must use rejectUnauthorized:false (encryption-only)');
});

test('P1-08E: verify-ca mode uses rejectAuthorization:true', () => {
  const verifyCaBlock = sslBlock.match(/pgSslMode\s*===\s*'verify-ca'[\s\S]{0,200}/);
  assert.ok(verifyCaBlock, 'verify-ca block must be found');
  assert.ok(verifyCaBlock[0].includes('rejectUnauthorized: true'),
    'verify-ca must use rejectUnauthorized:true');
});

test('P1-08F: verify-full includes servername for hostname verification', () => {
  const verifyFullBlock = sslBlock.match(/pgSslMode\s*===\s*'verify-full'[\s\S]{0,300}/);
  assert.ok(verifyFullBlock, 'verify-full block must be found');
  assert.ok(verifyFullBlock[0].includes('rejectUnauthorized: true'),
    'verify-full must use rejectUnauthorized:true');
  assert.ok(verifyFullBlock[0].includes('servername'),
    'verify-full must include servername for hostname verification');
});

test('P1-08G: verify-full and verify-ca are distinguishable', () => {
  // Extract the pgSsl assignment for each mode (just the line itself)
  const lines = sslBlock.split('\n');
  let caLine = null;
  let fullLine = null;
  for (const line of lines) {
    if (line.includes("pgSslMode === 'verify-ca'")) {
      // Next line should be the pgSsl assignment
      const idx = lines.indexOf(line);
      if (idx + 1 < lines.length) caLine = lines[idx + 1];
    }
    if (line.includes("pgSslMode === 'verify-full'")) {
      const idx = lines.indexOf(line);
      if (idx + 1 < lines.length) fullLine = lines[idx + 1];
    }
  }
  assert.ok(caLine, 'verify-ca pgSsl assignment must exist');
  assert.ok(fullLine, 'verify-full pgSsl assignment must exist');

  // verify-ca should only have rejectUnauthorized: true
  assert.ok(caLine.includes('rejectUnauthorized: true'), 'verify-ca must have rejectUnauthorized:true');
  assert.ok(!caLine.includes('servername'), 'verify-ca must NOT include servername');

  // verify-full must have servername for hostname verification
  assert.ok(fullLine.includes('rejectUnauthorized: true'), 'verify-full must have rejectUnauthorized:true');
  assert.ok(fullLine.includes('servername'), 'verify-full must include servername');

  // They must be different lines
  assert.notEqual(caLine.trim(), fullLine.trim(), 'verify-ca and verify-full must have different configs');
});

test('P1-08H: default SSL mode is prefer', () => {
  assert.ok(sslBlock.match(/PG_SSLMODE\s*\|\|\s*'prefer'/),
    'default PG_SSLMODE should be prefer');
});
