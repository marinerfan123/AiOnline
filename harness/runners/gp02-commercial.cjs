'use strict';

/**
 * harness/runners/gp02-commercial.cjs
 *
 * Golden Path GP02: Commercial Smoke
 *
 * Flow:
 *   Brief → Brand/References → Storyboard → 6 Shots → 30s Ad → Review → Export
 *
 * Current status: NOT_READY (skeleton)
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_EVIDENCE_DIR } = require('../evidence-paths.cjs');

const STEPS = [
  'brief',
  'brand_references',
  'storyboard',
  'shots_6',
  'ad_30s',
  'review',
  'export',
];

function run(options = {}) {
  const evidenceDir = path.resolve(options.evidenceDir || process.env.GOLDEN_PATH_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const steps = [];
  const now = new Date().toISOString();

  for (const step of STEPS) {
    steps.push({
      name: step,
      status: 'NOT_READY',
      duration_ms: 0,
      evidence: `Step '${step}' not yet implemented`,
    });
  }

  const result = {
    status: 'NOT_READY',
    runner: 'harness/runners/gp02-commercial.cjs',
    label: 'Commercial Smoke',
    steps,
    ts: now,
    evidence_file: path.join(evidenceDir, 'gp02-commercial.json'),
  };

  fs.writeFileSync(result.evidence_file, JSON.stringify(result, null, 2), 'utf8');

  console.log(`[GP02] ${result.status} — ${steps.length} steps`);
  for (const s of steps) {
    console.log(`  ${s.name}: ${s.status}`);
  }

  return result;
}

if (require.main === module) {
  const result = run();
  console.log(`GOLDEN_PATH_RESULT=${JSON.stringify(result)}`);
  process.exit(result.status === 'PASS' ? 0 : result.status === 'NOT_READY' ? 2 : 1);
}

module.exports = { run, STEPS };
