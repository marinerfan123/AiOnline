'use strict';
/**
 * G0-05 — Golden Path acceptance harness skeleton.
 *
 * Single, executable "definition of done" for all implementation waves, tied to the
 * Golden Paths (GP-01 full, GP-02 smoke, GP-03 smoke) plus the release gates
 * (persistence, review rejection, failure recovery, ledger/orphan/restore).
 *
 * Contract-first: each gate declares required checks; the harness DISCOVERS the matching
 * specs/tests and can DRY-RUN the whole surface WITHOUT calling any production provider
 * (so it is safe in CI / without paid keys). This is a skeleton: gate bodies are
 * placeholders that evolve as the product is implemented.
 */

const path = require('path');
const fs = require('fs');

// Golden Path / release gate contract (the "definition of done").
// Each gate: id, name, kind (full|smoke|mechanism), required: checks that must hold.
const GATES = Object.freeze([
  { id: 'GP-01', name: 'Golden Path — full end-to-end', kind: 'full', required: ['brief', 'delivery_spec', 'shots', 'generate', 'output'] },
  { id: 'GP-02', name: 'Golden Path — smoke', kind: 'smoke', required: ['brief', 'generate'] },
  { id: 'GP-03', name: 'Golden Path — smoke (commerce)', kind: 'smoke', required: ['project', 'generate', 'commerce'] },
  { id: 'persistence', name: 'Persistence gate', kind: 'mechanism', required: ['project_persist', 'shot_persist'] },
  { id: 'review_rejection', name: 'Review rejection gate', kind: 'mechanism', required: ['review_reject_repath'] },
  { id: 'failure_recovery', name: 'Failure recovery gate', kind: 'mechanism', required: ['retry_recover'] },
  { id: 'ledger_orphan_restore', name: 'Ledger / orphan / restore gate', kind: 'mechanism', required: ['ledger_consistent', 'no_orphan', 'restore_ok'] },
]);

const DEFAULT_E2E_DIR = path.join(__dirname);

/** Discover e2e/Playwright specs (test discovery). */
function discoverSpecs(dir = DEFAULT_E2E_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(spec|test)\.(ts|js|cjs)$/.test(f))
    .sort()
    .map((f) => ({ file: f, absPath: path.join(dir, f) }));
}

/** Find which e2e spec covers a given gate's required checks (placeholder mapping). */
function mapGateToSpecs(gate, specs) {
  // Placeholder: gate coverage is derived from the spec names (m###-...). A real
  // implementation maps each gate to its spec(s) precisely. Without production providers,
  // the dry-run only reports the contract + which specs exist to satisfy it.
  const hints = {
    'GP-01': ['m00-smoke', 'm05b2-production-core-nodes'],
    'GP-02': ['m00-smoke'],
    'GP-03': ['m04s-asset-foundation'],
    persistence: ['m05c-canvas-persistence'],
    review_rejection: ['m05b1-production-node-schema'],
    failure_recovery: ['m05b2-production-core-nodes'],
    ledger_orphan_restore: ['m02b-provider-keypool'],
  }[gate.id] || [];
  const matched = specs.filter((s) => hints.some((h) => s.file.includes(h))).map((s) => s.file);
  return matched;
}

/**
 * Dry-run the gate surface WITHOUT production providers.
 * Returns per-gate { id, ok, required, matchedSpecs, blockedBy } and an overall ready flag.
 * `providers` is intentionally unused/ignored — the dry-run never calls an external provider.
 */
function dryRun({ providers } = {}) {
  const specs = discoverSpecs();
  const gates = GATES.map((gate) => {
    const matched = mapGateToSpecs(gate, specs);
    // Skeleton readiness: a gate contract is "ready to evolve" when at least one spec maps to it.
    const ok = matched.length > 0;
    return { id: gate.id, name: gate.name, kind: gate.kind, required: gate.required, matchedSpecs: matched, ok, blockedBy: ok ? [] : ['missing_spec'] };
  });
  const ready = gates.every((g) => g.ok);
  return { golden_path_ready: ready, dry_run: true, production_providers_called: 0, gates, specCount: specs.length };
}

module.exports = { GATES, discoverSpecs, mapGateToSpecs, dryRun, DEFAULT_E2E_DIR };
