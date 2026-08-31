'use strict';

/**
 * scripts/golden-path.cjs
 *
 * CLI wrapper for the Golden Path harness.
 * Delegates to harness/entry.cjs.
 *
 * Usage:
 *   node scripts/golden-path.cjs [options]
 *   npm run golden-path [options]
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const entryScript = path.join(root, 'harness', 'entry.cjs');

// Forward all args to harness/entry.cjs
const args = process.argv.slice(2);
const result = spawnSync('node', [entryScript, ...args], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 0);
