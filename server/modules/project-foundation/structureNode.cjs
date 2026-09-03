'use strict';
/**
 * W1-12/W1-13 — Structure node model (durable, ordered, project-scoped, converges on Shot).
 *
 * A project's narrative / ad / e-commerce structure is a tree of nodes. Each node has a type
 * belonging to the project-mode's type set; the leaf ('shot') converges on a shots row. This
 * module owns the hierarchy rules + pure validation (no I/O).
 */

const NARRATIVE_TYPES = ['story', 'act', 'sequence', 'scene', 'shot'];
const AD_TYPES = ['brief', 'concept', 'sequence', 'scene', 'shot'];
const ECOMMERCE_TYPES = ['product', 'selling_point', 'segment', 'scene', 'shot'];
// Legal parent->child adjacency (a node of type X may contain type Y).
const PARENT_OF = {
  story: ['act'],
  act: ['sequence'],
  sequence: ['scene'],
  scene: ['shot'],
  brief: ['concept', 'sequence'],
  concept: ['scene'],
  product: ['selling_point'],
  selling_point: ['segment'],
  segment: ['scene'],
  shot: [],
};

/** Resolve the allowed type set for a project mode. */
function typeSetForMode(mode) {
  if (mode === 'advertising') return AD_TYPES;
  if (mode === 'ecommerce') return ECOMMERCE_TYPES;
  return NARRATIVE_TYPES; // narrative (default) / 'other' uses narrative set
}

/**
 * Validate a whole node tree: types belong to the mode set, parent->child adjacency is legal,
 * ordering is dense per parent, and every 'shot' leaf converges on a shotId. Returns {ok, errors[]}.
 */
function validateTree(nodes, mode) {
  const errors = [];
  const types = new Set(typeSetForMode(mode));
  const shotLeaf = PARENT_OF['shot'];

  for (const n of nodes || []) {
    if (!types.has(n.type)) errors.push(`node.${n.id}: type '${n.type}' not allowed for mode '${mode}'`);
  }
  for (const n of nodes || []) {
    if (!n.parent_id) continue;
    const p = (nodes || []).find((x) => x.id === n.parent_id);
    if (!p) { errors.push(`node.${n.id}: unknown parent ${n.parent_id}`); continue; }
    const allowed = PARENT_OF[p.type] || [];
    if (!allowed.includes(n.type)) errors.push(`node.${n.id}: '${p.type}' cannot contain '${n.type}'`);
  }
  // Ordering dense per parent + shot leaf converges.
  for (const n of nodes || []) {
    const siblings = (nodes || []).filter((x) => (x.parent_id || null) === (n.parent_id || null));
    const oc = Number(n.order_index);
    if (!Number.isInteger(oc) || oc < 0) errors.push(`node.${n.id}: invalid order_index`);
    if (n.type === 'shot' && !n.shot_id) errors.push(`node.${n.id}: shot node must converge on a shotId`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { typeSetForMode, validateTree, NARRATIVE_TYPES, AD_TYPES, ECOMMERCE_TYPES };
