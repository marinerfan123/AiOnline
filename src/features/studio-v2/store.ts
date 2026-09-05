// M05-A — Canvas Session State (zustand).
//
// STATE RULE (M05-A): this store is EPHEMERAL CLIENT SESSION STATE —
// selected nodes, viewport, positions, undo stack. It is NOT durable
// authority. Canvas persistence/versioning lands in M05-C (shared
// PostgreSQL). Nothing here is written to localStorage/IndexedDB, and the
// UI states that explicitly.
//
// PERFORMANCE CONTRACT (1000-node design):
// - bounded undo history (UNDO_LIMIT) — no unbounded growth
// - drag updates mutate node position only; expensive graph metadata is
//   never recomputed per frame
// - all mutations are batched in a single set()

import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type Viewport,
} from '@xyflow/react';
import {
  getNodeDef,
  type NodeDef,
} from './registry';
import { validateNewEdge } from './graphRules';
import {
  computeStoredStatus,
  directDownstreamIds,
  isIdentityChange,
} from './validation';
import {
  mintNodeId,
  type StudioNodeData,
  type StudioEdgeData,
  type StudioNodeKind,
  type PortSpec,
} from './types';
import { studioRunClient, type StudioRunStatus } from './run/studioRunClient';
import { canvasCommandLogClient, type CanvasCommand } from '@/shared/api/contract/canvasCommandLogClient';

export type StudioNode = Node<StudioNodeData>;
export type StudioEdge = Edge<StudioEdgeData>;

export const UNDO_LIMIT = 100; // bounded: 100 ops keeps memory flat on large canvases
export const PASTE_OFFSET = 32;

interface Snapshot {
  nodes: StudioNode[];
  edges: StudioEdge[];
}

/**
 * W4a — result of a command-log read-only alignment pass. `cursor` is the
 * highest server seq now consumed (monotonic); `commands` is the delta for
 * callers (History panel / remote-activity indicator). This does NOT mutate
 * nodes/edges — the read API is summary-only (no op payloads), so remote
 * graph reconciliation stays on the persistence/projection main chain.
 */
export interface SyncFromCommandLogResult {
  commands: CanvasCommand[];
  hasMore: boolean;
  /** highest server seq consumed after this pass (monotonic, ≥ afterSeq). */
  cursor: number;
  /** number of commands newly returned in this pass. */
  remoteCount: number;
}

export interface InvalidConnectionInfo {
  message: string;
  at: number;
  code?: string;
}

/**
 * W5b — result of a node-data edit attempt. `NODE_LOCKED` means the target
 * node is locked at the store-action layer (UX guard; server CAS remains the
 * concurrency authority — this does NOT replace it).
 */
export interface NodeEditResult {
  ok: boolean;
  code?: 'NODE_LOCKED';
}

interface StudioState {
  nodes: StudioNode[];
  edges: StudioEdge[];
  viewport: Viewport;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  clipboard: { nodes: StudioNode[]; edges: StudioEdge[] } | null;
  invalidConnection: InvalidConnectionInfo | null;
  /** drag bookkeeping: pre-drag snapshot for one undo entry */
  dragSnapshot: Snapshot | null;
  /** inspector transaction: pre-edit snapshot committed on blur/apply */
  editSnapshot: Snapshot | null;

  /**
   * W5b — local/session node lock registry (UX layer). NOT durable (the
   * persistence whitelist strips `locked`, so toggles never reach the server)
   * and NOT the concurrency authority (server CAS is). `data.locked` on each
   * node is the reactive mirror the card UI reads; this Set is the fast O(1)
   * authoritative gate used by the store-action rejection.
   */
  lockedNodeIds: Set<string>;

  // ── run context (session; populated by Inspector via setRunContext) ──
  projectId: string | null;
  canvasRevision: number | null;

  // ── W6① canvas identity (lifted from persistence — single primary canvas) ──
  // Resolved primary canvas id (`canvas-<uuid>`, ≠ projectId). Server keys presence,
  // persistence writes and every canvas read/write on it. Written by
  // useStudioCanvasPersistence.reloadFromServer right after loadGraph succeeds;
  // read by useCanvasPresence (removing W5a's per-mount getCanvas round-trip).
  currentCanvasId: string | null;

  // ── W4a command-log read cursor (server seq alignment; read-only) ──
  /** highest canvas_command_log seq consumed from the server (0 = not synced). */
  commandLogCursor: number;

  // ── W1② run trigger state (fire-and-forget; read surface is the Runs tab) ──
  /** node currently being run (non-null = one run in flight; busy gate) */
  runningNodeId: string | null;
  /** last triggered run (initial server response; NOT polled to terminal) */
  lastRun: { runId: string; status: StudioRunStatus } | null;
  /** inline failure copy for the last run trigger */
  runError: string | null;

  // ── react-flow wiring ──
  onNodesChange: (changes: NodeChange<StudioNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<StudioEdge>[]) => void;
  onConnect: (c: Connection) => void;
  onViewportChange: (v: Viewport) => void;
  onNodeDragStart: () => void;
  onNodeDragStop: () => void;

  // ── operations (undoable) ──
  addNode: (kind: StudioNodeKind, position: { x: number; y: number }) => string | null;
  removeSelection: () => void;
  duplicateSelection: () => void;
  copySelection: () => void;
  selectAll: () => void;
  paste: () => void;
  alignSelection: (kind: 'left' | 'middle' | 'right') => void;
  groupSelection: () => string | null;
  beginEdit: () => void;
  endEdit: () => void;
  updateNodeData: (id: string, patch: Partial<StudioNodeData>) => NodeEditResult;
  updateNodeParameter: (id: string, key: string, value: unknown) => NodeEditResult;
  /** M05-B2 model switch: replace the whole parameter set in ONE set() (deterministic normalization). */
  replaceNodeParameters: (id: string, parameters: StudioNodeData['parameters'], changedKeys: string[]) => NodeEditResult;
  /** W5b — lock/unlock a node (session-level UX lock; draggable=false while locked). */
  lockNode: (nodeId: string, locked: boolean) => void;
  undo: () => void;
  redo: () => void;
  setViewport: (v: Viewport) => void;
  clearInvalidConnection: () => void;
  /** benchmark/test helper / server hydration — replace whole graph in one batch (no undo push) */
  loadGraph: (nodes: StudioNode[], edges: StudioEdge[], viewport?: Viewport) => void;
  /** P0: project-switch isolation — fully reset ephemeral session state (no cross-project leak). */
  resetProjectState: () => void;
  /** W1② run context: Inspector syncs projectId + canvas revision before running. */
  setRunContext: (projectId: string | null, canvasRevision: number | null) => void;
  /** W6① canvas identity: persistence writes the resolved primary canvas id after loadGraph. */
  setCurrentCanvasId: (canvasId: string | null) => void;
  /** W1② trigger a FROM_NODE run for one node (fire-and-forget; no polling). */
  runNode: (nodeId: string) => Promise<void>;
  /**
   * W4a read-only alignment: pull commands after `afterSeq` (default = current
   * cursor) from the server command log and advance `commandLogCursor`. Never
   * mutates nodes/edges and never touches the undo/redo stacks — local undo/redo
   * stays instant + snapshot-based; the persistence write chain (CAS revision +
   * 409 banner) is untouched. Rejects with the client error on network/HTTP
   * failure (caller decides how to surface).
   */
  syncFromCommandLog: (afterSeq?: number) => Promise<SyncFromCommandLogResult>;
}

/**
 * Bridge for "add at the CURRENT viewport center". Only a component inside
 * ReactFlowProvider knows the live viewport + container size, so CanvasCore
 * populates this on mount. Consumers OUTSIDE the provider (Node Library) call
 * it instead of guessing a fixed flow offset — this keeps new nodes visible
 * even with onlyRenderVisibleElements culling.
 */
export const studioCanvasActions: {
  addAtViewportCenter: (kind: StudioNodeKind) => string | null;
} = {
  addAtViewportCenter: () => null,
};

function snapshot(s: StudioState): Snapshot {
  return { nodes: s.nodes, edges: s.edges };
}

function pushUndo(s: { undoStack: Snapshot[]; redoStack: Snapshot[] }, snap: Snapshot) {
  const undoStack = [...s.undoStack, snap];
  if (undoStack.length > UNDO_LIMIT) undoStack.shift(); // bounded
  return { undoStack, redoStack: [] as Snapshot[] }; // new op clears redo
}

/**
 * W5b — 防呆双保险 (belt-and-suspenders): a node counts as locked when EITHER
 * the authoritative `lockedNodeIds` registry OR the denormalized `data.locked`
 * mirror says so. The store-action rejection stays correct even if the two
 * sources ever drift.
 */
function isNodeLocked(s: StudioState, nodeId: string): boolean {
  if (s.lockedNodeIds.has(nodeId)) return true;
  return s.nodes.some((n) => n.id === nodeId && n.data.locked === true);
}

/** push a typed edge with portType carried in edge data. */
function buildEdge(c: Connection, portType: PortSpec['type']): StudioEdge {
  return {
    id: `e-${c.source}-${c.sourceHandle ?? 'out'}-${c.target}-${c.targetHandle ?? 'in'}`,
    source: c.source!,
    sourceHandle: c.sourceHandle ?? undefined,
    target: c.target!,
    targetHandle: c.targetHandle ?? undefined,
    data: { portType },
  } as StudioEdge;
}

function findPort(node: StudioNode | undefined, handleId: string | null | undefined, input: boolean): PortSpec | null {
  if (!node || !handleId) return null;
  const def = getNodeDef(node.data.nodeKind);
  if (!def) return null;
  const ports = input ? def.inputPorts : def.outputPorts;
  return ports.find((p) => p.id === handleId) ?? ports[0] ?? null;
}

/**
 * M05-B2 node-local status recompute. Only the affected node ids are touched —
 * never a graph-wide sweep (1000-node contract). Catalog availability
 * (validModelIds) is NOT applied here: the store is network-free, and model
 * availability is surfaced by the Inspector (which owns the TanStack Query
 * cache). Local semantics only: IDLE (structural) / INVALID / STALE (sticky)
 * / READY.
 */
function recomputeStatus(nodes: StudioNode[], affectedIds: Iterable<string>, edges: StudioEdge[]): StudioNode[] {
  const ids = new Set(affectedIds);
  if (ids.size === 0) return nodes;
  return nodes.map((n) => {
    if (!ids.has(n.id)) return n;
    const def = getNodeDef(n.data.nodeKind);
    if (!def) return n;
    const status = computeStoredStatus(n, def, edges);
    return status === n.data.status ? n : { ...n, data: { ...n.data, status } };
  });
}

/** ids of non-frame nodes whose position falls inside a frame's bounds. */
function childrenOfFrame(nodes: StudioNode[], frameId: string): Set<string> {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame) return new Set();
  const w = frame.width ?? (frame.measured?.width ?? 320);
  const h = frame.height ?? (frame.measured?.height ?? 220);
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.id === frameId || n.data.nodeKind === 'frame') continue;
    const nw = n.width ?? (n.measured?.width ?? 240);
    const nh = n.height ?? (n.measured?.height ?? 160);
    const cx = n.position.x + nw / 2;
    const cy = n.position.y + nh / 2;
    if (cx >= frame.position.x && cx <= frame.position.x + w && cy >= frame.position.y && cy <= frame.position.y + h) {
      out.add(n.id);
    }
  }
  return out;
}

export const useStudioStore = create<StudioState>((set, get) => ({
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  undoStack: [],
  redoStack: [],
  clipboard: null,
  invalidConnection: null,
  dragSnapshot: null,
  editSnapshot: null,
  lockedNodeIds: new Set<string>(),

  projectId: null,
  canvasRevision: null,
  currentCanvasId: null,
  commandLogCursor: 0,
  runningNodeId: null,
  lastRun: null,
  runError: null,

  onNodesChange: (changes) =>
    set((s) => {
      // Frame grouping: dragging a frame moves all contained nodes by the same delta.
      let nodes = applyNodeChanges(changes, s.nodes) as StudioNode[];
      for (const ch of changes) {
        if (ch.type === 'position' && ch.position && ch.dragging === false) {
          const frame = nodes.find((n) => n.id === ch.id && n.data.nodeKind === 'frame');
          if (frame) {
            const before = s.nodes.find((n) => n.id === ch.id);
            if (!before) continue;
            const dx = frame.position.x - before.position.x;
            const dy = frame.position.y - before.position.y;
            if (dx === 0 && dy === 0) continue;
            const kids = childrenOfFrame(nodes, frame.id);
            if (kids.size > 0) {
              nodes = nodes.map((n) =>
                kids.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
              );
            }
          }
        }
      }
      return { nodes };
    }),
  onEdgesChange: (changes) =>
    set((s) => {
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (removed.length === 0) {
        return { edges: applyEdgeChanges(changes, s.edges) as StudioEdge[] };
      }
      const edges = applyEdgeChanges(changes, s.edges) as StudioEdge[];
      // edge removal can flip a target from READY→INVALID: recompute only the
      // affected targets (node-local, no graph-wide sweep)
      const affected = new Set(s.edges.filter((e) => removed.includes(e.id)).map((e) => e.target));
      return { edges, nodes: recomputeStatus(s.nodes, affected, edges) };
    }),

  onConnect: (c) => {
    const s = get();
    if (!c.source || !c.target) return;
    // G04 typed-graph connect gate (Blueprint 00 §7): type compatibility →
    // duplicate → cardinality → cycle policy; structured verdict surfaced as
    // invalidConnection so the canvas can render a consistent rejection.
    const verdict = validateNewEdge({
      nodes: s.nodes,
      edges: s.edges,
      source: c.source,
      target: c.target,
      sourceHandle: c.sourceHandle,
      targetHandle: c.targetHandle,
    });
    if (!verdict.ok) {
      set({
        invalidConnection: {
          message: verdict.message || '无法建立该连接',
          at: Date.now(),
          code: verdict.code,
        },
      });
      return;
    }
    const sourceNode = s.nodes.find((n) => n.id === c.source);
    const outPort = (sourceNode ? findPort(sourceNode, c.sourceHandle, false) : null);
    if (!outPort) return;
    const edge = buildEdge(c, outPort.type);
    set((st) => {
      const edges = addEdge(edge, st.edges) as StudioEdge[];
      return {
        ...pushUndo(st, snapshot(st)),
        edges,
        nodes: recomputeStatus(st.nodes, [c.source, c.target], edges),
      };
    });
  },

  onViewportChange: (v) => set({ viewport: v }),
  onNodeDragStart: () => set((s) => ({ dragSnapshot: snapshot(s) })),
  onNodeDragStop: () =>
    set((s) => (s.dragSnapshot ? { ...pushUndo(s, s.dragSnapshot), dragSnapshot: null } : { dragSnapshot: null })),

  addNode: (kind, position) => {
    const def: NodeDef | undefined = getNodeDef(kind);
    if (!def) return null;
    const id = mintNodeId(kind);
    const node: StudioNode = {
      id,
      type: 'studio',
      position,
      data: { ...def.defaultData, title: def.title },
      width: def.width,
    };
    set((s) => ({
      ...pushUndo(s, snapshot(s)),
      nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), { ...node, selected: true }],
    }));
    return id;
  },

  removeSelection: () => {
    const s = get();
    const selected = new Set(s.nodes.filter((n) => n.selected).map((n) => n.id));
    const selectedEdges = new Set(s.edges.filter((e) => e.selected).map((e) => e.id));
    if (selected.size === 0 && selectedEdges.size === 0) return;
    // deleting a frame also deletes the nodes contained in it
    const frameKids = new Set<string>();
    for (const fid of selected) {
      const f = s.nodes.find((n) => n.id === fid);
      if (f?.data.nodeKind === 'frame') {
        for (const kid of childrenOfFrame(s.nodes, fid)) frameKids.add(kid);
      }
    }
    const remove = (id: string) => selected.has(id) || frameKids.has(id);
    set((st) => ({
      ...pushUndo(st, snapshot(st)),
      nodes: st.nodes.filter((n) => !remove(n.id)),
      edges: st.edges.filter((e) => !selectedEdges.has(e.id) && !remove(e.source) && !remove(e.target)),
      lockedNodeIds: new Set([...st.lockedNodeIds].filter((id) => !remove(id))),
    }));
  },

  duplicateSelection: () => {
    const s = get();
    const selectedNodes = s.nodes.filter((n) => n.selected && n.type !== 'studio-frame-container');
    if (selectedNodes.length === 0) return;
    const idMap = new Map<string, string>();
    const clones: StudioNode[] = selectedNodes.map((n) => {
      const nid = mintNodeId(n.data.nodeKind);
      idMap.set(n.id, nid);
      return {
        ...n,
        id: nid,
        position: { x: n.position.x + PASTE_OFFSET, y: n.position.y + PASTE_OFFSET },
        selected: true,
        draggable: true,
        data: { ...n.data, locked: false },
      };
    });
    const cloneEdges: StudioEdge[] = s.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        ...e,
        id: `e-${idMap.get(e.source)}-${e.sourceHandle ?? 'out'}-${idMap.get(e.target)}-${e.targetHandle ?? 'in'}`,
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        selected: false,
      }));
    set((st) => ({
      ...pushUndo(st, snapshot(st)),
      nodes: [...st.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...clones],
      edges: [...st.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), ...cloneEdges],
    }));
  },

  copySelection: () => {
    const s = get();
    const selectedNodes = s.nodes.filter((n) => n.selected);
    if (selectedNodes.length === 0) return;
    const ids = new Set(selectedNodes.map((n) => n.id));
    const edges = s.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    set({ clipboard: { nodes: selectedNodes.map((n) => ({ ...n, selected: false, data: { ...n.data } })), edges } });
  },

  selectAll: () =>
    set((s) => ({
      nodes: s.nodes.map((n) => ({ ...n, selected: true })),
      edges: s.edges.map((e) => ({ ...e, selected: false })),
    })),

  paste: () => {
    const s = get();
    if (!s.clipboard || s.clipboard.nodes.length === 0) return;
    const idMap = new Map<string, string>();
    const clones: StudioNode[] = s.clipboard.nodes.map((n) => {
      const nid = mintNodeId(n.data.nodeKind);
      idMap.set(n.id, nid);
      return {
        ...n,
        id: nid,
        position: { x: n.position.x + PASTE_OFFSET, y: n.position.y + PASTE_OFFSET },
        selected: true,
        draggable: true,
        data: { ...n.data, locked: false },
      };
    });
    const cloneEdges: StudioEdge[] = s.clipboard.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        ...e,
        id: `e-${idMap.get(e.source)}-${e.sourceHandle ?? 'out'}-${idMap.get(e.target)}-${e.targetHandle ?? 'in'}`,
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        selected: false,
      }));
    set((st) => ({
      ...pushUndo(st, snapshot(st)),
      nodes: [...st.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...clones],
      edges: [...st.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), ...cloneEdges],
    }));
  },

  alignSelection: (kind) =>
    set((st) => {
      const selected = st.nodes.filter((n) => n.selected && n.data.nodeKind !== 'frame');
      if (selected.length < 2) return st;
      const xs = selected.map((n) => n.position.x);
      const target =
        kind === 'left'
          ? Math.min(...xs)
          : kind === 'right'
            ? Math.max(...xs)
            : xs.reduce((a, b) => a + b, 0) / xs.length;
      const { undoStack, redoStack } = pushUndo(st, snapshot(st));
      return {
        ...st,
        undoStack,
        redoStack,
        nodes: st.nodes.map((n) =>
          n.selected && n.data.nodeKind !== 'frame' ? { ...n, position: { ...n.position, x: target } } : n,
        ),
      };
    }),

  groupSelection: () => {
    const s = get();
    const selected = s.nodes.filter((n) => n.selected && n.data.nodeKind !== 'frame');
    if (selected.length < 2) return null;
    const xs = selected.map((n) => n.position.x);
    const ys = selected.map((n) => n.position.y);
    const minX = Math.min(...xs) - 24;
    const minY = Math.min(...ys) - 40;
    const w = Math.max(...xs) + 300 - minX;
    const h = Math.max(...ys) + 220 - minY;
    const id = mintNodeId('frame');
    const frame: StudioNode = {
      id,
      type: 'studio',
      position: { x: minX, y: minY },
      data: { nodeKind: 'frame', nodeType: 'frame', schemaVersion: 1, title: 'Frame / Group', status: 'IDLE', parameters: { frameLabel: `Group of ${selected.length}` }, frameLabel: `Group of ${selected.length}` },
      width: w,
      height: h,
      className: 'studio-frame',
      selected: true,
    };
    set((st) => ({
      ...pushUndo(st, snapshot(st)),
      nodes: [
        ...st.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
        frame,
      ],
    }));
    return id;
  },

  beginEdit: () => set((s) => (s.editSnapshot ? s : { editSnapshot: snapshot(s) })),
  endEdit: () =>
    set((s) => {
      if (!s.editSnapshot) return s;
      const changed =
        s.editSnapshot.nodes !== s.nodes || s.editSnapshot.edges !== s.edges;
      return changed ? { ...pushUndo(s, s.editSnapshot), editSnapshot: null } : { editSnapshot: null };
    }),

  updateNodeData: (id, patch) => {
    if (isNodeLocked(get(), id)) return { ok: false, code: 'NODE_LOCKED' };
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
    }));
    return { ok: true };
  },

  updateNodeParameter: (id, key, value) => {
    if (isNodeLocked(get(), id)) return { ok: false, code: 'NODE_LOCKED' };
    set((s) => {
      const nodes = s.nodes.map((n) => {
        if (n.id !== id) return n;
        const parameters = { ...(n.data.parameters ?? {}), [key]: value };
        const patch: Partial<StudioNodeData> = { parameters };
        if (key === 'prompt' && typeof value === 'string') patch.prompt = value;
        if (key === 'scriptText' && typeof value === 'string') patch.prompt = value;
        if (key === 'assetId' && (typeof value === 'string' || value === null)) patch.assetId = value as string | null;
        if (key === 'frameLabel' && typeof value === 'string') patch.frameLabel = value;
        return { ...n, data: { ...n.data, ...patch } };
      });
      // M05-B2 stale propagation contract: an identity change (parameters /
      // assetId) marks DIRECT downstream nodes STALE (in-memory, no auto-run).
      let downstream = new Set<string>();
      if (isIdentityChange({ changedNodeId: id, changedKeys: [key] })) {
        downstream = new Set(directDownstreamIds(s.edges, { changedNodeId: id, changedKeys: [key] }));
      }
      const staleNodes = downstream.size > 0
        ? nodes.map((n) =>
            downstream.has(n.id) && n.data.status !== 'STALE' ? { ...n, data: { ...n.data, status: 'STALE' as const } } : n,
          )
        : nodes;
      return { nodes: recomputeStatus(staleNodes, [id, ...downstream], s.edges) };
    });
    return { ok: true };
  },

  replaceNodeParameters: (id, parameters, changedKeys) => {
    if (isNodeLocked(get(), id)) return { ok: false, code: 'NODE_LOCKED' };
    set((s) => {
      const nodes = s.nodes.map((n) => {
        if (n.id !== id) return n;
        const patch: Partial<StudioNodeData> = { parameters };
        if (typeof parameters.prompt === 'string') patch.prompt = parameters.prompt;
        if (parameters.assetId === null || typeof parameters.assetId === 'string') patch.assetId = parameters.assetId as string | null;
        if (typeof parameters.frameLabel === 'string') patch.frameLabel = parameters.frameLabel;
        return { ...n, data: { ...n.data, ...patch } };
      });
      const downstream = new Set(
        isIdentityChange({ changedNodeId: id, changedKeys })
          ? directDownstreamIds(s.edges, { changedNodeId: id, changedKeys })
          : [],
      );
      const staleNodes = downstream.size > 0
        ? nodes.map((n) =>
            downstream.has(n.id) && n.data.status !== 'STALE' ? { ...n, data: { ...n.data, status: 'STALE' as const } } : n,
          )
        : nodes;
      return { nodes: recomputeStatus(staleNodes, [id, ...downstream], s.edges) };
    });
    return { ok: true };
  },

  // W5b — session-level node lock (UX layer, NOT server CAS). Toggles the
  // authoritative `lockedNodeIds` registry and mirrors onto `data.locked`
  // (reactive card badge) + react-flow `draggable` (node-level drag gate).
  // Intentionally NOT undoable (a UX toggle, not a graph edit) and NOT
  // persisted (see lockedNodeIds doc above).
  lockNode: (nodeId, locked) =>
    set((s) => {
      if (!s.nodes.some((n) => n.id === nodeId)) return s;
      const lockedNodeIds = new Set(s.lockedNodeIds);
      if (locked) lockedNodeIds.add(nodeId);
      else lockedNodeIds.delete(nodeId);
      return {
        lockedNodeIds,
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, draggable: !locked, data: { ...n.data, locked } } : n,
        ),
      };
    }),

  // W4a 裁决: undo/redo 保持本地快照式（每操作一条目、即时、有界 UNDO_LIMIT），
  // 不改为命令日志消费；远端他人命令通过 syncFromCommandLog 只读对齐（读游标），
  // 图形和解走既有 persistence/CAS + 409 banner。此处逻辑不重写。
  undo: () =>
    set((s) => {
      const prev = s.undoStack[s.undoStack.length - 1];
      if (!prev) return s;
      const cur = snapshot(s);
      return {
        nodes: prev.nodes,
        edges: prev.edges,
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, cur],
        dragSnapshot: null,
        editSnapshot: null,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.redoStack[s.redoStack.length - 1];
      if (!next) return s;
      const cur = snapshot(s);
      return {
        nodes: next.nodes,
        edges: next.edges,
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, cur],
      };
    }),

  setViewport: (v) => set({ viewport: v }),

  clearInvalidConnection: () => set({ invalidConnection: null }),

  // ── W1② run trigger (fire-and-forget; terminal state is the Runs tab's job) ──
  setRunContext: (projectId, canvasRevision) => set({ projectId, canvasRevision }),

  setCurrentCanvasId: (canvasId) => set({ currentCanvasId: canvasId }),

  runNode: async (nodeId) => {
    const s = get();
    // busy gate: one run in flight at a time — no re-entrant trigger
    if (s.runningNodeId != null) return;
    if (!s.projectId) {
      set({ runError: '未绑定项目，无法运行（缺少 projectId）' });
      return;
    }
    if (s.canvasRevision == null) {
      set({ runError: '画布尚未保存，无法运行（缺少 canvas revision）' });
      return;
    }
    // initial trigger state: clear previous result/error, mark the node busy
    set({ runningNodeId: nodeId, lastRun: null, runError: null });
    try {
      const res = await studioRunClient.runNode({
        projectId: s.projectId,
        nodeId,
        canvasRevision: s.canvasRevision,
      });
      set({ runningNodeId: null, lastRun: { runId: res.runId, status: res.status } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ runningNodeId: null, runError: msg ? `运行失败：${msg}` : '运行失败，请稍后重试' });
    }
  },

  // ── W4a command-log read-only alignment ────────────────────────────────
  // 裁决 (verdict): local undo/redo stays snapshot-per-operation + instant;
  // it is NOT rewired to command-log consumption. This method is the second
  // track — advance a server-seq read cursor and hand the summary delta to
  // callers. It is READ-ONLY: no node/edge mutation, no undo/redo push, no
  // write to the persistence main chain (CAS revision + 409 banner untouched).
  syncFromCommandLog: async (afterSeq) => {
    const s = get();
    const projectId = s.projectId;
    // No bound project → cannot align against a server log; report empty delta.
    if (!projectId) {
      return { commands: [], hasMore: false, cursor: s.commandLogCursor, remoteCount: 0 };
    }
    const from = afterSeq ?? s.commandLogCursor;
    const res = await canvasCommandLogClient.listCommands({ projectId, afterSeq: from });
    const commands = res.commands;
    const lastSeq = commands.length > 0 ? commands[commands.length - 1].seq : from;
    // Monotonic: never regress the cursor (a caller could pass an older afterSeq).
    const cursor = Math.max(s.commandLogCursor, lastSeq);
    if (cursor !== s.commandLogCursor) set({ commandLogCursor: cursor });
    return { commands, hasMore: res.hasMore, cursor, remoteCount: commands.length };
  },

  loadGraph: (nodes, edges, viewport) => set({ nodes, edges, ...(viewport ? { viewport } : {}), undoStack: [], redoStack: [], clipboard: null, dragSnapshot: null, editSnapshot: null, invalidConnection: null, commandLogCursor: 0, lockedNodeIds: new Set(nodes.filter((n) => n.data.locked === true).map((n) => n.id)) }),

  resetProjectState: () =>
    set({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      undoStack: [],
      redoStack: [],
      clipboard: null,
      dragSnapshot: null,
      editSnapshot: null,
      invalidConnection: null,
      projectId: null,
      canvasRevision: null,
      currentCanvasId: null,
      commandLogCursor: 0,
      lockedNodeIds: new Set<string>(),
      runningNodeId: null,
      lastRun: null,
      runError: null,
    }),
}));

// ── Convenience selectors ─────────────────────────────────────────────────
export const selectSelectedCount = (s: StudioState) =>
  s.nodes.filter((n) => n.selected).length;

export const selectCanUndo = (s: StudioState) => s.undoStack.length > 0;
export const selectCanRedo = (s: StudioState) => s.redoStack.length > 0;
