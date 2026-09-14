'use strict';
/**
 * M05-D1 — compileStudioGraph: persisted Canvas snapshot -> immutable CompiledStudioGraph.
 *
 * Pure function (no I/O, no process state). O(V+E) Kahn topological sort.
 * The Run engine executes ONLY against this compiled snapshot; live Canvas
 * rows are never re-read during execution (immutable revision binding).
 *
 * Safety contract:
 *  - rejects unknown node types, schema-version mismatches, dangling edges,
 *    duplicate edge identities, typed-port incompatibility, required-port
 *    gaps, and executable cycles (structured errors, safe node ids only)
 *  - STRUCTURAL nodes are excluded from the execution graph
 *  - output JSON is durable-safe (no secrets; parameters only)
 */
const { NODE_REGISTRY, getNodeDef, canConnectToPort } = require('./studioNodeRegistry.cjs');

const GRAPH_SCHEMA_VERSION = 1;

const DEFAULT_LIMITS = Object.freeze({
  maxNodes: 2000,
  maxEdges: 4000,
  maxCycleReportNodes: 50,
});

/** Read at call time so tests / ops can tune limits via env per process start. */
function activeLimits() {
  return {
    maxNodes: Number(process.env.STUDIO_RUN_MAX_NODES) || DEFAULT_LIMITS.maxNodes,
    maxEdges: Number(process.env.STUDIO_RUN_MAX_EDGES) || DEFAULT_LIMITS.maxEdges,
    maxCycleReportNodes: DEFAULT_LIMITS.maxCycleReportNodes,
  };
}
const LIMITS = DEFAULT_LIMITS;

class CompileError extends Error {
  constructor(code, message, nodeIds = []) {
    super(`${code}: ${message}`);
    this.code = code;
    this.safeNodeIds = Array.from(new Set(nodeIds)).slice(0, activeLimits().maxCycleReportNodes);
  }
  toStructured() {
    return { code: this.code, message: this.message, nodeIds: this.safeNodeIds };
  }
}

/** Durable-safe node execution input (B2 parameter subset; no secrets). */
const FORBIDDEN_INPUT_KEYS = new Set(['temporaryPreviewUrl', 'tempPreviewUrl', 'signedUrl', 'signedURL', 'apiKey', 'api_key', 'credential', 'credentials', 'jwt', 'token', 'cookie', 'localPath']);

function stripForbidden(obj, depth = 0) {
  if (!obj || typeof obj !== 'object') return obj;
  if (depth > 8) return obj; // bounded recursion guard
  if (Array.isArray(obj)) return obj.map((x) => stripForbidden(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_INPUT_KEYS.has(k)) continue; // nested keys stripped too (G15 LOW-1 fix)
    out[k] = v && typeof v === 'object' ? stripForbidden(v, depth + 1) : v;
  }
  return out;
}

/** Deep-freeze an object graph (snapshot immutability). */
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const v of Object.values(obj)) deepFreeze(v);
  return Object.freeze(obj);
}

function safeNodeInput(node) {
  const data = node.data || {};
  const out = { parameters: stripForbidden(data.parameters && typeof data.parameters === 'object' ? data.parameters : {}) };
  if (typeof data.assetId === 'string' && data.assetId) out.assetId = data.assetId;
  if (typeof data.prompt === 'string') out.prompt = data.prompt;
  // W2-08: compiled nodes carry stable lineage ids (Shot/Reference/Asset).
  if (typeof data.shotId === 'string' && data.shotId) out.shotId = data.shotId;
  if (typeof data.structureNodeId === 'string' && data.structureNodeId) out.structureNodeId = data.structureNodeId;
  if (typeof data.referenceId === 'string' && data.referenceId) out.referenceId = data.referenceId;
  return out;
}

/**
 * @param {object} input
 * @param {string} input.canvasId
 * @param {number} input.canvasRevision
 * @param {number} input.canvasSchemaVersion
 * @param {'ALL'|'SELECTED'|'FROM_NODE'} input.runMode
 * @param {string[]} [input.selectedNodeIds]
 * @param {Array} input.nodes  persisted node rows ({nodeId,nodeType,nodeSchemaVersion,data})
 * @param {Array} input.edges  persisted edge rows ({edgeId,sourceNodeId,sourceHandle,targetNodeId,targetHandle})
 * @param {number} [input.maxAttempts] default 3
 */
function compileStudioGraph(input) {
  try {
    const { canvasId, canvasRevision, canvasSchemaVersion, runMode = 'ALL', selectedNodeIds, nodes, edges } = input;
    const maxAttempts = Math.max(1, Math.min(10, Number(input.maxAttempts) || 3));
    if (!canvasId || !Number.isInteger(canvasRevision) || canvasRevision < 1) {
      throw new CompileError('INVALID_COMPILE_INPUT', 'canvasId and canvasRevision are required');
    }

    const nodeList = Array.isArray(nodes) ? nodes : [];
    const edgeList = Array.isArray(edges) ? edges : [];
    const lim = activeLimits();
    if (nodeList.length > lim.maxNodes) throw new CompileError('GRAPH_TOO_LARGE', `too many nodes: ${nodeList.length} > ${lim.maxNodes}`);
    if (edgeList.length > lim.maxEdges) throw new CompileError('GRAPH_TOO_LARGE', `too many edges: ${edgeList.length} > ${lim.maxEdges}`);

    // ── Node identity + registry validation ──────────────────────────────
    const nodeById = new Map();
    for (const raw of nodeList) {
      const nodeId = String(raw && raw.nodeId || '').trim();
      const nodeType = String((raw && raw.nodeType) || '').trim();
      if (!nodeId || !nodeType) throw new CompileError('INVALID_NODE_IDENTITY', 'node missing nodeId or nodeType');
      if (nodeById.has(nodeId)) throw new CompileError('DUPLICATE_NODE_ID', `duplicate node identity: ${nodeId}`, [nodeId]);
      const def = getNodeDef(nodeType);
      if (!def) throw new CompileError('UNKNOWN_NODE_TYPE', `unknown node type: ${nodeType}`, [nodeId]);
      const sv = Number(raw.nodeSchemaVersion);
      if (!Number.isInteger(sv) || sv !== def.version) {
        throw new CompileError('SCHEMA_VERSION_MISMATCH', `node ${nodeId} (${nodeType}) schemaVersion ${sv} != registry ${def.version}`, [nodeId]);
      }
      nodeById.set(nodeId, { raw, nodeId, nodeType, def });
    }

    // ── Subgraph selection (ALL is mandatory).
    // SELECTED (target execution set = selected roots ONLY): include the roots
    //   plus their complete transitive UPSTREAM dependency closure (every
    //   connected executable parent, recursively) so the required input ports
    //   are satisfied. Unrelated downstream descendants are excluded.
    //   Example A->B->C->D, SELECTED C => {A,B,C} (D excluded).
    // FROM_NODE (target execution set = downstream closure from roots):
    //   Step 1: transitive DOWNSTREAM executable closure from the root(s).
    //   Step 2: for EVERY node in that set, the transitive UPSTREAM closure
    //   required to make it executable (joins/side inputs are pulled in).
    //   Unrelated downstream branches of supporting nodes are NOT included.
    //   Example A->B->C->D, FROM_NODE C => {A,B,C,D}.
    // Engine dependency semantics: a run node waits for ALL connected
    // executable parents in the run graph, so "required upstream" ==
    // transitive closure over connected executable edges (both directions).
    // The two modes take DISTINCT code paths and have distinct tests.
    let included = new Set(nodeById.keys());
    if (runMode !== 'ALL') {
      const roots = (Array.isArray(selectedNodeIds) ? selectedNodeIds : []).map((s) => String(s).trim()).filter(Boolean);
      if (!roots.length) throw new CompileError('INVALID_COMPILE_INPUT', `${runMode} run mode requires selectedNodeIds`);
      for (const r of roots) {
        if (!nodeById.has(r)) throw new CompileError('UNKNOWN_NODE_ID', `selected node not found: ${r}`, [r]);
        if (nodeById.get(r).def.executionKind === 'STRUCTURAL') throw new CompileError('INVALID_COMPILE_INPUT', `selected node is structural: ${r}`, [r]);
      }
      // executable-only adjacency (both directions); edges touching
      // structural nodes never create work.
      const tmpDown = new Map(); // nodeId -> Set(childNodeIds)
      const tmpUp = new Map(); // nodeId -> Set(parentNodeIds)
      for (const e of edgeList) {
        const s = String(e.sourceNodeId), t = String(e.targetNodeId);
        if (!nodeById.has(s) || !nodeById.has(t)) continue;
        if (nodeById.get(s).def.executionKind === 'STRUCTURAL' || nodeById.get(t).def.executionKind === 'STRUCTURAL') continue;
        if (!tmpDown.has(s)) tmpDown.set(s, new Set());
        tmpDown.get(s).add(t);
        if (!tmpUp.has(t)) tmpUp.set(t, new Set());
        tmpUp.get(t).add(s);
      }
      if (runMode === 'SELECTED') {
        // roots + transitive upstream closure only.
        included = new Set();
        const stack = [...roots];
        while (stack.length) {
          const n = stack.pop();
          if (included.has(n)) continue;
          included.add(n);
          for (const u of tmpUp.get(n) || []) if (!included.has(u)) stack.push(u);
        }
      } else {
        // FROM_NODE: step 1 downstream closure, step 2 upstream support closure.
        const targetSet = new Set();
        const dstack = [...roots];
        while (dstack.length) {
          const n = dstack.pop();
          if (targetSet.has(n)) continue;
          targetSet.add(n);
          for (const c of tmpDown.get(n) || []) if (!targetSet.has(c)) dstack.push(c);
        }
        included = new Set(targetSet);
        const ustack = [...targetSet];
        while (ustack.length) {
          const n = ustack.pop();
          for (const u of tmpUp.get(n) || []) if (!included.has(u)) { included.add(u); ustack.push(u); }
        }
      }
    }

    // ── Edge validation + dependency graph (executable nodes only) ───────
    const seenEdgeIds = new Set();
    const adjacency = new Map(); // nodeId -> Set(dependentNodeIds)
    const dependentsOf = new Map(); // nodeId -> Set(dependentNodeIds)
    const dependencyCount = new Map(); // nodeId -> int
    const portCheck = new Map(); // nodeId -> { portId: true } connected required ports
    const structuralNodeIds = [];
    let execEdgeCount = 0;

    for (const raw of edgeList) {
      const edgeId = String(raw && raw.edgeId || '').trim();
      const s = String(raw && raw.sourceNodeId || '').trim();
      const t = String(raw && raw.targetNodeId || '').trim();
      if (!edgeId || !s || !t) throw new CompileError('INVALID_EDGE_IDENTITY', 'edge missing edgeId/source/target');
      if (seenEdgeIds.has(edgeId)) throw new CompileError('DUPLICATE_EDGE_ID', `duplicate edge identity: ${edgeId}`);
      seenEdgeIds.add(edgeId);
      const sNode = nodeById.get(s);
      const tNode = nodeById.get(t);
      if (!sNode || !tNode) throw new CompileError('DANGLING_EDGE', `edge ${edgeId} references unknown node`, [s, t]);
      // structural exclusion: edges touching structural nodes never create work
      if (sNode.def.executionKind === 'STRUCTURAL' || tNode.def.executionKind === 'STRUCTURAL') continue;
      if (!included.has(s) || !included.has(t)) continue; // outside selected subgraph

      // typed port compatibility
      const sHandle = raw.sourceHandle != null ? String(raw.sourceHandle) : null;
      const tHandle = raw.targetHandle != null ? String(raw.targetHandle) : null;
      const outPort = sHandle ? sNode.def.outputPorts.find((p) => p.id === sHandle) : null;
      const inPort = tHandle ? tNode.def.inputPorts.find((p) => p.id === tHandle) : null;
      if (sHandle && !outPort) throw new CompileError('UNKNOWN_PORT', `edge ${edgeId} source handle ${sHandle} not on ${s}`);
      if (tHandle && !inPort) throw new CompileError('UNKNOWN_PORT', `edge ${edgeId} target handle ${tHandle} not on ${t}`);
      if (outPort && inPort && !canConnectToPort(outPort.type, inPort)) {
        throw new CompileError('EDGE_TYPE_INCOMPATIBLE', `edge ${edgeId} port types incompatible`, [s, t]);
      }
      if (!adjacency.has(s)) adjacency.set(s, new Set());
      adjacency.get(s).add(t);
      if (!dependentsOf.has(t)) dependentsOf.set(t, new Set());
      dependentsOf.get(t).add(s);
      if (!portCheck.has(t)) portCheck.set(t, new Set());
      if (inPort) portCheck.get(t).add(inPort.id);
      execEdgeCount++;
    }

    for (const nodeId of structuralNodeIdsCollector(nodeById, included)) structuralNodeIds.push(nodeId);

    // ── Required-port validation (B2 semantics: missing required input blocks execution).
    // ALL mode: strict — a full-canvas run must have every required port connected.
    // SELECTED/FROM_NODE: ports whose only possible upstream was intentionally
    // excluded by the subgraph are allowed to stay unconnected (the selected
    // targets still execute with the closure that WAS included); ports with
    // NO connected executable edge at all are still rejected.
    for (const nodeId of included) {
      const { def } = nodeById.get(nodeId);
      if (def.executionKind === 'STRUCTURAL') continue;
      const connected = portCheck.get(nodeId) || new Set();
      for (const p of def.inputPorts) {
        if (!p.required) continue;
        if (runMode === 'ALL') {
          if (!connected.has(p.id)) {
            throw new CompileError('REQUIRED_PORT_MISSING', `node ${nodeId} required input '${p.id}' is not connected`, [nodeId]);
          }
        } else {
          // Subgraph mode: reject only when the node has zero connected inputs at all.
          if (connected.size === 0) {
            throw new CompileError('REQUIRED_PORT_MISSING', `node ${nodeId} required input '${p.id}' is not connected`, [nodeId]);
          }
        }
      }
      if (def.executionKind === 'OUTPUT' && def.inputPorts.length > 0 && connected.size === 0) {
        throw new CompileError('OUTPUT_INPUT_MISSING', `output node ${nodeId} has no connected input`, [nodeId]);
      }
    }

    // ── Kahn topological sort O(V+E), deterministic order (executable nodes only;
    //    structural nodes never enter the execution graph) ─────────────────
    const execSet = new Set();
    for (const nodeId of included) {
      if (nodeById.get(nodeId).def.executionKind !== 'STRUCTURAL') execSet.add(nodeId);
    }
    const indegree = new Map();
    for (const nodeId of execSet) indegree.set(nodeId, (dependentsOf.get(nodeId) || new Set()).size);
    let head = 0;
    const queue = [...execSet].filter((n) => indegree.get(n) === 0).sort();
    const topologicalOrder = [];
    while (head < queue.length) {
      const n = queue[head++];
      topologicalOrder.push(n);
      const deps = adjacency.get(n);
      if (!deps) continue;
      for (const d of deps) {
        const deg = indegree.get(d) - 1;
        indegree.set(d, deg);
        if (deg === 0) queue.push(d);
      }
    }
    if (topologicalOrder.length !== execSet.size) {
      const inCycle = [...execSet].filter((n) => indegree.get(n) > 0);
      throw new CompileError('DAG_CYCLE_DETECTED', 'executable cycle detected in canvas graph', inCycle);
    }

    // ── Emit immutable compiled graph ────────────────────────────────────
    const nodeEntries = [];
    for (const nodeId of included) {
      const { nodeType, def } = nodeById.get(nodeId);
      if (def.executionKind === 'STRUCTURAL') continue;
      const deps = dependentsOf.get(nodeId) || new Set();
      nodeEntries.push({
        nodeId,
        nodeType,
        executionKind: def.executionKind,
        schemaVersion: def.version,
        dependencies: [...deps].sort(),
        dependents: [...(adjacency.get(nodeId) || [])].sort(),
        maxAttempts,
        input: safeNodeInput(nodeById.get(nodeId).raw),
      });
    }

    const result = {
      ok: true,
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        canvasId,
        canvasRevision,
        canvasSchemaVersion: Number(canvasSchemaVersion) || 1,
        runMode,
        nodeCount: nodeEntries.length,
        edgeCount: execEdgeCount,
        structuralNodeCount: structuralNodeIds.length,
        topologicalOrder,
        nodes: nodeEntries,
        structuralNodeIds: structuralNodeIds.sort(),
      },
    };
    return deepFreeze(result);
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, error: e.toStructured() };
    if (process.env.STUDIO_RUN_COMPILE_DEBUG) throw e;
    return { ok: false, error: { code: 'COMPILE_FAILED', message: 'graph compilation failed', nodeIds: [] } };
  }
}

function structuralNodeIdsCollector(nodeById, included) {
  const out = [];
  for (const nodeId of nodeById.keys()) {
    if (!included.has(nodeId)) continue;
    if (nodeById.get(nodeId).def.executionKind === 'STRUCTURAL') out.push(nodeId);
  }
  return out;
}

module.exports = { compileStudioGraph, safeNodeInput, deepFreeze, CompileError, GRAPH_SCHEMA_VERSION, LIMITS, NODE_REGISTRY };
