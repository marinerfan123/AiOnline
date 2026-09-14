// ── W2-13 — Project Reference API contract ───────────────────────────────────
// Contract-first typed client for the project-scoped Reference domain (W2-03).
// Mirrors server/modules/project-foundation/reference.cjs + db/migrations/0026_references.sql
// (project_references). Reference types: character / environment / product / object /
// style / camera / composition / motion / brand / audio. Project-scoped, with optional
// role / source / source_id and a free-form attributes JSON object.
//
//   GET    /api/v2/projects/:id/references          → list (project-scoped)
//   POST   /api/v2/projects/:id/references          → create
//   GET    /api/v2/projects/:id/references/:refId   → read one
//   PUT    /api/v2/projects/:id/references/:refId   → update
//   DELETE /api/v2/projects/:id/references/:refId   → remove
//
// This file is a frontend contract only — it does not touch the backend.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

/** W2-03 reference type matrix (mirrors REFERENCE_TYPES in reference.cjs). */
export type ReferenceType =
  | 'character' | 'environment' | 'product' | 'object' | 'style'
  | 'camera' | 'composition' | 'motion' | 'brand' | 'audio';

/** project_references row (snake_case mirrors the backend module / migration). */
export interface ProjectReference {
  id: string;
  project_id: string;
  type: ReferenceType;
  name: string;
  role: string | null;
  source: string | null;
  source_id: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** GET /api/v2/projects/:id/references — 200 */
export interface ReferenceListResponse {
  ok: true;
  references: ProjectReference[];
}

/** GET|POST|PUT /api/v2/projects/:id/references(/ :refId) — 200 */
export interface ReferenceResponse {
  ok: true;
  reference: ProjectReference;
}

/** DELETE /api/v2/projects/:id/references/:refId — 200 */
export interface ReferenceDeleteResponse {
  ok: true;
  reference: ProjectReference;
}

/** POST body — create a reference (type + name required; rest optional). */
export interface ReferenceCreateBody {
  type: ReferenceType;
  name: string;
  role?: string;
  source?: string;
  source_id?: string;
  attributes?: Record<string, unknown>;
}

/** PUT body — partial reference update (name / role / source / source_id / attributes). */
export interface ReferenceUpdateBody {
  name?: string;
  role?: string | null;
  source?: string | null;
  source_id?: string | null;
  attributes?: Record<string, unknown>;
}

export class ReferenceApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ReferenceApiError';
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
      throw new ReferenceApiError(err.status, err.message ?? op, err.body);
    }
    telemetry.warn(`v2project.reference.${op}`, (e as Error).message);
    throw e;
  }
}

function projectPath(projectId: string, suffix = '') {
  return `/api/v2/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export const v2projectReference = {
  /** GET /api/v2/projects/:id/references — list project references (optionally by type). */
  list(projectId: string, type?: ReferenceType): Promise<ReferenceListResponse> {
    const suffix = type ? `/references?type=${encodeURIComponent(type)}` : '/references';
    return call(() => api.get<ReferenceListResponse>(projectPath(projectId, suffix)), 'list');
  },

  /** POST /api/v2/projects/:id/references — create a reference. */
  create(projectId: string, body: ReferenceCreateBody): Promise<ReferenceResponse> {
    return call(() => api.post<ReferenceResponse>(projectPath(projectId, '/references'), body), 'create');
  },

  /** GET /api/v2/projects/:id/references/:refId — read one reference. */
  get(projectId: string, refId: string): Promise<ReferenceResponse> {
    return call(
      () => api.get<ReferenceResponse>(projectPath(projectId, `/references/${encodeURIComponent(refId)}`)),
      'get',
    );
  },

  /** PUT /api/v2/projects/:id/references/:refId — update a reference. */
  update(projectId: string, refId: string, body: ReferenceUpdateBody): Promise<ReferenceResponse> {
    return call(
      () => api.put<ReferenceResponse>(projectPath(projectId, `/references/${encodeURIComponent(refId)}`), body),
      'update',
    );
  },

  /** DELETE /api/v2/projects/:id/references/:refId — remove a reference. */
  remove(projectId: string, refId: string): Promise<ReferenceDeleteResponse> {
    return call(
      () => api.delete<ReferenceDeleteResponse>(projectPath(projectId, `/references/${encodeURIComponent(refId)}`)),
      'remove',
    );
  },
};
