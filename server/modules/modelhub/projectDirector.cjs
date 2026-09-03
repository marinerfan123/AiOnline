'use strict';
/**
 * W4-14 — AI Director project-context facade (pure, no I/O). Inspects a project's structure, shots,
 * continuity + references and proposes deterministic actions (structure reorder, shot create,
 * continuity apply) grounded in the current product context. The Director recommends; the product
 * gates/approvals (W5-10) decide what actually runs.
 */

/** Propose actions for a project context. Deterministic (same context -> same proposals). */
function proposeActions({ projectType, structure = [], shots = [], references = [], continuity = null } = {}) {
  const proposals = [];
  const mode = projectType || 'narrative';
  // 1. Structure completeness: all modes converge on a 'shot' leaf.
  const types = new Set(structure.map((n) => n.type));
  if (!types.has('shot')) proposals.push({ type: 'CREATE_STRUCTURE_SHOT_LEAF', reason: `${mode} tree lacks shot leaf`, mode });
  // 2. Continuity gap: characters without a derived continuity state -> propose apply.
  const characters = (references || []).filter((r) => r.type === 'character');
  if (characters.length && !continuity) proposals.push({ type: 'APPLY_CONTINUITY', reason: 'characters present but no continuity snapshot', characters: characters.map((c) => c.id) });
  // 3. Empty shot grid -> propose a minimal shot seed.
  if (!shots.length) proposals.push({ type: 'SEED_SHOTS', reason: 'no shots yet', count: 1 });
  return { ok: true, proposals, suggestedMode: mode };
}

module.exports = { proposeActions };
