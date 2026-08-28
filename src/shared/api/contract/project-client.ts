// ── Typed V2 Project / Workspace client (M01-S) ────────────────────────────
// Contract-first client against moling-v2.yaml. Uses the shared ApiClient
// (cookie session + bearer discovery) and Zod runtime validation at the boundary.

import type * as contract from './generated';
import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';
import {
  WorkspaceListResponseSchema,
  ProjectListResponseSchema,
  ProjectDetailSchema,
  CreateProjectRequestSchema,
  UpdateProjectRequestSchema,
  parseSafe,
  type WorkspaceListResponse,
  type ProjectListResponse,
  type ProjectDetail,
  type CreateProjectRequest,
  type UpdateProjectRequest,
} from './schemas';

type Schemas = contract.components['schemas'];

type ListQuery = {
  workspace?: string;
  status?: 'draft' | 'active' | 'archived' | '';
  projectType?: 'general' | 'studio' | 'short_drama' | '';
  search?: string;
  limit?: number;
  offset?: number;
};

export class ProjectApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'ProjectApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown };
    if (err && typeof err.status === 'number') {
      throw new ProjectApiError(err.status, err.message ?? op, (err as { body?: unknown }).body ?? err);
    }
    telemetry.warn(`v2project.${op}`, (e as Error).message);
    throw e;
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const v2project = {
  /** GET /api/v2/workspaces */
  async listWorkspaces(): Promise<WorkspaceListResponse> {
    const raw = await call(
      () => api.get<Schemas['WorkspaceListResponse']>('/api/v2/workspaces'),
      'listWorkspaces',
    );
    return parseSafe(WorkspaceListResponseSchema, raw, (err) =>
      telemetry.warn('v2project.listWorkspaces.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as WorkspaceListResponse;
  },

  /** GET /api/v2/projects */
  async listProjects(query: ListQuery = {}): Promise<ProjectListResponse> {
    const raw = await call(
      () => api.get<Schemas['ProjectListResponse']>(`/api/v2/projects${qs(query)}`),
      'listProjects',
    );
    return parseSafe(ProjectListResponseSchema, raw, (err) =>
      telemetry.warn('v2project.listProjects.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as ProjectListResponse;
  },

  /** POST /api/v2/projects */
  async createProject(body: CreateProjectRequest): Promise<ProjectDetail> {
    const parsed = CreateProjectRequestSchema.parse(body);
    const raw = await call(
      () => api.post<Schemas['ProjectDetail']>('/api/v2/projects', parsed),
      'createProject',
    );
    return parseSafe(ProjectDetailSchema, raw, (err) =>
      telemetry.warn('v2project.createProject.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as ProjectDetail;
  },

  /** GET /api/v2/projects/:id */
  async getProject(projectId: string): Promise<ProjectDetail> {
    const raw = await call(
      () => api.get<Schemas['ProjectDetail']>(`/api/v2/projects/${encodeURIComponent(projectId)}`),
      'getProject',
    );
    return parseSafe(ProjectDetailSchema, raw, (err) =>
      telemetry.warn('v2project.getProject.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as ProjectDetail;
  },

  /** PATCH /api/v2/projects/:id */
  async updateProject(projectId: string, body: UpdateProjectRequest): Promise<ProjectDetail> {
    const parsed = UpdateProjectRequestSchema.parse(body);
    const raw = await call(
      () => api.patch<Schemas['ProjectDetail']>(`/api/v2/projects/${encodeURIComponent(projectId)}`, parsed),
      'updateProject',
    );
    return parseSafe(ProjectDetailSchema, raw, (err) =>
      telemetry.warn('v2project.updateProject.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as ProjectDetail;
  },

  /** POST /api/v2/projects/:id/archive */
  async archiveProject(projectId: string): Promise<ProjectDetail> {
    const raw = await call(
      () => api.post<Schemas['ProjectDetail']>(`/api/v2/projects/${encodeURIComponent(projectId)}/archive`),
      'archiveProject',
    );
    return parseSafe(ProjectDetailSchema, raw, (err) =>
      telemetry.warn('v2project.archiveProject.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as ProjectDetail;
  },

  /** POST /api/v2/projects/:id/restore */
  async restoreProject(projectId: string): Promise<ProjectDetail> {
    const raw = await call(
      () => api.post<Schemas['ProjectDetail']>(`/api/v2/projects/${encodeURIComponent(projectId)}/restore`),
      'restoreProject',
    );
    return parseSafe(ProjectDetailSchema, raw, (err) =>
      telemetry.warn('v2project.restoreProject.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as ProjectDetail;
  },
};
