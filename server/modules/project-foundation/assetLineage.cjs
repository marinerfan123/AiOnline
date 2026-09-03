'use strict';
/**
 * W3-12/W3-13 — Asset lineage graph + Selected Asset Version ↔ Shot binding (pure, no I/O).
 * W3-12: asset-version lineage (uploaded/generated/derived, derived_from edges) is queryable + traces source.
 * W3-13: the selected Asset Version bound to a Shot is tracked deterministically.
 */

/** Build a lineage graph from asset-version edges. Returns adjacency + a deterministic root/source resolution. */
function buildLineageGraph(versions) {
  const byId = new Map((versions || []).map((v) => [v.version_id, v]));
  const children = new Map(); // version_id -> Set(child ids)
  for (const v of versions || []) {
    if (v.derived_from && byId.has(v.derived_from)) {
      if (!children.has(v.derived_from)) children.set(v.derived_from, new Set());
      children.get(v.derived_from).add(v.version_id);
    }
  }
  return {
    ids: (versions || []).map((v) => v.version_id),
    edges: (versions || []).filter((v) => v.derived_from).map((v) => ({ from: v.derived_from, to: v.version_id })),
    children: Object.fromEntries([...children].map(([k, v]) => [k, [...v]])),
    byId: Object.fromEntries([...byId].map(([k, v]) => [k, v])),
  };
}

/** Resolve the origin/source of an asset version (walk derived_from to a root, detect cycles). */
function resolveLineage(version, graph) {
  const seen = new Set();
  let cur = version;
  const path = [];
  let sourceGenerationId = null;
  while (cur) {
    if (seen.has(cur.version_id)) return { ok: false, error: { code: 'LINEAGE_CYCLE' } };
    seen.add(cur.version_id);
    if (!sourceGenerationId && cur.generation_id) sourceGenerationId = cur.generation_id; // nearest generation
    if (!cur.derived_from) break;
    cur = graph.byId[cur.derived_from] || null;
    if (cur) path.push(cur.version_id);
  }
  const origin = cur || version;
  return { ok: true, originId: origin.version_id, originKind: origin.kind || 'upload', path, sourceGenerationId };
}

/** W3-13: deterministically bind a selected asset version to a shot. Returns {ok, binding}. */
function buildShotAssetBinding({ shotId, assetVersionId }) {
  if (!shotId || !assetVersionId) return { ok: false, error: { code: 'BINDING_MISSING_FIELDS' } };
  return { ok: true, binding: { shotId, assetVersionId, boundAt: new Date().toISOString(), bindingHash: `${shotId}:${assetVersionId}` } };
}

module.exports = { buildLineageGraph, resolveLineage, buildShotAssetBinding };
