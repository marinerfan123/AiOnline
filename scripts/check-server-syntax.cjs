'use strict';
// scripts/check-server-syntax.cjs
// Fast syntax validation of all server/**/*.cjs and server/**/*.js files.
// Uses Node's parser (--check) — no runtime side effects.
// Exit 0 = all pass, 1 = any failure.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'server');

function listServerSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listServerSourceFiles(fullPath));
    else if (entry.isFile() && /\.(cjs|js)$/.test(entry.name)) files.push(path.relative(root, fullPath));
  }
  return files.sort();
}

try {
  const all = listServerSourceFiles(serverDir);

  let ok = 0;
  let fail = 0;
  const failures = [];

  for (const f of all) {
    try {
      execFileSync(process.execPath, ['--check', f], { cwd: root, stdio: 'pipe', timeout: 10000 });
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
