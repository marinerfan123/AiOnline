// G04 — Typed Graph connection rules (Blueprint V2.0, 00 §7 connection gates).
// Pure module: type compatibility, self-connection, duplicate edge, per-port
// cardinality (single upstream per input port), cycle policy (dataflow graphs
// must stay acyclic across non-structural nodes). Model-capability and domain
// policy gates are resolved at run/plan time (executor/planner), not at
// connect time — noted in the connection contract.

import type { NodeDef } from './registry';
import type { StudioNode, StudioEdge } from './store';
import { canConnectToPort, getNodeDef } from './registry';

export type ConnectionGateCode =
  | 'PORT_NOT_FOUND'
  | 'SELF_CONNECTION'
  | 'TYPE_INCOMPATIBLE'
  | 'DUPLICATE_EDGE'
  | 'CARDINALITY_EXCEEDED'
  | 'GRAPH_CYCLE';

export interface ConnectionVerdict {
  ok: boolean;
  code?: ConnectionGateCode;
  message?: string;
}

export interface NewEdgeInput {
  nodes: StudioNode[];
  edges: StudioEdge[];
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

const STRUCTURAL = 'STRUCTURAL';

function findNode(nodes: StudioNode[], id: string): StudioNode | undefined {
  return nodes.find((n) => n.id === id);
}

/** Dataflow edges only — STRUCTURAL (frame/group/storyboard-container) nodes never participate in cycle policy. */
function isDataflowNode(node: StudioNode | undefined): boolean {
  if (!node) return false;
  const def = nodeDefOf(node);
  return Boolean(def) && def!.executionKind !== STRUCTURAL;
}

// nodeDefOf: registry lookup keys off data.nodeKind (authoritative, mirrors
// StudioNode.tsx); falls back to the React Flow node.type.
function nodeDefOf(node: StudioNode): NodeDef | undefined {
  const kind = (node.data && (node.data as { nodeKind?: string }).nodeKind) || node.type;
  return getNodeDef(kind as string);
}

/** Is there a directed path from `from` to `to` following edges source→target? */
export function hasPath(edges: StudioEdge[], from: string, to: string, visited = new Set<string>()): boolean {
  if (from === to) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  for (const e of edges) {
    if (e.source === from && hasPath(edges, e.target, to, visited)) return true;
  }
  return false;
}

/**
 * Full G04 connect gate. Order matches Blueprint 00 §7: type compatibility →
 * duplicate → cycle policy (cardinality checked per input port). Returns the
 * first failing gate; ok=true means the edge may be added.
 */
export function validateNewEdge(input: NewEdgeInput): ConnectionVerdict {
  const { nodes, edges, source, target, sourceHandle, targetHandle } = input;
  if (!source || !target || !sourceHandle || !targetHandle) {
    return { ok: false, code: 'PORT_NOT_FOUND', message: '连接缺少端口' };
  }
  const sourceNode = findNode(nodes, source);
  const targetNode = findNode(nodes, target);
  if (!sourceNode || !targetNode) return { ok: false, code: 'PORT_NOT_FOUND', message: '节点不存在' };
  if (source === target) return { ok: false, code: 'SELF_CONNECTION', message: '节点不能连接自身' };

  const sourceDef = nodeDefOf(sourceNode);
  const targetDef = nodeDefOf(targetNode);
  const outPort = sourceDef?.outputPorts.find((p) => p.id === sourceHandle);
  const inPort = targetDef?.inputPorts.find((p) => p.id === targetHandle);
  if (!outPort || !inPort) return { ok: false, code: 'PORT_NOT_FOUND', message: '端口不存在' };

  // type compatibility (port-level acceptedTypes override base table)
  if (!canConnectToPort(outPort.type, inPort)) {
    return {
      ok: false,
      code: 'TYPE_INCOMPATIBLE',
      message: `无法连接：${outPort.label}(${outPort.type}) → ${inPort.label}(${inPort.type}) 类型不兼容`,
    };
  }

  // duplicate edge (03 §6 unique tuple)
  const dup = edges.some(
    (e) =>
      e.source === source && e.target === target &&
      e.sourceHandle === sourceHandle && e.targetHandle === targetHandle,
  );
  if (dup) return { ok: false, code: 'DUPLICATE_EDGE', message: '已存在相同连接' };

  // cardinality: one upstream per input port (fan-out allowed on outputs)
  const occupied = edges.some(
    (e) => e.target === target && e.targetHandle === targetHandle,
  );
  if (occupied) {
    return { ok: false, code: 'CARDINALITY_EXCEEDED', message: `${inPort.label} 已有一个上游连接` };
  }

  // cycle policy: connecting source→target is illegal if target already
  // reaches source (would close a loop) over dataflow (non-structural) nodes.
  if (isDataflowNode(sourceNode) && isDataflowNode(targetNode)) {
    const reach = hasPath(edges, target, source);
    if (reach) return { ok: false, code: 'GRAPH_CYCLE', message: '该连接会形成循环，已拒绝' };
  }

  return { ok: true };
}

/** Re-export the base compatibility helper for a single import surface. */
export { canConnectToPort };
export type { NodeDef };
