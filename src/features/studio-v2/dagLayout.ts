// W6④ — DAG layered auto-layout (M2 doc33).
//
// Pure math: takes the canvas nodes + edges and returns a position map for the
// layoutable (non-frame, non-locked) nodes. Layered "left → right" arrangement:
//   - layer = longest-path rank from sources (topological; cycles fall back to a
//     deterministic side layer so the graph never collapses).
//   - within a layer, nodes are ordered by the average order of their incoming
//     neighbours (barycenter) to minimise edge crossings.
//   - x = layer * (maxWidth + H_GAP); y = centered column of (height + V_GAP).
//
// This is deliberately decoupled from the zustand store (structural typing only)
// so it stays unit-testable without a React/store fixture, and never mutates.

export interface AutoLayoutNode {
  id: string;
  kind: string;
  width?: number | null;
  height?: number | null;
}

export interface AutoLayoutEdge {
  source: string;
  target: string;
}

export interface AutoLayoutOptions {
  /** horizontal gap between layers (default 90). */
  hGap?: number;
  /** vertical gap between nodes in the same layer (default 90). */
  vGap?: number;
  /** fallback node width when the node carries none (default 260). */
  defaultWidth?: number;
  /** fallback node height when the node carries none (default 140). */
  defaultHeight?: number;
  /** kinds to skip entirely (containers, e.g. 'frame'). */
  skipKinds?: ReadonlySet<string>;
}

/** Deterministic layered DAG layout; returns id → {x,y} for every layoutable node. */
export function computeAutoLayout(
  nodes: readonly AutoLayoutNode[],
  edges: readonly AutoLayoutEdge[],
  opts: AutoLayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const skip = opts.skipKinds ?? new Set<string>(['frame']);
  const hGap = opts.hGap ?? 90;
  const vGap = opts.vGap ?? 90;
  const defW = opts.defaultWidth ?? 260;
  const defH = opts.defaultHeight ?? 140;

  const candidates = nodes.filter((n) => !skip.has(n.kind));
  if (candidates.length === 0) return new Map();

  const ids = new Set(candidates.map((n) => n.id));
  const widthOf = new Map<string, number>();
  const heightOf = new Map<string, number>();
  for (const n of candidates) {
    widthOf.set(n.id, n.width || defW);
    heightOf.set(n.id, n.height || defH);
  }

  // adjacency among layoutable nodes only
  const adj = new Map<string, string[]>(); // source -> targets
  const inDeg = new Map<string, number>();
  for (const n of candidates) { adj.set(n.id, []); inDeg.set(n.id, 0); }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }

  // longest-path layering via Kahn (topological), then relax each node to
  // max(layer[parent]+1). Remaining nodes (cycle members) get a deterministic
  // side-layer to keep the graph flat instead of overlapping.
  const layer = new Map<string, number>();
  const indeg = new Map(inDeg);
  const queue: string[] = [];
  for (const n of candidates) if ((indeg.get(n.id) ?? 0) === 0) queue.push(n.id);
  const order: string[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    layer.set(u, 0);
    for (const v of adj.get(u) ?? []) {
      const d = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, d);
      if (d === 0) queue.push(v);
    }
  }
  // longest-path relax over the DAG order
  for (const u of order) {
    const lu = layer.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      if (!layer.has(v) || (layer.get(v)! < lu + 1)) layer.set(v, lu + 1);
    }
  }
  // cycle leftovers (never enqueued) → place at a layer beyond the max
  const maxLayer = [...layer.values()].reduce((a, b) => Math.max(a, b), 0);
  for (const n of candidates) if (!layer.has(n.id)) layer.set(n.id, maxLayer + 1);

  // group by layer, order within layer by barycenter of incoming neighbours
  const byLayer = new Map<number, string[]>();
  for (const n of candidates) {
    const l = layer.get(n.id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.id);
  }
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e.source);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const positions = new Map<string, { x: number; y: number }>();
  let maxWidth = defW;
  for (const w of widthOf.values()) maxWidth = Math.max(maxWidth, w);

  for (const l of layers) {
    const members = byLayer.get(l)!;
    const bary = new Map<string, number>();
    for (const m of members) {
      const ins = incoming.get(m) ?? [];
      const sum = ins.reduce((acc, p) => acc + (layer.get(p) ?? 0) * 1000 + (positions.get(p)?.y ?? 0), 0);
      bary.set(m, ins.length ? sum / ins.length : 0);
    }
    members.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || a.localeCompare(b));

    const colHeight = members.reduce((acc, m) => acc + (heightOf.get(m) ?? defH) + vGap, -vGap);
    const startY = -colHeight / 2;
    let y = startY;
    for (const m of members) {
      const h = heightOf.get(m) ?? defH;
      positions.set(m, { x: l * (maxWidth + hGap), y: y + h / 2 });
      y += h + vGap;
    }
  }

  return positions;
}
