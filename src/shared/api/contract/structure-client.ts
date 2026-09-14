import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

export class StudioStructureApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'StudioStructureApiError';
    this.status = status;
    this.body = body;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try { return await fn(); }
  catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown };
    if (typeof err.status === 'number') throw new StudioStructureApiError(err.status, err.message || op, err.body);
    telemetry.warn(`v2studio.structure.${op}`, (e as Error).message);
    throw e;
  }
}

function projectPath(projectId: string, suffix = '') {
  return `/api/v2/projects/${encodeURIComponent(projectId)}${suffix}`;
}

/**
 * Node types by project mode (W1-12 type sets, mirrored from structureNode.cjs).
 * narrative: story → act → sequence → scene → shot
 * advertising: brief → concept/sequence → scene → shot
 * ecommerce: product → selling_point → segment → scene → shot
 */
export type StructureNodeType =
  | 'story' | 'act' | 'sequence' | 'scene' | 'shot'
  | 'brief' | 'concept'
  | 'product' | 'selling_point' | 'segment';

export interface StructureNode {
  id: string;
  projectId: string;
  parentId: string | null;
  type: StructureNodeType;
  orderIndex: number;
  shotId: string | null;
  label: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string | null;
}

export interface StructureListResponse {
  ok: boolean;
  nodes: StructureNode[];
}

export interface StructureNodeResponse {
  ok: boolean;
  node: StructureNode;
}

export interface StructureDeleteResponse {
  ok: boolean;
  deleted: StructureNode;
}

export interface StructureCreateBody {
  parentId?: string | null;
  type: StructureNodeType;
  orderIndex?: number;
  label?: string;
  shotId?: string | null;
  meta?: Record<string, unknown>;
}

export interface StructureUpdateBody {
  label?: string;
  meta?: Record<string, unknown>;
  orderIndex?: number;
  shotId?: string | null;
}

export interface StructureMoveBody {
  parentId?: string | null;
  orderIndex?: number;
}

export const v2studioStructure = {
  /** GET /api/v2/projects/:id/structure — ordered flat tree (parent_id NULLS FIRST, order_index). */
  async list(projectId: string): Promise<StructureListResponse> {
    const raw = await call(() => api.get<unknown>(projectPath(projectId, '/structure')), 'listStructure');
    return raw as StructureListResponse;
  },

  /** POST /api/v2/projects/:id/structure — create a node (mode type-set + parent-child adjacency validated). */
  async create(projectId: string, body: StructureCreateBody): Promise<StructureNodeResponse> {
    const raw = await call(() => api.post<unknown>(projectPath(projectId, '/structure'), body), 'createStructureNode');
    return raw as StructureNodeResponse;
  },

  /** PUT /api/v2/projects/:id/structure/:nodeId — update label/meta/orderIndex/shotId (whole-tree validated). */
  async update(projectId: string, nodeId: string, body: StructureUpdateBody): Promise<StructureNodeResponse> {
    const raw = await call(() => api.patch<unknown>(projectPath(projectId, `/structure/${encodeURIComponent(nodeId)}`), body), 'updateStructureNode');
    return raw as StructureNodeResponse;
  },

  /** POST /api/v2/projects/:id/structure/:nodeId/move — reorder (parent + order_index); shot leaves cannot move / be parents. */
  async move(projectId: string, nodeId: string, body: StructureMoveBody): Promise<StructureNodeResponse> {
    const raw = await call(() => api.post<unknown>(projectPath(projectId, `/structure/${encodeURIComponent(nodeId)}/move`), body), 'moveStructureNode');
    return raw as StructureNodeResponse;
  },

  /** DELETE /api/v2/projects/:id/structure/:nodeId — guarded delete (HAS_CHILDREN / SHOT_LOCKED). */
  async remove(projectId: string, nodeId: string): Promise<StructureDeleteResponse> {
    const raw = await call(() => api.delete<unknown>(projectPath(projectId, `/structure/${encodeURIComponent(nodeId)}`)), 'deleteStructureNode');
    return raw as StructureDeleteResponse;
  },
};
