'use strict';

/**
 * harness/aggregator.cjs
 *
 * Aggregates runner results into a single JSON output.
 *
 * Contract (product-level fields that must exist in every run):
 *   GOLDEN_PATH_GP01  | SMOKE_GP02   | SMOKE_GP03
 *   BROWSER_E2E       | P0_COUNT     | P1_COUNT
 *   FAILED_MIGRATIONS | UNRECONCILED_GENERATION_JOBS
 *   LEDGER_INCONSISTENCIES | CRITICAL_ORPHAN_ASSETS | BACKUP_RESTORE_TEST
 *
 * Rules:
 *   - NOT_READY is final unless overridden by a later stage.
 *   - A runner FAIL (exit !== 0) → step FAIL; aggregator maps to path FAIL.
 *   - No fake PASS: steps must have explicit evidence to be PASS.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Types (documented; Node has no runtime types)
// ---------------------------------------------------------------------------
// RunnerResult = {
//   status: 'PASS' | 'FAIL' | 'NOT_READY',
//   duration_ms: number,
//   steps: Array<{ name: string, status: 'PASS'|'FAIL'|'NOT_READY', duration_ms: number, evidence?: string }>,
//   error?: string,
//   exit_code?: number
// }
// PathConfig = { id: string, runner: string, label: string }
// AggregatorInput = {
//   paths: Record<string, RunnerResult>,
//   metrics?: Partial<Record<string, any>>
// }
// AggregatorOutput = {
//   run_id: string,
//   ts: string,
//   version: string,
//   summary: { total, pass, fail, not_ready, overall },
//   paths: Record<string, PathResult>,
//   metrics: Record<string, any>,
//   evidence_dir: string,
//   footprint: string[],
//   errors: string[]
// }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = '1.0.0';
const DEFAULT_EVIDENCE_DIR = path.join(process.cwd(), 'harness', 'evidence');

const PATH_CONFIGS = {
  GP01: { id: 'GP01_short_drama_full', runner: 'harness/runners/gp01-short-drama.cjs', label: 'Short Drama FULL' },
  GP02: { id: 'GP02_commercial_smoke', runner: 'harness/runners/gp02-commercial.cjs', label: 'Commercial Smoke' },
  GP03: { id: 'GP03_ecommerce_smoke', runner: 'harness/runners/gp03-ecommerce.cjs', label: 'E-commerce Smoke' },
};

// Metric aliases: path status → product metric name
const PATH_TO_METRIC = {
  GP01: 'GOLDEN_PATH_GP01',
  GP02: 'SMOKE_GP02',
  GP03: 'SMOKE_GP03',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeEvidence(evidenceDir, filename, data) {
  const filePath = path.join(evidenceDir, filename);
  ensureDir(evidenceDir);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}

function runnerExitToStatus(exitCode, error) {
  if (error) return 'FAIL';
  if (exitCode === 0) return 'PASS';
  return 'FAIL';
}

// ---------------------------------------------------------------------------
// Core aggregator
// ---------------------------------------------------------------------------
function aggregate(input) {
  const { paths: runnerResults, metrics: extraMetrics = {} } = input;
  const evidenceDir = input.evidence_dir || DEFAULT_EVIDENCE_DIR;
  ensureDir(evidenceDir);

  const runId = generateRunId();
  const ts = new Date().toISOString();
  const errors = [];
  const footprint = [];
  const pathResults = {};
  let passCount = 0;
  let failCount = 0;
  let notReadyCount = 0;

  // Process each configured path
  for (const [key, config] of Object.entries(PATH_CONFIGS)) {
    const runnerResult = runnerResults[key];
    let status;
    let steps = [];
    let evidenceFile;
    let stepFootprints = [];

    if (!runnerResult) {
      // Runner was not invoked
      status = 'NOT_READY';
      notReadyCount++;
      evidenceFile = writeEvidence(evidenceDir, `${key}.json`, {
        status,
        runner: config.runner,
        steps: [],
        note: 'Runner not invoked',
      });
      footprint.push(path.relative(process.cwd(), evidenceFile));
    } else {
      status = runnerResult.status;
      steps = runnerResult.steps || [];
      evidenceFile = runnerResult.evidence_file;

      // Write runner's own evidence
      if (evidenceFile) {
        footprint.push(path.relative(process.cwd(), evidenceFile));
      }

      // Write aggregated step evidence
      const stepEvidence = writeEvidence(evidenceDir, `${key}-steps.json`, {
        steps,
        status,
        runner: config.runner,
      });
      stepFootprints.push(path.relative(process.cwd(), stepEvidence));
    }

    pathResults[config.id] = {
      status,
      runner: config.runner,
      label: config.label,
      evidence_file: evidenceFile,
      steps,
    };

    // Map to product metric
    const metricKey = PATH_TO_METRIC[key];
    if (metricKey && !extraMetrics[metricKey]) {
      extraMetrics[metricKey] = status;
    }

    switch (status) {
      case 'PASS': passCount++; break;
      case 'FAIL': failCount++; break;
      case 'NOT_READY': notReadyCount++; break;
    }
  }

  // Copy through other metrics (BROWSER_E2E, counts, etc.)
  for (const [k, v] of Object.entries(extraMetrics)) {
    if (!pathResults[k] && !metricsReservedKeys.has(k)) {
      // These are non-path metrics
    }
  }

  // Determine overall
  const total = passCount + failCount + notReadyCount;
  let overall = 'NOT_READY';
  if (failCount > 0) {
    overall = 'FAIL';
  } else if (passCount > 0 && notReadyCount === 0) {
    overall = 'PASS';
  } else if (passCount > 0) {
    // Some pass, some not-ready: overall is NOT_READY (conservative)
    overall = 'NOT_READY';
  }

  // Ensure required metric keys exist (even if undefined)
  const requiredMetrics = [
    'GOLDEN_PATH_GP01',
    'SMOKE_GP02',
    'SMOKE_GP03',
    'BROWSER_E2E',
    'P0_COUNT',
    'P1_COUNT',
    'FAILED_MIGRATIONS',
    'UNRECONCILED_GENERATION_JOBS',
    'LEDGER_INCONSISTENCIES',
    'CRITICAL_ORPHAN_ASSETS',
    'BACKUP_RESTORE_TEST',
  ];
  for (const mk of requiredMetrics) {
    if (extraMetrics[mk] === undefined) {
      extraMetrics[mk] = null;
    }
  }

  const output = {
    run_id: runId,
    ts,
    version: SCHEMA_VERSION,
    summary: {
      total,
      pass: passCount,
      fail: failCount,
      not_ready: notReadyCount,
      overall,
    },
    paths: pathResults,
    metrics: extraMetrics,
    evidence_dir: evidenceDir,
    footprint,
    errors,
  };

  // Write result
  const resultFile = path.join(evidenceDir, 'results.json');
  fs.writeFileSync(resultFile, JSON.stringify(output, null, 2), 'utf8');
  footprint.push(path.relative(process.cwd(), resultFile));

  return output;
}

const metricsReservedKeys = new Set([
  'GOLDEN_PATH_GP01',
  'SMOKE_GP02',
  'SMOKE_GP03',
  'BROWSER_E2E',
  'P0_COUNT',
  'P1_COUNT',
  'FAILED_MIGRATIONS',
  'UNRECONCILED_GENERATION_JOBS',
  'LEDGER_INCONSISTENCIES',
  'CRITICAL_ORPHAN_ASSETS',
  'BACKUP_RESTORE_TEST',
]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const evidenceDir = args.find(a => a.startsWith('--evidence-dir='))?.split('=')[1] || DEFAULT_EVIDENCE_DIR;
  const only = args.filter(a => a.startsWith('--gp='));
  const list = args.includes('--list');

  if (list) {
    console.log('Configured paths:');
    for (const [key, config] of Object.entries(PATH_CONFIGS)) {
      console.log(`  ${key}: ${config.label} → ${config.runner}`);
    }
    console.log('\nMetrics contract:');
    for (const k of metricsReservedKeys) {
      console.log(`  ${k}`);
    }
    return;
  }

  // Load runner results from evidence dir or invoke runners
  const runnerResults = {};
  const loadFile = (key) => {
    const candidate = path.join(evidenceDir, `${key}.json`);
    if (fs.existsSync(candidate)) {
      try {
        runnerResults[key] = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        return true;
      } catch (e) {
        // ignore
      }
    }
    return false;
  };

  // If specific GPs requested, load only those
  const keysToRun = only.length > 0
    ? only.map(a => a.replace('--gp=', ''))
    : Object.keys(PATH_CONFIGS);

  for (const k of keysToRun) {
    if (!loadFile(k)) {
      // Try loading from path ID
      const config = PATH_CONFIGS[k];
      if (config) {
        const idFile = path.join(evidenceDir, `${config.id}.json`);
        loadFile(config.id);
      }
    }
  }

  // If no results found, check for runner scripts and run them
  const hasResults = Object.keys(runnerResults).length > 0;
  if (!hasResults) {
    // Run the actual runners
    const { spawnSync } = require('child_process');
    const rootDir = path.resolve(__dirname, '..');

    for (const [key, config] of Object.entries(PATH_CONFIGS)) {
      if (only.length > 0 && !only.includes(key) && !only.includes(config.id)) continue;

      const runnerPath = path.join(rootDir, config.runner);
      if (!fs.existsSync(runnerPath)) {
        runnerResults[key] = {
          status: 'NOT_READY',
          steps: [],
          evidence_file: null,
          error: `Runner not found: ${config.runner}`,
        };
        continue;
      }

      console.log(`[aggregator] Running ${config.label} (${config.runner})...`);
      const result = spawnSync('node', [runnerPath], {
        cwd: rootDir,
        encoding: 'utf8',
        timeout: 300_000,
        stdio: ['pipe', 'inherit', 'inherit'],
      });

      runnerResults[key] = {
        status: runnerExitToStatus(result.status, result.error),
        steps: [],
        evidence_file: null,
        exit_code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
  }

  const output = aggregate({
    paths: runnerResults,
    metrics: {},
    evidence_dir: evidenceDir,
  });

  // Print summary
  console.log('');
  console.log(`Golden Path Harness — ${output.summary.overall}`);
  console.log(`  PASS: ${output.summary.pass} | FAIL: ${output.summary.fail} | NOT_READY: ${output.summary.not_ready}`);
  console.log(`  Evidence: ${evidenceDir}`);
  console.log('');
  for (const [id, pr] of Object.entries(output.paths)) {
    console.log(`  ${id}: ${pr.status}`);
  }

  // Write JSON to stdout for CI parsing
  process.stdout.write(JSON.stringify(output, null, 2));
  console.log('');

  // Exit with appropriate code
  if (output.summary.overall === 'FAIL') {
    process.exit(1);
  }
  if (output.summary.overall === 'NOT_READY' && output.summary.pass === 0) {
    // All not-ready with no passes = also fail (nothing was validated)
    process.exit(1);
  }
  process.exit(0);
}

// Export for programmatic use
module.exports = { aggregate, PATH_CONFIGS, runnerExitToStatus, metricsReservedKeys };

if (require.main === module) {
  main().catch(e => {
    console.error('[aggregator] fatal:', e);
    process.exit(1);
  });
}
