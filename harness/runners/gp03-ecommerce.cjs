'use strict';

/**
 * harness/runners/gp03-ecommerce.cjs
 *
 * Golden Path GP03: E-commerce Smoke
 *
 * Flow:
 *   Product Images → Selling Points → 5 Shots → 15s vertical → CTA → Export
 *
 * Current status: NOT_READY (skeleton)
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_EVIDENCE_DIR } = require('../evidence-paths.cjs');

const STEPS = [
  'product_images',
  'selling_points',
  'shots_5',
  'video_15s_vertical',
  'cta',
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
    runner: 'harness/runners/gp03-ecommerce.cjs',
    label: 'E-commerce Smoke',
    steps,
    ts: now,
    evidence_file: path.join(evidenceDir, 'gp03-ecommerce.json'),
  };

  fs.writeFileSync(result.evidence_file, JSON.stringify(result, null, 2), 'utf8');

  console.log(`[GP03] ${result.status} — ${steps.length} steps`);
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
