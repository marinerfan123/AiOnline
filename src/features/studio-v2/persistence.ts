import type { Viewport } from '@xyflow/react';
import { getNodeDef } from './registry';
import type { StudioEdge, StudioNode } from './store';
import type { StudioEdgeData, StudioNodeData } from './types';

export const AUTOSAVE_DEBOUNCE_MS = 900;

const FORBIDDEN_DATA_KEYS = new Set([
  'temporaryPreviewUrl', 'tempPreviewUrl', 'signedUrl', 'signedURL',
  'apiKey', 'api_key', 'credential', 'credentials', 'jwt', 'token', 'cookie',
  'localPath', 'domState', 'reactState',
]);

export interface PersistedStudioNode {
  nodeId: string;
  nodeType: string;
  nodeSchemaVersion: number;
  position: { x: number; y: number };
  size?: { width: number | null; height: number | null };
  zIndex?: number | null;
  data: StudioNodeData;
}

export interface PersistedStudioEdge {
  edgeId: string;
  sourceNodeId: string;
  sourceHandle?: string | null;
  targetNodeId: string;
  targetHandle?: string | null;
  edgeType?: string | null;
  data: StudioEdgeData;
}

export interface CanvasPatchRequest {
  baseRevision: number;
  clientMutationId: string;
  upsertNodes?: PersistedStudioNode[];
  deleteNodeIds?: string[];
  upsertEdges?: PersistedStudioEdge[];
  deleteEdgeIds?: string[];
  viewport?: Viewport;
}

function stripForbidden<T extends Record<string, unknown>>(input: T | undefined | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    if (FORBIDDEN_DATA_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function durableStudioNodeData(data: StudioNodeData): StudioNodeData {
  const clean = stripForbidden(data);
  const nodeKind = String(clean.nodeKind ?? clean.nodeType ?? 'prompt') as StudioNodeData['nodeKind'];
  return {
    nodeKind,
    nodeType: String(clean.nodeType ?? nodeKind) as StudioNodeData['nodeType'],
    schemaVersion: Number(clean.schemaVersion ?? 1),
    title: String(clean.title ?? nodeKind),
    status: (clean.status ?? 'IDLE') as StudioNodeData['status'],
    parameters: (clean.parameters && typeof clean.parameters === 'object' ? clean.parameters : {}) as StudioNodeData['parameters'],
    ...(typeof clean.assetId === 'string' || clean.assetId === null ? { assetId: clean.assetId as string | null } : {}),
    ...(typeof clean.prompt === 'string' ? { prompt: clean.prompt } : {}),
    ...(clean.validation && typeof clean.validation === 'object' ? { validation: clean.validation as StudioNodeData['validation'] } : {}),
    ...(typeof clean.frameLabel === 'string' ? { frameLabel: clean.frameLabel } : {}),
  };
}

export function serializeStudioNode(node: StudioNode): PersistedStudioNode {
  const data = durableStudioNodeData(node.data);
  return {
    nodeId: node.id,
    nodeType: data.nodeKind,
    nodeSchemaVersion: data.schemaVersion,
    position: { x: Number(node.position.x) || 0, y: Number(node.position.y) || 0 },
    size: { width: node.width ?? null, height: node.height ?? null },
    zIndex: typeof node.zIndex === 'number' ? node.zIndex : null,
    data,
  };
}

export function deserializeStudioNode(input: PersistedStudioNode): StudioNode {
  const def = getNodeDef(input.nodeType);
  const persistedVersion = Number(input.nodeSchemaVersion || input.data?.schemaVersion || 1);
  const currentVersion = def?.version ?? persistedVersion;
  const unsupportedFuture = persistedVersion > currentVersion;
  const data: StudioNodeData = {
    ...(def?.defaultData ?? {}),
    ...durableStudioNodeData(input.data),
    schemaVersion: persistedVersion,
  } as StudioNodeData;
  if (unsupportedFuture) {
    data.status = 'INVALID';
    data.validation = {
      valid: false,
      errors: [{ code: 'UNSUPPORTED_NODE_SCHEMA_VERSION', message: `Node schema ${persistedVersion} is newer than this Studio client supports` }],
      warnings: [],
    };
  }
  return {
    id: input.nodeId,
    type: 'studio',
    position: { x: Number(input.position?.x) || 0, y: Number(input.position?.y) || 0 },
    width: input.size?.width ?? def?.width,
    height: input.size?.height ?? undefined,
    zIndex: input.zIndex ?? undefined,
    data,
  } as StudioNode;
}

export function serializeStudioEdge(edge: StudioEdge): PersistedStudioEdge {
  return {
    edgeId: edge.id,
    sourceNodeId: edge.source,
    sourceHandle: edge.sourceHandle ?? null,
    targetNodeId: edge.target,
    targetHandle: edge.targetHandle ?? null,
    edgeType: edge.type ?? null,
    data: stripForbidden(edge.data as unknown as Record<string, unknown>) as StudioEdgeData,
  };
}

export function deserializeStudioEdge(input: PersistedStudioEdge): StudioEdge {
  return {
    id: input.edgeId,
    source: input.sourceNodeId,
    sourceHandle: input.sourceHandle ?? undefined,
    target: input.targetNodeId,
    targetHandle: input.targetHandle ?? undefined,
    type: input.edgeType ?? 'smoothstep',
    data: (stripForbidden(input.data as unknown as Record<string, unknown>) as StudioEdgeData) || { portType: 'TEXT' },
  } as StudioEdge;
}

export class DirtyOperationBuffer {
  private nodes = new Map<string, PersistedStudioNode>();
  private deletedNodes = new Set<string>();
  private edges = new Map<string, PersistedStudioEdge>();
  private deletedEdges = new Set<string>();
  private viewportValue: Viewport | null = null;

  upsertNode(node: StudioNode) {
    this.deletedNodes.delete(node.id);
    this.nodes.set(node.id, serializeStudioNode(node));
  }
  deleteNode(nodeId: string) {
    this.nodes.delete(nodeId);
    this.deletedNodes.add(nodeId);
  }
  upsertEdge(edge: StudioEdge) {
    this.deletedEdges.delete(edge.id);
    this.edges.set(edge.id, serializeStudioEdge(edge));
  }
  deleteEdge(edgeId: string) {
    this.edges.delete(edgeId);
    this.deletedEdges.add(edgeId);
  }
  viewport(viewport: Viewport) { this.viewportValue = viewport; }
  isEmpty() { return !this.nodes.size && !this.deletedNodes.size && !this.edges.size && !this.deletedEdges.size && !this.viewportValue; }
  flush(base: { baseRevision: number; clientMutationId: string }): CanvasPatchRequest {
    const out: CanvasPatchRequest = { baseRevision: base.baseRevision, clientMutationId: base.clientMutationId };
    if (this.nodes.size) out.upsertNodes = Array.from(this.nodes.values());
    if (this.deletedNodes.size) out.deleteNodeIds = Array.from(this.deletedNodes.values());
    if (this.edges.size) out.upsertEdges = Array.from(this.edges.values());
    if (this.deletedEdges.size) out.deleteEdgeIds = Array.from(this.deletedEdges.values());
    if (this.viewportValue) out.viewport = this.viewportValue;
    this.nodes.clear(); this.deletedNodes.clear(); this.edges.clear(); this.deletedEdges.clear(); this.viewportValue = null;
    return out;
  }
}
