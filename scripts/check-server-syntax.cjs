'use strict';
// scripts/check-server-syntax.cjs
// Fast syntax validation of all server/**/*.cjs and server/**/*.js files.
// Uses Node's parser (--check) — no runtime side effects.
// Exit 0 = all pass, 1 = any failure.

const { execSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'server');

try {
  const all = execSync('find server -name "*.cjs" -o -name "*.js"', {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  })
    .trim()
    .split('\n')
    .filter(Boolean);

  let ok = 0;
  let fail = 0;
  const failures = [];

  for (const f of all) {
    try {
      execSync(`node --check "${f}"`, {
        cwd: root,
        stdio: 'pipe',
        timeout: 10000,
      });
      ok++;
    } catch (e) {
      fail++;
      failures.push(f);
    }
  }

  console.log(`SYNTAX: ${all.length} files, ${ok} pass, ${fail} fail`);

  if (fail > 0) {
    console.error('Failed files:');
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    process.exit(1);
  }

  process.exit(0);
} catch (e) {
  console.error('Syntax check failed:', e.message);
  process.exit(1);
}
