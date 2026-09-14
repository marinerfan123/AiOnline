// ── W2-13 — Project Environment API contract ────────────────────────────────
// Contract-first typed client for the project-scoped Environment domain (W2-02).
// Mirrors server/modules/project-foundation/environment.cjs + db/migrations/0028_environments.sql
// (project_environments). Master reference, geometry, props, lighting, time-of-day, palette
// and generated views persist under workspace/project scope.
//
//   GET    /api/v2/projects/:id/environments          → list (project-scoped)
//   POST   /api/v2/projects/:id/environments          → create
//   GET    /api/v2/projects/:id/environments/:envId   → read one
//   PUT    /api/v2/projects/:id/environments/:envId   → update
//   DELETE /api/v2/projects/:id/environments/:envId   → remove
//
// This file is a frontend contract only — it does not touch the backend.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

/** project_environments row (snake_case mirrors the backend module / migration). */
export interface ProjectEnvironment {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  master_reference_id: string | null;
  geometry: Record<string, unknown>;
  props: Record<string, unknown>;
  lighting: Record<string, unknown>;
  time_of_day: string | null;
  palette: Record<string, unknown>;
  generated_views: Record<string, unknown>[] | string[];
  created_at: string;
  updated_at: string;
}

/** GET /api/v2/projects/:id/environments — 200 */
export interface EnvironmentListResponse {
  ok: true;
  environments: ProjectEnvironment[];
}

/** GET|POST|PUT /api/v2/projects/:id/environments(/ :envId) — 200 */
export interface EnvironmentResponse {
  ok: true;
  environment: ProjectEnvironment;
}

/** DELETE /api/v2/projects/:id/environments/:envId — 200 */
export interface EnvironmentDeleteResponse {
  ok: true;
  environment: ProjectEnvironment;
}

/** POST body — create an environment (name required; workspace_id/project_id inferred server-side). */
export interface EnvironmentCreateBody {
  name: string;
  master_reference_id?: string;
  geometry?: Record<string, unknown>;
  props?: Record<string, unknown>;
  lighting?: Record<string, unknown>;
  time_of_day?: string;
  palette?: Record<string, unknown>;
  generated_views?: Record<string, unknown>[] | string[];
}

/** PUT body — partial environment update. */
export interface EnvironmentUpdateBody {
  name?: string;
  master_reference_id?: string | null;
  geometry?: Record<string, unknown>;
  props?: Record<string, unknown>;
  lighting?: Record<string, unknown>;
  time_of_day?: string | null;
  palette?: Record<string, unknown>;
  generated_views?: Record<string, unknown>[] | string[];
}

export class EnvironmentApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'EnvironmentApiError';
    this.status = status;
    this.body = body;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown };
    if (typeof err.status === 'number') {
      throw new EnvironmentApiError(err.status, err.message ?? op, err.body);
    }
    telemetry.warn(`v2project.environment.${op}`, (e as Error).message);
    throw e;
  }
}

function projectPath(projectId: string, suffix = '') {
  return `/api/v2/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export const v2projectEnvironment = {
  /** GET /api/v2/projects/:id/environments — list project environments. */
  list(projectId: string): Promise<EnvironmentListResponse> {
    return call(() => api.get<EnvironmentListResponse>(projectPath(projectId, '/environments')), 'list');
  },

  /** POST /api/v2/projects/:id/environments — create an environment. */
  create(projectId: string, body: EnvironmentCreateBody): Promise<EnvironmentResponse> {
    return call(() => api.post<EnvironmentResponse>(projectPath(projectId, '/environments'), body), 'create');
  },

  /** GET /api/v2/projects/:id/environments/:envId — read one environment. */
  get(projectId: string, envId: string): Promise<EnvironmentResponse> {
    return call(
      () => api.get<EnvironmentResponse>(projectPath(projectId, `/environments/${encodeURIComponent(envId)}`)),
      'get',
    );
  },

  /** PUT /api/v2/projects/:id/environments/:envId — update an environment. */
  update(projectId: string, envId: string, body: EnvironmentUpdateBody): Promise<EnvironmentResponse> {
    return call(
      () => api.put<EnvironmentResponse>(projectPath(projectId, `/environments/${encodeURIComponent(envId)}`), body),
      'update',
    );
  },

  /** DELETE /api/v2/projects/:id/environments/:envId — remove an environment. */
  remove(projectId: string, envId: string): Promise<EnvironmentDeleteResponse> {
    return call(
      () => api.delete<EnvironmentDeleteResponse>(projectPath(projectId, `/environments/${encodeURIComponent(envId)}`)),
      'remove',
    );
  },
};
