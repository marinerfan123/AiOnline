'use strict';
// scripts/quality-gate.cjs
// Orchestrates all engineering quality gates in a single command.
// Cross-platform: uses spawn with env for test commands.
// Order: fast static checks first, then tests, then build.
// Exits non-zero on ANY failure (fail-closed).

const { execSync, spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

function runSync(cmd, args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  const result = spawnSync(cmd, args || [], {
    cwd: root,
    env,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 300000,
    shell: process.platform === 'win32',
    ...opts,
  });
  return result.status === 0;
}

const stages = [
  { name: 'Syntax', cmd: 'node', args: ['scripts/check-server-syntax.cjs'] },
  { name: 'Typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { name: 'ESLint', cmd: 'npm', args: ['run', 'lint:eslint'] },
  { name: 'Unit', cmd: 'npm', args: ['run', 'test'] },
  { name: 'V2', cmd: 'npm', args: ['run', 'test:v2'], env: {
      NODE_ENV: 'test',
      TEST_PG_DATABASE: process.env.TEST_PG_DATABASE || 'moling_test',
    }},
  { name: 'API', cmd: 'npm', args: ['run', 'test:api'], env: {
      NODE_ENV: 'test',
      TEST_PG_DATABASE: process.env.TEST_PG_DATABASE || 'moling_test',
    }},
  { name: 'Build', cmd: 'npm', args: ['run', 'build'] },
];

let totalStart = Date.now();
let allPassed = true;
const results = [];

for (const stage of stages) {
  const stageStart = Date.now();
  process.stdout.write(`[${stage.name}] ... `);
  try {
    const ok = runSync(stage.cmd, stage.args, stage);
    const ms = Date.now() - stageStart;
    if (ok) {
      console.log(`PASS (${ms}ms)`);
      results.push({ name: stage.name, status: 'PASS', ms });
    } else {
      console.log(`FAIL (${ms}ms)`);
      results.push({ name: stage.name, status: 'FAIL', ms });
      allPassed = false;
    }
  } catch (e) {
    const ms = Date.now() - stageStart;
    console.log(`FAIL (${ms}ms)`);
    results.push({ name: stage.name, status: 'ERROR', ms, error: e.message });
    allPassed = false;
  }
}

const totalMs = Date.now() - totalStart;
const mins = Math.floor(totalMs / 60000);
const secs = Math.floor((totalMs % 60000) / 1000);

console.log(`\nQuality gate: ${allPassed ? 'ALL PASS' : 'FAILED'} (${mins}m ${secs}s)`);

if (!allPassed) {
  const failed = results.filter(r => r.status !== 'PASS');
  console.log('Failed stages: ' + failed.map(r => r.name).join(', '));
  process.exit(1);
}
