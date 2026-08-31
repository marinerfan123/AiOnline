'use strict';

/**
 * harness/entry.cjs — Single CLI entry point for Golden Path harness.
 *
 * Usage:
 *   node harness/entry.cjs [options]
 *
 * Options:
 *   --gp GP01|GP02|GP03  Run only specified path(s)
 *   --list               List configured paths and metrics contract
 *   --evidence-dir DIR   Output directory (default: harness/evidence)
 *   --dry-run            Show what would run without executing
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { aggregate, PATH_CONFIGS } = require('./aggregator.cjs');

function parseArgs(argv) {
  const args = {
    gps: [],
    list: false,
    evidenceDir: path.join(__dirname, 'evidence'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--gp':
        args.gps.push(argv[++i]);
        break;
      case '--list':
        args.list = true;
        break;
      case '--evidence-dir':
        args.evidenceDir = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function runRunner(config, dryRun) {
  if (dryRun) {
    console.log(`  [dry-run] Would run: ${config.runner}`);
    return {
      status: 'NOT_READY',
      steps: [],
      note: 'dry-run',
    };
  }

  const runnerPath = path.join(__dirname, '..', config.runner);
  if (!fs.existsSync(runnerPath)) {
    return {
      status: 'NOT_READY',
      steps: [],
      error: `Runner not found: ${config.runner}`,
    };
  }

  console.log(`  Running ${config.label}...`);
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 300_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Extract the JSON block from runner stdout by finding matching braces.
  // A naive "lines starting with {" filter breaks on multi-line arrays
  // whose inner elements also begin with "{".
  const extractJsonBlock = (text) => {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  };

  const jsonText = extractJsonBlock(result.stdout || '');
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      return {
        status: parsed.status || 'NOT_READY',
        steps: parsed.steps || [],
        evidence_file: parsed.evidence_file || null,
        exit_code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch {
      // Fall through to exit-code-based status
    }
  }

  // Fallback: exit code based
  const status = result.status === 0 ? 'PASS' : 'FAIL';
  return {
    status,
    steps: [],
    exit_code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log('Golden Path Harness — Configured Paths\n');
    for (const [key, config] of Object.entries(PATH_CONFIGS)) {
      console.log(`  ${key}: ${config.label}`);
      console.log(`    runner: ${config.runner}`);
    }
    console.log('\nMetrics Contract:');
    const { metricsReservedKeys } = require('./aggregator.cjs');
    for (const k of metricsReservedKeys) {
      console.log(`  ${k}`);
    }
    return;
  }

  // Determine which paths to run
  const keysToRun = args.gps.length > 0
    ? args.gps
    : Object.keys(PATH_CONFIGS);

  const runnerResults = {};
  for (const key of keysToRun) {
    const config = PATH_CONFIGS[key];
    if (!config) {
      console.error(`Unknown path key: ${key}`);
      continue;
    }
    runnerResults[key] = runRunner(config, args.dryRun);
  }

  // Aggregate
  const output = aggregate({
    paths: runnerResults,
    metrics: {},
    evidence_dir: args.evidenceDir,
  });

  // Output summary
  console.log('');
  console.log(`Golden Path Harness — ${output.summary.overall}`);
  console.log(`  PASS: ${output.summary.pass} | FAIL: ${output.summary.fail} | NOT_READY: ${output.summary.not_ready}`);
  console.log(`  Evidence: ${args.evidenceDir}`);
  console.log('');

  // Output JSON for CI
  process.stdout.write(JSON.stringify(output, null, 2));
  console.log('');

  if (output.summary.overall === 'FAIL') {
    process.exit(1);
  }
  if (output.summary.overall === 'NOT_READY' && output.summary.pass === 0) {
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    console.error('[entry] fatal:', e);
    process.exit(1);
  });
}

module.exports = { parseArgs, runRunner };
